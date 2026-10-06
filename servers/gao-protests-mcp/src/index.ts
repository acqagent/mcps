// Worker entry point: a stateless MCP server (Streamable HTTP, JSON responses) at /mcp.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, DEFAULT_DATA_VERSION } from "./server";
import { DataStore } from "./store";
import type { Env } from "./types";
import { VERSION } from "./version";

const MCP_PATH = "/mcp";

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
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err instanceof Error ? err.message : String(err) }, 503);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (url.pathname === MCP_PATH) {
      if (!authorized(request, url, env.MCP_AUTH_TOKEN)) {
        return json(
          { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
          401,
          { "WWW-Authenticate": 'Bearer realm="gao-protests-mcp"' },
        );
      }
      return handleMcp(request, env);
    }
    if (url.pathname === "/health") return handleHealth(env);
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
} satisfies ExportedHandler<Env>;
