// Runs the production bundle (wrangler deploy --dry-run) inside workerd with an
// R2 bucket seeded from test/fixtures/bundle and a stand-in Workers AI binding.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE, MCP_HEADERS, QUERY_VECTORS, SET_ASIDE_QUERY } from "./helpers";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** wrangler.jsonc without comments. */
function readWranglerConfig(): { compatibility_date: string; compatibility_flags?: string[] } {
  const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i];
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

const FAKE_AI = `
import { WorkerEntrypoint } from "cloudflare:workers";
const VECTORS = ${JSON.stringify(QUERY_VECTORS)};
export default class extends WorkerEntrypoint {
  async run(model, input) {
    return { shape: [input.text.length, 768], pooling: input.pooling, data: input.text.map((t) => VECTORS[t]) };
  }
  async fetch() { return new Response("fake ai"); }
}`;

let mf: Miniflare;
let outdir: string;

async function call(method: string, params: unknown = {}) {
  const res = await mf.dispatchFetch("http://localhost/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const body = await call("tools/call", { name, arguments: args });
  return { isError: Boolean(body.result.isError), data: JSON.parse(body.result.content[0].text) };
}

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), "gao-protests-mcp-"));
  execFileSync(process.execPath, [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", outdir], {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    stdio: "pipe",
  });
  const config = readWranglerConfig();
  const script = readFileSync(join(outdir, "index.js"), "utf8");
  // The same bundle twice: "gao-protests-mcp" with a roomy allowance, "limited" with one call a day.
  const server = (name: string, daily: string) => ({
    config: {
      name,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags ?? [],
      env: {
        GAO_DATA: { type: "r2", name: "gao-protests" },
        AI: { type: "worker", worker: "fake-ai" },
        USAGE: { type: "durable-object", worker: name, exportName: "UsageCounter" },
        DATA_VERSION: { type: "text", value: "v1" },
        DAILY_TOOL_CALLS: { type: "text", value: daily },
        MONTHLY_TOOL_CALLS: { type: "text", value: "300000" },
      },
      exports: { UsageCounter: { type: "durable-object", storage: "sqlite" } },
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: script } } },
    },
  }) as const;
  mf = new Miniflare({
    workers: [
      server("gao-protests-mcp", "20000"),
      server("limited", "1"),
      {
        config: {
          name: "fake-ai",
          compatibilityDate: config.compatibility_date,
          manifest: { mainModule: "ai.js", modules: { "ai.js": { type: "esm", contents: FAKE_AI } } },
        },
      },
    ],
  });
  const bucket = await mf.getR2Bucket("GAO_DATA", "gao-protests-mcp");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  for (const file of walk(BUNDLE)) {
    await bucket.put(relative(BUNDLE, file).split("\\").join("/"), readFileSync(file));
  }
});

afterAll(async () => {
  await mf?.dispose();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

describe("production bundle in workerd", () => {
  it("initializes and lists tools", async () => {
    const init = await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "workerd-test", version: "0" },
    });
    expect(init.result.serverInfo.name).toBe("gao-protests");
    const list = await call("tools/list");
    expect(list.result.tools).toHaveLength(5);
  });

  it("reads records from R2", async () => {
    const d = await tool("get_decision", { b_number: "b-900201.3" });
    expect(d.isError).toBe(false);
    expect(d.data.b_number).toBe("B-900201.2");
  });

  it("searches the int8 vectors with filters", async () => {
    const r = await tool("find_similar_decisions", { b_number: "B-900101", outcome: "sustained" });
    expect(r.isError).toBe(false);
    expect(r.data.results.every((m: { outcome_assessed: string }) => m.outcome_assessed === "sustained")).toBe(true);
    expect(r.data.results[0].rank_source).toBe("live_cosine");
  });

  it("embeds free text through the AI binding", async () => {
    const r = await tool("search_decisions", { query: SET_ASIDE_QUERY, limit: 3 });
    expect(r.isError).toBe(false);
    for (const m of r.data.results) expect(m.issues).toContain("Small business set-aside");
  });

  it("serves the stored synopsis and corpus info", async () => {
    expect((await tool("get_similarity_synopsis", { b_number: "B-900101" })).data.synopsis_version).toBe("v2");
    expect((await tool("corpus_info")).data.decisions).toBe(36);
  });

  it("reports health, with tool calls counted by the Durable Object", async () => {
    const res = await mf.dispatchFetch("http://localhost/health");
    const health: any = await res.json();
    expect(health).toMatchObject({ ok: true, decisions: 36, search: true, off_switch: { armed: false } });
    expect(health.tool_calls.today).toEqual({ used: 5, limit: 20000 }); // the five tool calls above
    expect(health.access).toMatchObject({ allowlist: "off", openai_list: "built-in", anthropic_prefixes: 1 });
    expect(health.access.openai_prefixes).toBeGreaterThan(100);
  });

  it("stops tool calls past the allowance", async () => {
    const limited = await mf.getWorker("limited");
    const call = async () => {
      const res = await limited.fetch("http://localhost/mcp", {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "corpus_info", arguments: {} } }),
      });
      return ((await res.json()) as any).result;
    };
    expect((await call()).isError).toBeFalsy();
    const second = await call();
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/daily allowance/);
  });
});
