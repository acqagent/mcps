// Shared allowance of tool calls per UTC day and month, counted by one Durable Object for everyone.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

export interface AllowanceLimits {
  day: number | null;
  month: number | null;
}

export interface Usage {
  day: number;
  month: number;
}

export type TakeResult = Usage & { ok: boolean; period?: "day" | "month" };

const USAGE_CACHE_MS = 60_000;

/** Counts tool calls. Storage keys are "day:2026-10-19" and "month:2026-10". */
export class UsageCounter extends DurableObject<Env> {
  /** Counts one call, unless the day or the month is already used up. */
  async take(day: string, month: string, limits: AllowanceLimits): Promise<TakeResult> {
    const used = await this.read(day, month);
    if (limits.month !== null && used.month >= limits.month) return { ok: false, period: "month", ...used };
    if (limits.day !== null && used.day >= limits.day) return { ok: false, period: "day", ...used };
    const next = { day: used.day + 1, month: used.month + 1 };
    await this.ctx.storage.put({ [`day:${day}`]: next.day, [`month:${month}`]: next.month });
    return { ok: true, ...next };
  }

  async read(day: string, month: string): Promise<Usage> {
    const counts = await this.ctx.storage.get<number>([`day:${day}`, `month:${month}`]);
    return { day: counts.get(`day:${day}`) ?? 0, month: counts.get(`month:${month}`) ?? 0 };
  }
}

function positiveInt(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** DAILY_TOOL_CALLS and MONTHLY_TOOL_CALLS. Null when neither is set, or there is no counter to use. */
export function allowanceLimits(env: Env): AllowanceLimits | null {
  const limits = { day: positiveInt(env.DAILY_TOOL_CALLS), month: positiveInt(env.MONTHLY_TOOL_CALLS) };
  if (!env.USAGE || (limits.day === null && limits.month === null)) return null;
  return limits;
}

/** The UTC day and month a moment falls in, as "2026-10-19" and "2026-10". */
export function periods(now: number): { day: string; month: string } {
  const iso = new Date(now).toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

function nextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function nextUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const MESSAGES = {
  day: "This server's shared daily allowance of tool calls is used up. It resets at midnight UTC; try again then.",
  month:
    "This server's shared monthly allowance of tool calls is used up. It resets on the 1st of next month (UTC); try again then.",
};

// Once the allowance is used up, this isolate answers without asking the counter until the period ends.
let blocked: { until: number; message: string } | null = null;
let usageCache: { at: number; usage: Usage } | null = null;

export function clearAllowanceCache(): void {
  blocked = null;
  usageCache = null;
}

function counter(env: Env) {
  const ns = env.USAGE!;
  return ns.get(ns.idFromName("global"));
}

/**
 * Counts one tool call. Returns the message to send instead of running the tool once the allowance
 * is used up, or null to run it. If the counter fails, the call goes through.
 */
export async function takeToolCall(env: Env, now = Date.now()): Promise<string | null> {
  const limits = allowanceLimits(env);
  if (!limits) return null;
  if (blocked && now < blocked.until) return blocked.message;
  try {
    const { day, month } = periods(now);
    const result = await counter(env).take(day, month, limits);
    usageCache = { at: now, usage: { day: result.day, month: result.month } };
    if (result.ok) return null;
    const period = result.period ?? "day";
    blocked = { until: period === "month" ? nextUtcMonth(now) : nextUtcDay(now), message: MESSAGES[period] };
    console.warn(`allowance used up for the ${period}`, result);
    return blocked.message;
  } catch (err) {
    console.error("allowance counter failed", err);
    return null;
  }
}

/** Tool calls used and allowed today and this month, for /health. Reads the counter at most once a minute. */
export async function allowanceStatus(env: Env, now = Date.now()) {
  const limits = allowanceLimits(env);
  if (!limits) return null;
  if (!usageCache || now - usageCache.at > USAGE_CACHE_MS) {
    const { day, month } = periods(now);
    usageCache = { at: now, usage: await counter(env).read(day, month) };
  }
  const { usage } = usageCache;
  return {
    today: { used: usage.day, limit: limits.day },
    this_month: { used: usage.month, limit: limits.month },
  };
}
