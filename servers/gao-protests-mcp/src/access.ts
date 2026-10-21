// IP allowlist for /mcp: ChatGPT's and Claude's published outbound ranges.

import builtInOpenAiRanges from "./chatgpt-connectors.json";
import type { Env } from "./types";

/** Anthropic's outbound range for Claude's MCP connectors (claude.ai, Desktop, mobile, the API). */
export const ANTHROPIC_RANGES = ["160.79.104.0/21"];
/** OpenAI's ranges for ChatGPT apps and connectors, which changes from time to time. */
export const OPENAI_RANGES_URL = "https://openai.com/chatgpt-connectors.json";
/** Where the scheduled refresh keeps the last good copy of OpenAI's file, in the data bucket. */
export const OPENAI_RANGES_KEY = "access/chatgpt-connectors.json";

/** A download with fewer usable prefixes than this is treated as broken and not saved. */
const MIN_PREFIXES = 20;
const RELOAD_MS = 60 * 60 * 1000;

interface IpNumber {
  v6: boolean;
  n: bigint;
}

interface Cidr {
  v6: boolean;
  net: bigint;
  bits: number;
}

export function parseIp(ip: string): IpNumber | null {
  if (ip.includes(":")) {
    const halves = ip.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    let n = 0n;
    for (const group of [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right]) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      n = (n << 16n) | BigInt(parseInt(group, 16));
    }
    return { v6: true, n };
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = (n << 8n) | BigInt(part);
  }
  return { v6: false, n };
}

export function parseCidr(cidr: string): Cidr | null {
  const [address, length, extra] = cidr.split("/");
  const ip = parseIp(address);
  if (!ip || extra !== undefined) return null;
  const width = ip.v6 ? 128 : 32;
  const bits = length === undefined ? width : Number(length);
  if (!/^\d+$/.test(length ?? "0") || bits > width) return null;
  return { v6: ip.v6, net: ip.n >> BigInt(width - bits), bits };
}

export function inRanges(ip: string | null, ranges: Cidr[]): boolean {
  const address = ip ? parseIp(ip) : null;
  if (!address) return false;
  const width = address.v6 ? 128 : 32;
  return ranges.some((r) => r.v6 === address.v6 && address.n >> BigInt(width - r.bits) === r.net);
}

/** The usable prefixes in OpenAI's file: {"prefixes": [{"ipv4Prefix": "..."}, {"ipv6Prefix": "..."}]}. */
export function openAiPrefixes(data: unknown): string[] {
  const prefixes = (data as { prefixes?: unknown } | null)?.prefixes;
  if (!Array.isArray(prefixes)) return [];
  return prefixes
    .map((p) => p?.ipv4Prefix ?? p?.ipv6Prefix)
    .filter((p): p is string => typeof p === "string" && parseCidr(p) !== null);
}

interface StoredRanges {
  fetched_at: string;
  data: { creationTime?: string; prefixes: unknown[] };
}

interface RangeSet {
  ranges: Cidr[];
  openai_prefixes: number;
  source: "refreshed" | "built-in";
  fetched_at: string | null;
  published_at: string | null;
  loadedAt: number;
}

let loaded: RangeSet | null = null;

export function clearAccessCache(): void {
  loaded = null;
}

/** The ranges to allow: the refreshed copy of OpenAI's file if there is a good one, else the built-in copy. */
async function rangeSet(env: Env, now: number): Promise<RangeSet> {
  if (loaded && now - loaded.loadedAt < RELOAD_MS) return loaded;
  let stored: StoredRanges | null = null;
  try {
    stored = (await (await env.GAO_DATA.get(OPENAI_RANGES_KEY))?.json<StoredRanges>()) ?? null;
  } catch (err) {
    console.error("could not read the saved OpenAI ranges; using the built-in copy", err);
  }
  const refreshed = stored ? openAiPrefixes(stored.data) : [];
  const useRefreshed = refreshed.length >= MIN_PREFIXES;
  const openai = useRefreshed ? refreshed : openAiPrefixes(builtInOpenAiRanges);
  loaded = {
    ranges: [...openai, ...ANTHROPIC_RANGES].map((p) => parseCidr(p)!),
    openai_prefixes: openai.length,
    source: useRefreshed ? "refreshed" : "built-in",
    fetched_at: useRefreshed ? stored!.fetched_at : null,
    published_at: (useRefreshed ? stored!.data.creationTime : builtInOpenAiRanges.creationTime) ?? null,
    loadedAt: now,
  };
  return loaded;
}

export async function fromAllowedNetwork(ip: string | null, env: Env, now = Date.now()): Promise<boolean> {
  return inRanges(ip, (await rangeSet(env, now)).ranges);
}

/** Downloads OpenAI's current ranges and saves them if they look right. Returns the number of prefixes. */
export async function refreshOpenAiRanges(env: Env, now = Date.now()): Promise<number> {
  const res = await fetch(OPENAI_RANGES_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${OPENAI_RANGES_URL} returned HTTP ${res.status}`);
  const data = (await res.json()) as StoredRanges["data"];
  const count = openAiPrefixes(data).length;
  if (count < MIN_PREFIXES) throw new Error(`${OPENAI_RANGES_URL} had only ${count} usable prefixes; keeping the saved copy`);
  const stored: StoredRanges = { fetched_at: new Date(now).toISOString(), data };
  await env.GAO_DATA.put(OPENAI_RANGES_KEY, JSON.stringify(stored), { httpMetadata: { contentType: "application/json" } });
  loaded = null;
  return count;
}

/** What /health reports about the allowlist. */
export async function accessStatus(env: Env, now = Date.now()) {
  const set = await rangeSet(env, now);
  return {
    allowlist: env.ALLOWLIST === "on" ? "on" : "off",
    openai_prefixes: set.openai_prefixes,
    anthropic_prefixes: ANTHROPIC_RANGES.length,
    openai_list: set.source,
    openai_list_fetched_at: set.fetched_at,
    openai_list_published_at: set.published_at,
  };
}
