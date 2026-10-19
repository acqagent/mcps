// Checks openai-plugin/ against the limits OpenAI's directory enforces on final submission
// (https://developers.openai.com/plugins/deploy/submission-errors), so a bad edit fails here
// instead of in the portal.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeEnv, rpc } from "./helpers";

const DIR = fileURLToPath(new URL("../openai-plugin", import.meta.url));
const plugin = JSON.parse(readFileSync(join(DIR, "plugin.json"), "utf8"));
const mcp = JSON.parse(readFileSync(join(DIR, "mcp.json"), "utf8"));
const openai = plugin.extensions["com.openai"];
const ui = openai.interface;

const CATEGORIES = [
  "Productivity", "Creativity", "Developer Tools", "Business & Operations", "Data & Analytics", "Communication",
  "Education & Research", "Security", "Finance", "Healthcare", "Travel", "Entertainment", "Other",
];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const b = new Uint8Array(readFileSync(path));
  expect(String.fromCharCode(...b.subarray(1, 4))).toBe("PNG");
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("OpenAI plugin package", () => {
  it("has a valid name, version and author", () => {
    expect(plugin.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.author.name.length).toBeGreaterThan(0);
  });

  it("keeps listing text within the submission limits", () => {
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.developerName.length).toBeLessThanOrEqual(80);
    expect(CATEGORIES).toContain(ui.category);
    expect(ui.capabilities.length).toBeLessThanOrEqual(20);
    for (const c of ui.capabilities) expect(c.length).toBeLessThanOrEqual(120);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
    expect(new Set(ui.defaultPrompt).size).toBe(ui.defaultPrompt.length);
    for (const p of ui.defaultPrompt) {
      expect(p.length).toBeLessThanOrEqual(128);
      expect(p).not.toMatch(/@|\n/);
    }
  });

  it("has all four listing URLs over HTTPS", () => {
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(new URL(ui[key]).protocol, key).toBe("https:");
    }
  });

  it("ships square logo and composer icons", () => {
    for (const key of ["logo", "composerIcon"]) {
      expect(ui[key], key).toMatch(/^\.\/assets\//);
      const path = join(DIR, ui[key]);
      expect(statSync(path).size).toBeLessThanOrEqual(5 * 1024 * 1024);
      const [w, h] = pngSize(path);
      expect(w).toBe(h);
      expect(w).toBeGreaterThanOrEqual(48);
      expect(w).toBeLessThanOrEqual(4096);
    }
  });

  it("uses brand colors with enough contrast", () => {
    expect(contrast(ui.brandColor, "#FFFFFF")).toBeGreaterThanOrEqual(2);
    expect(contrast(ui.brandColorDark, "#212121")).toBeGreaterThanOrEqual(2);
  });

  it("names exactly one public, unauthenticated MCP server", () => {
    const servers = Object.values(mcp.mcpServers) as { type: string; url: string; headers?: unknown; extensions?: any }[];
    expect(servers).toHaveLength(1);
    expect(servers[0].type).toBe("streamable-http");
    expect(new URL(servers[0].url).protocol).toBe("https:");
    expect(servers[0].headers).toBeUndefined();
    expect(servers[0].extensions["com.openai"].auth.type).toBe("none");
  });

  it("has review cases that name real tools", async () => {
    const { env } = makeEnv();
    const { body } = await rpc(env, "tools/list");
    const tools = new Set(body.result.tools.map((t: { name: string }) => t.name));
    const { positive, negative } = openai.review.test_cases;
    expect(positive).toHaveLength(5);
    expect(negative).toHaveLength(3);
    for (const c of positive) {
      expect(c.prompt.length).toBeGreaterThan(0);
      expect(c.expected_behavior.length).toBeGreaterThan(0);
      for (const name of c.tools_triggered.split(/,\s*/)) expect(tools, name).toContain(name);
    }
  });
});
