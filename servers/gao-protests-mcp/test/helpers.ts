import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index";
import { clearCaches, DataStore } from "../src/store";
import type { ToolContext } from "../src/tools";
import type { Env } from "../src/types";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const BUNDLE = join(FIXTURES, "bundle");
export const QUERY_VECTORS: Record<string, number[]> = JSON.parse(
  readFileSync(join(FIXTURES, "query_vectors.json"), "utf8"),
);
export const QUERIES = Object.keys(QUERY_VECTORS);
export const SET_ASIDE_QUERY = QUERIES[0];

type Override = string | Uint8Array | null;

/** Minimal R2Bucket backed by test/fixtures/bundle. Overrides replace (or, with null, hide) objects. */
export class FixtureBucket {
  readonly gets: string[] = [];

  constructor(private readonly overrides: Record<string, Override> = {}) {}

  async get(key: string) {
    this.gets.push(key);
    let bytes: Uint8Array | null;
    if (key in this.overrides) {
      const o = this.overrides[key];
      bytes = typeof o === "string" ? new TextEncoder().encode(o) : o;
    } else {
      const path = join(BUNDLE, key);
      bytes = existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    }
    if (bytes === null) return null;
    const data = bytes;
    return {
      key,
      json: async () => JSON.parse(new TextDecoder().decode(data)),
      text: async () => new TextDecoder().decode(data),
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    };
  }
}

export function readBundleJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(join(BUNDLE, path), "utf8")) as T;
}

/** Deterministic unit vector for query text without a fixture embedding. */
function hashedVector(text: string, dims = 768): number[] {
  let seed = 2166136261;
  for (const ch of text) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0;
    out.push((seed / 4294967295) * 2 - 1);
  }
  const norm = Math.hypot(...out);
  return out.map((x) => x / norm);
}

export function fakeAi() {
  const calls: { model: string; input: { text: string[]; pooling?: string } }[] = [];
  return {
    calls,
    async run(model: string, input: { text: string[]; pooling?: string }) {
      calls.push({ model, input });
      return {
        shape: [input.text.length, 768],
        pooling: input.pooling ?? "mean",
        data: input.text.map((t) => QUERY_VECTORS[t] ?? hashedVector(t)),
      };
    },
  };
}

export function makeEnv(options: { overrides?: Record<string, Override>; ai?: boolean; token?: string } = {}) {
  clearCaches();
  const bucket = new FixtureBucket(options.overrides);
  const ai = fakeAi();
  const env: Env = {
    GAO_DATA: bucket as unknown as R2Bucket,
    AI: options.ai === false ? undefined : (ai as unknown as Ai),
    DATA_VERSION: "v1",
    ...(options.token ? { MCP_AUTH_TOKEN: options.token } : {}),
  };
  return { env, bucket, ai };
}

export function makeContext(options: { overrides?: Record<string, Override>; ai?: boolean } = {}) {
  const { env, bucket, ai } = makeEnv(options);
  const ctx: ToolContext = { store: new DataStore(env.GAO_DATA, "v1"), ai: env.AI };
  return { ctx, bucket, ai };
}

export const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

export async function rpc(
  env: Env,
  method: string,
  params: unknown = {},
  init: { headers?: Record<string, string>; url?: string; id?: number | null } = {},
) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (init.id !== null) body.id = init.id ?? 1;
  const response = await worker.fetch(
    new Request(init.url ?? "https://gao.example/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, ...init.headers },
      body: JSON.stringify(body),
    }),
    env,
  );
  const text = await response.text();
  return { response, status: response.status, body: text ? JSON.parse(text) : null };
}

export async function callTool(env: Env, name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc(env, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  const result = body.result;
  const text = result.content?.[0]?.text ?? "";
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(result.isError), data };
}
