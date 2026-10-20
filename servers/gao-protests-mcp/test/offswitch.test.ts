import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { checkOffSwitch, RULE_DESCRIPTION, STATE_KEY } from "../src/offswitch";
import { makeEnv } from "./helpers";

const ZONE = "https://api.cloudflare.com/client/v4/zones/zone123/rulesets";
const NOW = Date.UTC(2026, 10, 20, 15, 7);

interface Call {
  method: string;
  url: string;
  body: any;
}

/** Fakes the Cloudflare API: the GraphQL request count and the zone's custom rules entry point. */
function fakeApi(options: { requests?: number; entrypoint?: any; status?: Record<string, number> } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });
      const status = options.status?.[`${method} ${url}`];
      if (status) return Response.json({ success: false }, { status });
      if (url.endsWith("/graphql")) {
        return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: options.requests ?? 0 } }] }] } } });
      }
      if (url.endsWith("/entrypoint")) {
        return options.entrypoint ? Response.json({ result: options.entrypoint }) : Response.json({ success: false }, { status: 404 });
      }
      return Response.json({ success: true, result: {} });
    }),
  );
  return calls;
}

function armedEnv() {
  const made = makeEnv();
  Object.assign(made.env, {
    OFF_SWITCH_REQUESTS: "60000000",
    OFF_SWITCH_API_TOKEN: "cf-token",
    OFF_SWITCH_ACCOUNT_ID: "acct123",
    OFF_SWITCH_ZONE_ID: "zone123",
    OFF_SWITCH_HOST: "MCP.example.com",
  });
  return made;
}

const ruleset = (rules: object[]) => ({ id: "rs1", rules });
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/graphql"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("off switch", () => {
  it("is disarmed until every setting is there", async () => {
    const { env } = armedEnv();
    delete env.OFF_SWITCH_API_TOKEN;
    const calls = fakeApi();
    expect(await checkOffSwitch(env, NOW)).toBeNull();
    expect(calls).toEqual([]);
    const health: any = await (await worker.fetch(new Request("https://gao.example/health"), env)).json();
    expect(health.off_switch).toEqual({ armed: false });
  });

  it("counts this month's requests and records the check", async () => {
    const { env, bucket } = armedEnv();
    const calls = fakeApi({ requests: 1_234_567 });
    const state = await checkOffSwitch(env, NOW);
    expect(state).toEqual({ month: "2026-11", checked_at: "2026-11-20T15:07:00.000Z", requests: 1_234_567, limit: 60_000_000, tripped_at: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.variables).toEqual({
      account: "acct123",
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-11-20T15:07:00.000Z",
      script: "gao-protests-mcp",
    });
    expect(bucket.puts).toEqual([STATE_KEY]);
    const health: any = await (await worker.fetch(new Request("https://gao.example/health"), env)).json();
    expect(health.off_switch).toEqual({ armed: true, checked_at: "2026-11-20T15:07:00.000Z", tripped_at: null });
  });

  it("adds a block rule for the host once past the limit, then leaves it alone that month", async () => {
    const { env } = armedEnv();
    const other = { id: "r0", description: "something else", expression: "true", action: "managed_challenge", enabled: true };
    let calls = fakeApi({ requests: 60_000_001, entrypoint: ruleset([other]) });
    const state = await checkOffSwitch(env, NOW);
    expect(state?.tripped_at).toBe("2026-11-20T15:07:00.000Z");
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        url: `${ZONE}/rs1/rules`,
        body: {
          description: RULE_DESCRIPTION,
          expression: '(http.host eq "mcp.example.com")',
          action: "block",
          enabled: true,
          position: { index: 1 },
        },
      },
    ]);

    // Turned back on by hand later in the month: the switch doesn't block again until next month.
    calls = fakeApi({ requests: 70_000_000, entrypoint: ruleset([other]) });
    expect((await checkOffSwitch(env, NOW + 3_600_000))?.tripped_at).toBe("2026-11-20T15:07:00.000Z");
    expect(writes(calls)).toEqual([]);
    calls = fakeApi({ requests: 60_000_000, entrypoint: ruleset([other]) });
    expect((await checkOffSwitch(env, Date.UTC(2026, 11, 31, 23, 7)))?.tripped_at).toBe("2026-12-31T23:07:00.000Z");
    expect(writes(calls)).toHaveLength(1);
  });

  it("enables an existing rule as it is, or leaves an enabled one", async () => {
    const mine = { id: "r9", description: RULE_DESCRIPTION, expression: '(http.host eq "mcp.example.com")', action: "block", enabled: false };
    let calls = fakeApi({ requests: 61_000_000, entrypoint: ruleset([mine]) });
    await checkOffSwitch(armedEnv().env, NOW);
    expect(writes(calls)).toEqual([
      { method: "PATCH", url: `${ZONE}/rs1/rules/r9`, body: { description: RULE_DESCRIPTION, expression: mine.expression, action: "block", enabled: true } },
    ]);
    calls = fakeApi({ requests: 61_000_000, entrypoint: ruleset([{ ...mine, enabled: true }]) });
    expect((await checkOffSwitch(armedEnv().env, NOW))?.tripped_at).not.toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it("creates the zone's custom rules when it has none", async () => {
    const calls = fakeApi({ requests: 61_000_000 });
    await checkOffSwitch(armedEnv().env, NOW);
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        url: ZONE,
        body: {
          name: "default",
          kind: "zone",
          phase: "http_request_firewall_custom",
          rules: [{ description: RULE_DESCRIPTION, expression: '(http.host eq "mcp.example.com")', action: "block", enabled: true }],
        },
      },
    ]);
  });

  it("tries again next hour if blocking fails", async () => {
    const { env, bucket } = armedEnv();
    fakeApi({ requests: 61_000_000, entrypoint: ruleset([]), status: { [`POST ${ZONE}/rs1/rules`]: 403 } });
    await expect(checkOffSwitch(env, NOW)).rejects.toThrow(/HTTP 403/);
    expect(bucket.puts).toEqual([]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("openai.com") ? Response.json({}) : Response.json({}, { status: 401 }))));
    await worker.scheduled({} as ScheduledController, env);
    expect(errors).toHaveBeenCalledWith("off switch check failed", expect.any(Error));
    errors.mockRestore();
  });
});
