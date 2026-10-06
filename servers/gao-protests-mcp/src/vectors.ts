// Brute-force cosine search over the int8 matrix written by build_bundle.py.
//
// vectors.bin layout (little-endian):
//   0   8 bytes   magic "GAOVEC01"
//   8   uint32    row count
//   12  uint32    dims
//   16  float32[dims]        per-dimension scale
//   ..  int8[count * dims]   quantized rows, row order = index.json keys
//
// A row's cosine to a normalized query is approximately sum_j q[row, j] * query[j] * scale[j].

const MAGIC = "GAOVEC01";
const HEADER_BYTES = 16;

export interface Hit {
  row: number;
  score: number;
}

export class VectorMatrix {
  readonly count: number;
  readonly dims: number;
  readonly scales: Float32Array;
  readonly data: Int8Array;

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength < HEADER_BYTES) throw new Error("vectors.bin is truncated");
    const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
    if (magic !== MAGIC) throw new Error("vectors.bin has an unknown format");
    const view = new DataView(buffer);
    this.count = view.getUint32(8, true);
    this.dims = view.getUint32(12, true);
    const expected = HEADER_BYTES + this.dims * 4 + this.count * this.dims;
    if (this.dims === 0 || buffer.byteLength !== expected) {
      throw new Error(`vectors.bin is ${buffer.byteLength} bytes; expected ${expected}`);
    }
    this.scales = new Float32Array(buffer, HEADER_BYTES, this.dims);
    this.data = new Int8Array(buffer, HEADER_BYTES + this.dims * 4, this.count * this.dims);
  }

  /** Dequantized, L2-normalized copy of one row. */
  row(index: number): Float32Array {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError(`row ${index} is out of range`);
    }
    const out = new Float32Array(this.dims);
    const offset = index * this.dims;
    for (let j = 0; j < this.dims; j++) out[j] = this.data[offset + j] * this.scales[j];
    return normalize(out);
  }

  /**
   * The k rows most similar to a normalized query, best first. Rows where
   * mask[row] is 0, and the excluded row, are skipped.
   */
  topK(query: Float32Array, k: number, mask: Uint8Array | null = null, exclude = -1): Hit[] {
    if (query.length !== this.dims) {
      throw new Error(`query has ${query.length} dimensions; the index has ${this.dims}`);
    }
    const d = this.dims;
    const data = this.data;
    const q = new Float32Array(d);
    for (let j = 0; j < d; j++) q[j] = query[j] * this.scales[j];

    const best: Hit[] = [];
    for (let r = 0; r < this.count; r++) {
      if (r === exclude || (mask !== null && mask[r] === 0)) continue;
      const off = r * d;
      let s = 0;
      let j = 0;
      for (; j + 8 <= d; j += 8) {
        s +=
          data[off + j] * q[j] +
          data[off + j + 1] * q[j + 1] +
          data[off + j + 2] * q[j + 2] +
          data[off + j + 3] * q[j + 3] +
          data[off + j + 4] * q[j + 4] +
          data[off + j + 5] * q[j + 5] +
          data[off + j + 6] * q[j + 6] +
          data[off + j + 7] * q[j + 7];
      }
      for (; j < d; j++) s += data[off + j] * q[j];
      if (best.length < k) {
        insertSorted(best, { row: r, score: s });
      } else if (k > 0 && s > best[best.length - 1].score) {
        best.pop();
        insertSorted(best, { row: r, score: s });
      }
    }
    return best;
  }
}

/** Insert keeping descending score order (ties: lower row first). */
function insertSorted(best: Hit[], hit: Hit): void {
  let lo = 0;
  let hi = best.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (best[mid].score >= hit.score) lo = mid + 1;
    else hi = mid;
  }
  best.splice(lo, 0, hit);
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let j = 0; j < v.length; j++) sum += v[j] * v[j];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let j = 0; j < v.length; j++) v[j] /= norm;
  return v;
}
