import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DecisionRecord, IndexFile } from "../src/types";
import { VectorMatrix } from "../src/vectors";
import { BUNDLE, readBundleJson } from "./helpers";

function loadMatrix(): VectorMatrix {
  const bytes = readFileSync(join(BUNDLE, "v1/vectors.bin"));
  return new VectorMatrix(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const index = readBundleJson<IndexFile>("v1/index.json");

describe("VectorMatrix", () => {
  const matrix = loadMatrix();

  it("parses the header", () => {
    expect(matrix.count).toBe(index.count);
    expect(matrix.dims).toBe(768);
  });

  it("ranks a row first against itself", () => {
    for (let r = 0; r < matrix.count; r++) {
      const [top] = matrix.topK(matrix.row(r), 1);
      expect(top.row).toBe(r);
      expect(top.score).toBeGreaterThan(0.99);
    }
  });

  it("matches the exact cosine neighbors computed at build time", () => {
    let topOneAgreement = 0;
    index.keys.forEach((key, r) => {
      const record = readBundleJson<DecisionRecord>(`v1/records/${key.toUpperCase().replace(/\s+/g, "")}.json`);
      const exact = new Map(record.neighbors!.cosine!.map((t) => [t[0], t[1] as number]));
      const hits = matrix.topK(matrix.row(r), 5, null, r);
      for (const h of hits) {
        const expected = exact.get(index.keys[h.row]);
        if (expected !== undefined) expect(Math.abs(h.score - expected)).toBeLessThan(0.003);
      }
      if (index.keys[hits[0].row] === record.neighbors!.cosine![0][0]) topOneAgreement++;
    });
    expect(topOneAgreement / index.count).toBeGreaterThan(0.9);
  });

  it("honors the mask, the excluded row and k", () => {
    const mask = new Uint8Array(matrix.count);
    mask[3] = mask[4] = mask[5] = 1;
    const hits = matrix.topK(matrix.row(4), 10, mask, 4);
    expect(hits.map((h) => h.row).sort()).toEqual([3, 5]);
    expect(matrix.topK(matrix.row(0), 0)).toEqual([]);
    expect(matrix.topK(matrix.row(0), 1000)).toHaveLength(matrix.count);
    const scores = matrix.topK(matrix.row(0), 1000).map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("rejects malformed files and queries", () => {
    expect(() => new VectorMatrix(new ArrayBuffer(8))).toThrow(/truncated/);
    const bad = new Uint8Array(32);
    bad.set(new TextEncoder().encode("NOTVECS!"));
    expect(() => new VectorMatrix(bad.buffer)).toThrow(/unknown format/);
    const bytes = new Uint8Array(readFileSync(join(BUNDLE, "v1/vectors.bin")));
    expect(() => new VectorMatrix(bytes.slice(0, bytes.length - 1).buffer)).toThrow(/expected/);
    expect(() => matrix.topK(new Float32Array(3), 1)).toThrow(/dimensions/);
    expect(() => matrix.row(matrix.count)).toThrow(RangeError);
  });
});
