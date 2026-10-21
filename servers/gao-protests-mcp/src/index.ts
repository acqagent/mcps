// Worker entry point: a stateless MCP server (Streamable HTTP, JSON responses) at /mcp.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { accessStatus, fromAllowedNetwork, refreshOpenAiRanges } from "./access";
import { allowanceStatus } from "./allowance";
import { checkOffSwitch, offSwitchStatus } from "./offswitch";
import { createServer, DEFAULT_DATA_VERSION } from "./server";
import { DataStore } from "./store";
import type { Env } from "./types";
import { VERSION } from "./version";

export { UsageCounter } from "./allowance";

const MCP_PATH = "/mcp";
const OPENAI_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const NOT_ALLOWED = "This server accepts connections from ChatGPT and Claude. Add it there as an app or connector.";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function withCors(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

/** Constant-time comparison of two strings. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request, url: URL, token: string | undefined): boolean {
  if (!token) return true;
  const header = request.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  const presented = bearer ?? url.searchParams.get("key") ?? "";
  return presented.length > 0 && safeEqual(presented, token);
}

/**
 * Who may use /mcp. With ALLOWLIST off, anyone, or only token holders when MCP_AUTH_TOKEN is set.
 * With ALLOWLIST "on", ChatGPT's and Claude's servers, plus token holders connecting from elsewhere.
 */
async function checkAccess(request: Request, url: URL, env: Env): Promise<"ok" | "unauthorized" | "forbidden"> {
  const token = env.MCP_AUTH_TOKEN;
  const hasToken = Boolean(token) && authorized(request, url, token);
  if (env.ALLOWLIST !== "on") return !token || hasToken ? "ok" : "unauthorized";
  if (hasToken) return "ok";
  return (await fromAllowedNetwork(request.headers.get("CF-Connecting-IP"), env)) ? "ok" : "forbidden";
}

/** The client's IP address, with IPv6 cut to its /64: one client usually holds a whole /64. */
export function rateLimitKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** Checks the per-client limit. Without the binding, or if the limiter fails, the request goes through. */
async function withinRateLimit(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_RATE_LIMITER) return true;
  try {
    const key = rateLimitKey(request.headers.get("CF-Connecting-IP"));
    return (await env.MCP_RATE_LIMITER.limit({ key })).success;
  } catch (err) {
    console.error("rate limiter failed", err);
    return true;
  }
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json(
      { jsonrpc: "2.0", error: { code: -32000, message: "This stateless MCP server only accepts POST." }, id: null },
      405,
      { Allow: "POST, OPTIONS" },
    );
  }
  const server = createServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request));
}

/** A /health section, or an error note in its place, so one failing part doesn't fail the whole check. */
async function reported<T>(name: string, read: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await read();
  } catch (err) {
    console.error(`health: ${name} failed`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleHealth(env: Env): Promise<Response> {
  const store = new DataStore(env.GAO_DATA, env.DATA_VERSION || DEFAULT_DATA_VERSION);
  try {
    const manifest = await store.manifest();
    return json({
      ok: true,
      version: VERSION,
      data_version: manifest.data_version,
      built_at: manifest.built_at,
      decisions: manifest.records,
      search: Boolean(manifest.vectors) && Boolean(env.AI),
      tool_calls: await reported("allowance", () => allowanceStatus(env)),
      access: await reported("access", () => accessStatus(env)),
      off_switch: await reported("off switch", () => offSwitchStatus(env)),
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err instanceof Error ? err.message : String(err) }, 503);
  }
}

/** OpenAI's domain verification expects the token alone, as plain text. */
function handleOpenAiChallenge(env: Env): Response {
  const token = env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) return json({ error: "Not found" }, 404);
  return new Response(token, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (url.pathname === MCP_PATH) {
      if (!(await withinRateLimit(request, env))) {
        return json(
          { jsonrpc: "2.0", error: { code: -32029, message: "Too many requests. Wait a minute and try again." }, id: null },
          429,
          { "Retry-After": "60" },
        );
      }
      const access = await checkAccess(request, url, env);
      if (access === "unauthorized") {
        return json(
          { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
          401,
          { "WWW-Authenticate": 'Bearer realm="gao-protests-mcp"' },
        );
      }
      if (access === "forbidden") {
        return json({ jsonrpc: "2.0", error: { code: -32003, message: NOT_ALLOWED }, id: null }, 403);
      }
      return handleMcp(request, env);
    }
    if (url.pathname === "/health") return handleHealth(env);
    if (url.pathname === OPENAI_CHALLENGE_PATH) return handleOpenAiChallenge(env);
    if (url.pathname === "/") {
      return json({
        name: "gao-protests-mcp",
        version: VERSION,
        description: "MCP server for searching and comparing GAO bid protest decisions.",
        mcp_endpoint: `${url.origin}${MCP_PATH}`,
        transport: "streamable-http (stateless, JSON responses)",
      });
    }
    return json({ error: "Not found", mcp_endpoint: `${url.origin}${MCP_PATH}` }, 404);
  },

  /** Hourly ("triggers" in wrangler.jsonc): refresh OpenAI's IP ranges and run the off switch check. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const [ranges, offSwitch] = await Promise.allSettled([refreshOpenAiRanges(env), checkOffSwitch(env)]);
    if (ranges.status === "rejected") console.error("refreshing OpenAI's IP ranges failed", ranges.reason);
    if (offSwitch.status === "rejected") console.error("off switch check failed", offSwitch.reason);
  },
} satisfies ExportedHandler<Env>;
