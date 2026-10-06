// R2 access for the bundle written by scripts/build_bundle.py. The manifest,
// index and vectors are loaded once per isolate; records are small and read on demand.

import { canonicalKey, docketBases, isValidCanonical } from "./keys";
import type { DecisionRecord, IndexFile, Manifest, SynopsisEntry } from "./types";
import { VectorMatrix } from "./vectors";

export const SUPPORTED_SCHEMA = 1;

/** The bundle is missing or unreadable; the message says what to fix. */
export class DataUnavailableError extends Error {}

const shared = new Map<string, Promise<unknown>>();
const recordCache = new Map<string, DecisionRecord>();
const RECORD_CACHE_LIMIT = 2000;

function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let pending = shared.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = load();
    shared.set(key, pending);
    // A failed load (bundle not uploaded yet, transient R2 error) is retried next time.
    pending.catch(() => {
      if (shared.get(key) === pending) shared.delete(key);
    });
  }
  return pending;
}

/** Drop isolate-level caches. Tests use this between bundles. */
export function clearCaches(): void {
  shared.clear();
  recordCache.clear();
}

export class CorpusIndex {
  readonly count: number;
  readonly keys: string[];
  private readonly rowByKey = new Map<string, number>();
  private readonly rowByCanonical = new Map<string, number>();
  private aliasesByRow: Map<number, string[]> | null = null;
  private docketByRow: string[][] | null = null;

  constructor(readonly file: IndexFile) {
    const n = file.keys.length;
    for (const column of [file.dates, file.years, file.outcome, file.agency, file.record_type, file.vehicles]) {
      if (!Array.isArray(column) || column.length !== n) {
        throw new DataUnavailableError("index.json columns have mismatched lengths; rebuild the bundle");
      }
    }
    this.count = n;
    this.keys = file.keys;
    file.keys.forEach((key, row) => {
      this.rowByKey.set(key, row);
      this.rowByCanonical.set(canonicalKey(key), row);
    });
    for (const [alias, primary] of Object.entries(file.aliases ?? {})) {
      const row = this.rowByKey.get(primary);
      if (row !== undefined && !this.rowByCanonical.has(alias)) this.rowByCanonical.set(alias, row);
    }
  }

  rowOf(key: string): number | undefined {
    return this.rowByKey.get(key) ?? this.rowByCanonical.get(canonicalKey(key));
  }

  date(row: number): string | null {
    return this.file.dates[row] ?? null;
  }

  year(row: number): number {
    return this.file.years[row] || 0;
  }

  outcome(row: number): string {
    return this.file.outcomes[this.file.outcome[row]] ?? "";
  }

  agency(row: number): string {
    return this.file.agencies[this.file.agency[row]] ?? "";
  }

  recordType(row: number): string {
    return this.file.record_types[this.file.record_type[row]] ?? "";
  }

  /** Canonical alias keys that resolve to this row (not including the primary key). */
  aliasesOf(row: number): string[] {
    if (!this.aliasesByRow) {
      const map = new Map<number, string[]>();
      for (const [alias, primary] of Object.entries(this.file.aliases ?? {})) {
        const r = this.rowByKey.get(primary);
        if (r === undefined) continue;
        const list = map.get(r);
        if (list) list.push(alias);
        else map.set(r, [alias]);
      }
      this.aliasesByRow = map;
    }
    return this.aliasesByRow.get(row) ?? [];
  }

  /** GAO file numbers of a row's key and aliases. */
  docketOf(row: number): string[] {
    if (!this.docketByRow) {
      this.docketByRow = this.keys.map((key, r) => [...docketBases([key, ...this.aliasesOf(r)])]);
    }
    return this.docketByRow[row];
  }

  /** Keys sharing a GAO file number with the input, for "did you mean" hints. */
  related(input: string, limit = 10): string[] {
    const wanted = docketBases([input]);
    if (wanted.size === 0) return [];
    const out: string[] = [];
    for (let row = 0; row < this.count && out.length < limit; row++) {
      if (this.docketOf(row).some((b) => wanted.has(b))) out.push(this.keys[row]);
    }
    return out;
  }
}

export class DataStore {
  constructor(
    readonly bucket: R2Bucket,
    readonly version: string,
  ) {}

  private path(name: string): string {
    return `${this.version}/${name}`;
  }

  private async getObject(name: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(this.path(name));
  }

  manifest(): Promise<Manifest> {
    return once(`${this.version}:manifest`, async () => {
      const obj = await this.getObject("manifest.json");
      if (!obj) {
        throw new DataUnavailableError(
          `No data bundle at ${this.path("manifest.json")} in the R2 bucket. Upload the output of ` +
            `scripts/build_bundle.py, and check that DATA_VERSION matches its --data-version.`,
        );
      }
      const manifest = (await obj.json()) as Manifest;
      if (manifest.schema !== SUPPORTED_SCHEMA) {
        throw new DataUnavailableError(
          `Bundle schema ${manifest.schema} is not supported (expected ${SUPPORTED_SCHEMA}); rebuild the bundle.`,
        );
      }
      return manifest;
    });
  }

  index(): Promise<CorpusIndex> {
    return once(`${this.version}:index`, async () => {
      const obj = await this.getObject("index.json");
      if (!obj) throw new DataUnavailableError(`Missing ${this.path("index.json")} in the R2 bucket.`);
      return new CorpusIndex((await obj.json()) as IndexFile);
    });
  }

  /** The search matrix, or null when the bundle was built without vectors. */
  vectors(): Promise<VectorMatrix | null> {
    return once(`${this.version}:vectors`, async () => {
      const manifest = await this.manifest();
      if (!manifest.vectors) return null;
      const obj = await this.getObject(manifest.vectors.file);
      if (!obj) throw new DataUnavailableError(`Missing ${this.path(manifest.vectors.file)} in the R2 bucket.`);
      const matrix = new VectorMatrix(await obj.arrayBuffer());
      const index = await this.index();
      if (matrix.count !== index.count) {
        throw new DataUnavailableError(
          `vectors.bin has ${matrix.count} rows but index.json has ${index.count}; upload a matching bundle.`,
        );
      }
      return matrix;
    });
  }

  /** A record by canonical key (primary or alias), or null. */
  async record(canonical: string): Promise<DecisionRecord | null> {
    if (!isValidCanonical(canonical)) return null;
    const cacheKey = `${this.version}:${canonical}`;
    const hit = recordCache.get(cacheKey);
    if (hit) return hit;
    const obj = await this.getObject(`records/${canonical}.json`);
    if (!obj) return null;
    const record = (await obj.json()) as DecisionRecord;
    if (recordCache.size >= RECORD_CACHE_LIMIT) {
      const oldest = recordCache.keys().next().value;
      if (oldest !== undefined) recordCache.delete(oldest);
    }
    recordCache.set(cacheKey, record);
    return record;
  }

  /** Records for primary keys, fetched in parallel. Missing keys are absent from the map. */
  async records(keys: string[]): Promise<Map<string, DecisionRecord>> {
    const unique = [...new Set(keys)];
    const found = await Promise.all(unique.map((k) => this.record(canonicalKey(k))));
    const out = new Map<string, DecisionRecord>();
    unique.forEach((k, i) => {
      const rec = found[i];
      if (rec) out.set(k, rec);
    });
    return out;
  }

  async synopsis(canonical: string): Promise<SynopsisEntry | null> {
    if (!isValidCanonical(canonical)) return null;
    const obj = await this.getObject(`synopsis/${canonical}.json`);
    return obj ? ((await obj.json()) as SynopsisEntry) : null;
  }
}
