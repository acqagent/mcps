// Off switch: once the Worker has served too many requests this month, block its host in the zone's
// WAF, so further requests stop before they reach (and are billed to) the Worker.

import type { Env } from "./types";

const API = "https://api.cloudflare.com/client/v4";
/** The Worker's name in wrangler.jsonc, which the request count is filtered by. */
export const WORKER_NAME = "gao-protests-mcp";
export const RULE_DESCRIPTION = "gao-protests-mcp off switch";
export const STATE_KEY = "state/off-switch.json";
const STATE_CACHE_MS = 60_000;

interface OffSwitchConfig {
  token: string;
  accountId: string;
  zoneId: string;
  host: string;
  limit: number;
}

export interface OffSwitchState {
  month: string;
  checked_at: string;
  requests: number;
  limit: number;
  /** When the switch blocked the host this month; it does not block again in the same month. */
  tripped_at: string | null;
}

interface Rule {
  id?: string;
  description?: string;
  expression: string;
  action: string;
  action_parameters?: unknown;
  enabled?: boolean;
}

export function offSwitchConfig(env: Env): OffSwitchConfig | null {
  const limit = Number(env.OFF_SWITCH_REQUESTS);
  const { OFF_SWITCH_API_TOKEN: token, OFF_SWITCH_ACCOUNT_ID: accountId, OFF_SWITCH_ZONE_ID: zoneId } = env;
  const host = env.OFF_SWITCH_HOST?.trim().toLowerCase();
  if (!token || !accountId || !zoneId || !host || !Number.isInteger(limit) || limit <= 0) return null;
  return { token, accountId, zoneId, host, limit };
}

async function api<T>(
  cfg: OffSwitchConfig,
  path: string,
  init: RequestInit = {},
  allow404 = false,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as T;
  if (!res.ok && !(allow404 && res.status === 404)) {
    throw new Error(`Cloudflare API ${init.method ?? "GET"} ${path} returned HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

/** Requests the Worker has served from the start of the UTC month until now, from the GraphQL Analytics API. */
export async function requestsThisMonth(cfg: OffSwitchConfig, now: number): Promise<number> {
  const d = new Date(now);
  const query = `query ($account: String!, $start: Time!, $end: Time!, $script: String!) {
    viewer { accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $start, datetime_lt: $end }) {
        sum { requests }
      }
    } }
  }`;
  const variables = {
    account: cfg.accountId,
    start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
    end: d.toISOString(),
    script: WORKER_NAME,
  };
  const { body } = await api<any>(cfg, "/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (body?.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
  const groups = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(groups)) throw new Error(`unexpected GraphQL response: ${JSON.stringify(body)}`);
  return groups.reduce((sum: number, g: { sum?: { requests?: number } }) => sum + (g.sum?.requests ?? 0), 0);
}

/** Turns on the block rule for the host: enables it if it exists, otherwise adds it as the first custom rule. */
export async function blockHost(cfg: OffSwitchConfig): Promise<"enabled" | "added" | "already on"> {
  const rule: Rule = {
    description: RULE_DESCRIPTION,
    expression: `(http.host eq "${cfg.host}")`,
    action: "block",
    enabled: true,
  };
  const zone = `/zones/${cfg.zoneId}/rulesets`;
  const entry = await api<any>(cfg, `${zone}/phases/http_request_firewall_custom/entrypoint`, {}, true);
  if (entry.status === 404) {
    await api(cfg, zone, {
      method: "POST",
      body: JSON.stringify({ name: "default", kind: "zone", phase: "http_request_firewall_custom", rules: [rule] }),
    });
    return "added";
  }
  const ruleset = entry.body.result;
  const existing = (ruleset.rules as Rule[] | undefined)?.find((r) => r.description === RULE_DESCRIPTION);
  if (existing?.enabled) return "already on";
  if (existing) {
    const { id, description, expression, action, action_parameters } = existing;
    await api(cfg, `${zone}/${ruleset.id}/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ description, expression, action, action_parameters, enabled: true }),
    });
    return "enabled";
  }
  await api(cfg, `${zone}/${ruleset.id}/rules`, {
    method: "POST",
    body: JSON.stringify({ ...rule, position: { index: 1 } }),
  });
  return "added";
}

async function readState(env: Env): Promise<OffSwitchState | null> {
  return (await (await env.GAO_DATA.get(STATE_KEY))?.json<OffSwitchState>()) ?? null;
}

/** The hourly check. Returns null when the off switch isn't configured. */
export async function checkOffSwitch(env: Env, now = Date.now()): Promise<OffSwitchState | null> {
  const cfg = offSwitchConfig(env);
  if (!cfg) return null;
  const month = new Date(now).toISOString().slice(0, 7);
  const previous = await readState(env);
  const state: OffSwitchState = {
    month,
    checked_at: new Date(now).toISOString(),
    requests: await requestsThisMonth(cfg, now),
    limit: cfg.limit,
    tripped_at: previous?.month === month ? previous.tripped_at : null,
  };
  if (state.requests >= state.limit && !state.tripped_at) {
    const result = await blockHost(cfg);
    state.tripped_at = state.checked_at;
    console.error(
      `OFF SWITCH: ${state.requests} requests this month passed the limit of ${state.limit}; ` +
        `block rule for ${cfg.host} ${result}. Disable the rule "${RULE_DESCRIPTION}" in the WAF to turn the server back on.`,
    );
  }
  await env.GAO_DATA.put(STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
  stateCache = null;
  return state;
}

let stateCache: { at: number; state: OffSwitchState | null } | null = null;

export function clearOffSwitchCache(): void {
  stateCache = null;
}

/** What /health reports about the off switch. */
export async function offSwitchStatus(env: Env, now = Date.now()) {
  if (!offSwitchConfig(env)) return { armed: false };
  if (!stateCache || now - stateCache.at > STATE_CACHE_MS) stateCache = { at: now, state: await readState(env) };
  const state = stateCache.state;
  return { armed: true, checked_at: state?.checked_at ?? null, tripped_at: state?.tripped_at ?? null };
}
