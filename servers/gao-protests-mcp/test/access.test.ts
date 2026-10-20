import { afterEach, describe, expect, it, vi } from "vitest";
import { inRanges, OPENAI_RANGES_KEY, openAiPrefixes, parseCidr, parseIp, refreshOpenAiRanges } from "../src/access";
import builtIn from "../src/chatgpt-connectors.json";
import worker from "../src/index";
import { makeEnv, rpc } from "./helpers";

const OPENAI_IP = "104.208.184.200"; // in 104.208.184.192/28 of the built-in list
const CLAUDE_IP = "160.79.110.9"; // in 160.79.104.0/21
const OUTSIDE_IP = "203.0.113.7";

/** A copy of OpenAI's file with these prefixes plus enough filler to pass the sanity check. */
function openAiFile(...prefixes: string[]) {
  const filler = Array.from({ length: 20 }, (_, i) => ({ ipv4Prefix: `10.${i}.0.0/16` }));
  return { creationTime: "2026-11-02T00:00:00", prefixes: [...prefixes.map((p) => ({ ipv4Prefix: p })), ...filler] };
}

function from(ip: string, headers: Record<string, string> = {}) {
  return { headers: { "CF-Connecting-IP": ip, ...headers } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IP ranges", () => {
  it("parses IPv4 and IPv6 addresses", () => {
    expect(parseIp("203.0.113.7")).toEqual({ v6: false, n: 3405803783n });
    expect(parseIp("::1")).toEqual({ v6: true, n: 1n });
    expect(parseIp("2001:db8::")?.n).toBe(0x20010db8n << 96n);
    for (const bad of ["", "1.2.3", "1.2.3.256", "1.2.3.4.5", "2001:db8::1::2", "1:2:3:4:5:6:7", "12345::", "::ffff:1.2.3.4"]) {
      expect(parseIp(bad)).toBeNull();
    }
  });

  it("matches addresses to CIDR ranges", () => {
    const ranges = ["160.79.104.0/21", "2001:db8:10::/48", "198.51.100.5"].map((r) => parseCidr(r)!);
    expect(inRanges("160.79.104.0", ranges)).toBe(true);
    expect(inRanges("160.79.111.255", ranges)).toBe(true);
    expect(inRanges("160.79.112.0", ranges)).toBe(false);
    expect(inRanges("2001:db8:10:ffff::1", ranges)).toBe(true);
    expect(inRanges("2001:db8:11::1", ranges)).toBe(false);
    expect(inRanges("198.51.100.5", ranges)).toBe(true);
    expect(inRanges("198.51.100.6", ranges)).toBe(false);
    expect(inRanges(null, ranges)).toBe(false);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/")).toBeNull();
  });

  it("reads OpenAI's file and skips entries it can't use", () => {
    expect(openAiPrefixes({ prefixes: [{ ipv4Prefix: "1.2.3.0/24" }, { ipv6Prefix: "2001:db8::/32" }, { x: 1 }, { ipv4Prefix: "bad" }] })).toEqual([
      "1.2.3.0/24",
      "2001:db8::/32",
    ]);
    expect(openAiPrefixes(null)).toEqual([]);
    expect(openAiPrefixes(builtIn).length).toBe(builtIn.prefixes.length);
  });
});

describe("allowlist", () => {
  it("is off by default: anyone, or token holders when a token is set", async () => {
    expect((await rpc(makeEnv().env, "tools/list", {}, from(OUTSIDE_IP))).status).toBe(200);
    expect((await rpc(makeEnv({ token: "s3cret-token" }).env, "tools/list", {}, from(OPENAI_IP))).status).toBe(401);
  });

  it("when on, accepts ChatGPT and Claude and refuses everyone else", async () => {
    const { env } = makeEnv();
    env.ALLOWLIST = "on";
    expect((await rpc(env, "tools/list", {}, from(OPENAI_IP))).status).toBe(200);
    expect((await rpc(env, "tools/list", {}, from(CLAUDE_IP))).status).toBe(200);
    const outside = await rpc(env, "tools/list", {}, from(OUTSIDE_IP));
    expect(outside.status).toBe(403);
    expect(outside.body.error.message).toMatch(/ChatGPT and Claude/);
    expect((await rpc(env, "tools/list")).status).toBe(403);
  });

  it("when on, lets token holders in from anywhere, and doesn't ask ChatGPT or Claude for it", async () => {
    const { env } = makeEnv({ token: "s3cret-token" });
    env.ALLOWLIST = "on";
    expect((await rpc(env, "tools/list", {}, from(OUTSIDE_IP, { Authorization: "Bearer s3cret-token" }))).status).toBe(200);
    expect((await rpc(env, "tools/list", {}, from(OUTSIDE_IP, { Authorization: "Bearer wrong" }))).status).toBe(403);
    expect((await rpc(env, "tools/list", {}, from(CLAUDE_IP))).status).toBe(200);
  });

  it("uses the refreshed copy of OpenAI's list over the built-in one", async () => {
    const { env } = makeEnv({
      overrides: { [OPENAI_RANGES_KEY]: JSON.stringify({ fetched_at: "2026-11-02T01:07:00Z", data: openAiFile("198.51.100.0/24") }) },
    });
    env.ALLOWLIST = "on";
    expect((await rpc(env, "tools/list", {}, from("198.51.100.9"))).status).toBe(200);
    expect((await rpc(env, "tools/list", {}, from(OPENAI_IP))).status).toBe(403);
    expect((await rpc(env, "tools/list", {}, from(CLAUDE_IP))).status).toBe(200);
    const health: any = await (await worker.fetch(new Request("https://gao.example/health"), env)).json();
    expect(health.access).toEqual({
      allowlist: "on",
      openai_prefixes: 21,
      anthropic_prefixes: 1,
      openai_list: "refreshed",
      openai_list_fetched_at: "2026-11-02T01:07:00Z",
      openai_list_published_at: "2026-11-02T00:00:00",
    });
  });

  it("falls back to the built-in list when the saved copy is broken", async () => {
    const { env } = makeEnv({ overrides: { [OPENAI_RANGES_KEY]: JSON.stringify({ fetched_at: "x", data: { prefixes: [] } }) } });
    env.ALLOWLIST = "on";
    expect((await rpc(env, "tools/list", {}, from(OPENAI_IP))).status).toBe(200);
    const health: any = await (await worker.fetch(new Request("https://gao.example/health"), env)).json();
    expect(health.access).toMatchObject({ allowlist: "on", openai_list: "built-in", openai_prefixes: builtIn.prefixes.length });
  });
});

describe("refreshing OpenAI's list", () => {
  function stubFetch(response: () => Response) {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("saves a good download and starts using it", async () => {
    const { env, bucket } = makeEnv();
    env.ALLOWLIST = "on";
    expect((await rpc(env, "tools/list", {}, from("198.51.100.9"))).status).toBe(403);
    const fetchMock = stubFetch(() => Response.json(openAiFile("198.51.100.0/24")));
    expect(await refreshOpenAiRanges(env, Date.UTC(2026, 10, 2, 1, 7))).toBe(21);
    expect(fetchMock).toHaveBeenCalledWith("https://openai.com/chatgpt-connectors.json", expect.anything());
    expect(bucket.puts).toEqual([OPENAI_RANGES_KEY]);
    expect((await rpc(env, "tools/list", {}, from("198.51.100.9"))).status).toBe(200);
  });

  it("keeps the saved copy when the download fails or looks wrong", async () => {
    const { env, bucket } = makeEnv();
    stubFetch(() => new Response("busy", { status: 503 }));
    await expect(refreshOpenAiRanges(env)).rejects.toThrow(/HTTP 503/);
    stubFetch(() => Response.json({ prefixes: [{ ipv4Prefix: "198.51.100.0/24" }] }));
    await expect(refreshOpenAiRanges(env)).rejects.toThrow(/only 1 usable/);
    expect(bucket.puts).toEqual([]);
  });

  it("runs from the hourly trigger without throwing", async () => {
    const { env, bucket } = makeEnv();
    stubFetch(() => Response.json(openAiFile()));
    await worker.scheduled({} as ScheduledController, env);
    expect(bucket.puts).toEqual([OPENAI_RANGES_KEY]);
    stubFetch(() => new Response("down", { status: 500 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.scheduled({} as ScheduledController, env);
    expect(errors).toHaveBeenCalledWith("refreshing OpenAI's IP ranges failed", expect.any(Error));
    errors.mockRestore();
  });
});
