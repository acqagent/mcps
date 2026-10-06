import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { VERSION } from "../src/version";
import { MCP_HEADERS, SET_ASIDE_QUERY, callTool, makeEnv, rpc } from "./helpers";

const TOOLS = ["search_decisions", "get_decision", "find_similar_decisions", "get_similarity_synopsis", "corpus_info"];

describe("MCP over HTTP", () => {
  it("initializes statelessly", async () => {
    const { env } = makeEnv();
    const { status, body, response } = await rpc(env, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo).toMatchObject({ name: "gao-protests", version: VERSION });
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toMatch(/outcome_assessed/);
  });

  it("accepts notifications without a body", async () => {
    const { env } = makeEnv();
    const { status } = await rpc(env, "notifications/initialized", undefined, { id: null });
    expect(status).toBe(202);
  });

  it("lists read-only tools with input schemas", async () => {
    const { env } = makeEnv();
    const { body } = await rpc(env, "tools/list");
    const tools = body.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(50);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema.type).toBe("object");
    }
    const search = tools.find((t: { name: string }) => t.name === "search_decisions");
    expect(search.inputSchema.required).toEqual(["query"]);
    expect(search.inputSchema.properties.vehicle.enum).toContain("set-aside");
  });

  it("calls every tool", async () => {
    const { env } = makeEnv();
    const decision = await callTool(env, "get_decision", { b_number: "B-900101" });
    expect(decision.isError).toBe(false);
    expect(decision.data.b_number).toBe("B-900101");

    const similar = await callTool(env, "find_similar_decisions", { b_number: "B-900101", vehicle: "set-aside" });
    expect(similar.isError).toBe(false);
    expect(similar.data.results).toHaveLength(5);

    const search = await callTool(env, "search_decisions", { query: SET_ASIDE_QUERY, limit: 3 });
    expect(search.isError).toBe(false);
    expect(search.data.results).toHaveLength(3);

    const synopsis = await callTool(env, "get_similarity_synopsis", { b_number: "B-900101" });
    expect(synopsis.isError).toBe(false);
    expect(synopsis.data.synopsis_version).toBe("v2");

    const info = await callTool(env, "corpus_info");
    expect(info.isError).toBe(false);
    expect(info.data.decisions).toBe(36);
  });

  it("returns tool errors as isError results", async () => {
    const { env } = makeEnv();
    const missing = await callTool(env, "get_decision", { b_number: "B-900201.9" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error).toMatch(/No decision found/);
    expect(missing.data.related_decisions).toContain("B-900201");

    const invalid = await callTool(env, "find_similar_decisions", { b_number: "B-900101", limit: 500 });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.data)).toMatch(/limit/);
  });

  it("reports a missing bundle without crashing", async () => {
    const { env } = makeEnv({ overrides: { "v1/manifest.json": null, "v1/records/B-900101.json": null } });
    const info = await callTool(env, "corpus_info");
    expect(info.isError).toBe(true);
    expect(info.data.error).toMatch(/No data bundle/);
  });

  it("rejects GET and unsupported Accept headers", async () => {
    const { env } = makeEnv();
    const get = await worker.fetch(new Request("https://gao.example/mcp"), env);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST, OPTIONS");
    const badAccept = await rpc(env, "tools/list", {}, { headers: { Accept: "application/json" } });
    expect(badAccept.status).toBe(406);
  });

  it("answers CORS preflight", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request("https://gao.example/mcp", { method: "OPTIONS" }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
  });
});

describe("authentication", () => {
  it("is open when MCP_AUTH_TOKEN is unset", async () => {
    const { env } = makeEnv();
    expect((await rpc(env, "tools/list")).status).toBe(200);
  });

  it("requires the token when MCP_AUTH_TOKEN is set", async () => {
    const { env } = makeEnv({ token: "s3cret-token" });
    const none = await rpc(env, "tools/list");
    expect(none.status).toBe(401);
    expect(none.response.headers.get("WWW-Authenticate")).toMatch(/Bearer/);
    expect((await rpc(env, "tools/list", {}, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await rpc(env, "tools/list", {}, { headers: { Authorization: "Bearer s3cret-token" } })).status).toBe(200);
    expect((await rpc(env, "tools/list", {}, { headers: { Authorization: "bearer  s3cret-token " } })).status).toBe(200);
    expect((await rpc(env, "tools/list", {}, { url: "https://gao.example/mcp?key=s3cret-token" })).status).toBe(200);
    expect((await rpc(env, "tools/list", {}, { url: "https://gao.example/mcp?key=s3cret" })).status).toBe(401);
  });

  it("keeps /health open", async () => {
    const { env } = makeEnv({ token: "s3cret-token" });
    expect((await worker.fetch(new Request("https://gao.example/health"), env)).status).toBe(200);
  });
});

describe("other routes", () => {
  it("serves health from the manifest", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request("https://gao.example/health"), env);
    expect(await res.json()).toMatchObject({ ok: true, version: VERSION, data_version: "v1", decisions: 36, search: true });
    const broken = makeEnv({ overrides: { "v1/manifest.json": null } });
    const down = await worker.fetch(new Request("https://gao.example/health"), broken.env);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ ok: false });
  });

  it("describes itself at / and 404s elsewhere", async () => {
    const { env } = makeEnv();
    const root = await worker.fetch(new Request("https://gao.example/"), env);
    expect(await root.json()).toMatchObject({ mcp_endpoint: "https://gao.example/mcp" });
    expect((await worker.fetch(new Request("https://gao.example/sse", { headers: MCP_HEADERS }), env)).status).toBe(404);
  });
});

describe("package metadata", () => {
  it("keeps the version in sync", () => {
    const pkg = JSON.parse(readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
