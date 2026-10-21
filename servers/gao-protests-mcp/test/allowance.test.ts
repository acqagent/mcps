import { describe, expect, it } from "vitest";
import { allowanceLimits, periods, takeToolCall } from "../src/allowance";
import worker from "../src/index";
import { callTool, fakeUsage, makeEnv, rpc } from "./helpers";

function limitedEnv(daily?: string, monthly?: string) {
  const made = makeEnv();
  const usage = fakeUsage();
  made.env.USAGE = usage.ns;
  if (daily) made.env.DAILY_TOOL_CALLS = daily;
  if (monthly) made.env.MONTHLY_TOOL_CALLS = monthly;
  return { ...made, usage };
}

const NOON = Date.UTC(2026, 9, 19, 12);
const DAY = 24 * 60 * 60 * 1000;

describe("allowance settings", () => {
  it("needs the counter and at least one positive limit", () => {
    expect(allowanceLimits(limitedEnv().env)).toBeNull();
    expect(allowanceLimits(limitedEnv("0", "abc").env)).toBeNull();
    expect(allowanceLimits(limitedEnv("20000").env)).toEqual({ day: 20000, month: null });
    expect(allowanceLimits(limitedEnv("20000", "300000").env)).toEqual({ day: 20000, month: 300000 });
    const { env } = makeEnv();
    env.DAILY_TOOL_CALLS = "5";
    expect(allowanceLimits(env)).toBeNull();
  });

  it("names UTC days and months", () => {
    expect(periods(Date.UTC(2026, 9, 31, 23, 59))).toEqual({ day: "2026-10-31", month: "2026-10" });
    expect(periods(Date.UTC(2026, 10, 1))).toEqual({ day: "2026-11-01", month: "2026-11" });
  });
});

describe("allowance on tool calls", () => {
  it("stops tool calls past the daily allowance without doing the work", async () => {
    const { env, bucket, usage } = limitedEnv("2", "100");
    expect((await callTool(env, "get_decision", { b_number: "B-900101" })).isError).toBe(false);
    expect((await callTool(env, "corpus_info")).isError).toBe(false);
    const reads = bucket.gets.length;
    const third = await callTool(env, "get_decision", { b_number: "B-900102" });
    expect(third.isError).toBe(true);
    expect(third.data.error).toMatch(/daily allowance .* resets at midnight UTC/);
    expect(bucket.gets.length).toBe(reads);
    expect(usage.storage.data.get(`day:${periods(Date.now()).day}`)).toBe(2);
    // The isolate remembers, so later calls don't ask the counter again.
    await callTool(env, "corpus_info");
    expect(usage.calls.take).toBe(3);
  });

  it("counts only valid tool calls", async () => {
    const { env, usage } = limitedEnv("100");
    await rpc(env, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    await rpc(env, "tools/list");
    const invalid = await callTool(env, "find_similar_decisions", { b_number: "B-900101", limit: 500 });
    expect(invalid.isError).toBe(true);
    const tooLong = await callTool(env, "search_decisions", { query: "x".repeat(501) });
    expect(tooLong.isError).toBe(true);
    expect(usage.calls.take).toBe(0);
  });

  it("resets the next UTC day", async () => {
    const { env } = limitedEnv("1", "100");
    expect(await takeToolCall(env, NOON)).toBeNull();
    expect(await takeToolCall(env, NOON + 60_000)).toMatch(/daily/);
    expect(await takeToolCall(env, NOON + DAY)).toBeNull();
  });

  it("stops for the rest of the month past the monthly allowance", async () => {
    const { env, usage } = limitedEnv("100", "2");
    expect(await takeToolCall(env, NOON)).toBeNull();
    expect(await takeToolCall(env, NOON + DAY)).toBeNull();
    expect(await takeToolCall(env, NOON + 2 * DAY)).toMatch(/monthly allowance .* 1st of next month/);
    expect(await takeToolCall(env, NOON + 5 * DAY)).toMatch(/monthly/);
    expect(usage.calls.take).toBe(3);
    expect(await takeToolCall(env, Date.UTC(2026, 10, 1, 0, 1))).toBeNull();
  });

  it("lets calls through if the counter fails", async () => {
    const { env } = makeEnv();
    env.DAILY_TOOL_CALLS = "1";
    env.USAGE = {
      idFromName: () => "global",
      get: () => ({
        take: async () => {
          throw new Error("counter down");
        },
      }),
    } as unknown as typeof env.USAGE;
    expect(await takeToolCall(env)).toBeNull();
    expect((await callTool(env, "corpus_info")).isError).toBe(false);
  });

  it("shows usage on /health", async () => {
    const { env } = limitedEnv("20000", "300000");
    await callTool(env, "corpus_info");
    await callTool(env, "corpus_info");
    const health: any = await (await worker.fetch(new Request("https://gao.example/health"), env)).json();
    expect(health.tool_calls).toEqual({ today: { used: 2, limit: 20000 }, this_month: { used: 2, limit: 300000 } });
    expect((await (await worker.fetch(new Request("https://gao.example/health"), makeEnv().env)).json()) as any).toMatchObject({
      tool_calls: null,
    });
  });
});
