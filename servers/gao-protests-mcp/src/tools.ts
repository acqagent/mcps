// Tool implementations. Each returns a plain JSON-serializable object or throws ToolError.

import { activeFilters, buildMask, filterProblem, hasFilters, type CorpusFilters, type Filters } from "./filters";
import { canonicalKey, docketBases, lookupCandidates } from "./keys";
import type { CorpusIndex, DataStore } from "./store";
import type { DecisionRecord, NeighborTuple, SynopsisEntry } from "./types";
import { normalize } from "./vectors";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GAO_PRODUCT_URL = "https://www.gao.gov/products/";
const OCR_ERA_END = 1990;
const DECISION_NUMBER_ONLY = /^\s*[AB]\s*[-\u2010-\u2015]?\s*\d{4,7}(?:\.\d{1,3})?\s*$/i;

/** A failure the caller can act on; returned to the client as an isError result. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ToolContext {
  store: DataStore;
  ai?: Ai;
}

type RankSource = "llm_rerank" | "cosine" | "live_cosine";

interface Candidate {
  key: string;
  similarity: number | null;
  source: RankSource;
  tuple?: NeighborTuple;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveRecord(store: DataStore, input: string): Promise<DecisionRecord> {
  for (const canonical of lookupCandidates(input)) {
    const record = await store.record(canonical);
    if (record) return record;
  }
  const index = await store.index();
  const related = index.related(input);
  throw new ToolError(`No decision found for "${input}".`, {
    ...(related.length ? { related_decisions: related } : {}),
    hint: "Check the B-number, or use search_decisions to find decisions by topic.",
  });
}

export function sourceUrl(record: DecisionRecord): string | null {
  const slug = record.slug;
  // Consolidated decisions have composite slugs whose URL form is not known; omit those.
  if (!slug || !/^[a-z0-9.\-]+$/i.test(slug)) return null;
  return GAO_PRODUCT_URL + slug.toLowerCase();
}

function roundScore(score: number | null | undefined): number | null {
  return typeof score === "number" && Number.isFinite(score) ? Math.round(score * 10000) / 10000 : null;
}

function ocrEra(year: number | null): boolean {
  return !year || year < OCR_ERA_END;
}

/** The analysis year, else the year at the end of the date ("May 25, 2022"), as the index does. */
function yearOf(record: DecisionRecord): number | null {
  if (record.year) return Number(record.year) || null;
  const tail = String(record.date ?? "").trim().slice(-4);
  return /^\d{4}$/.test(tail) ? Number(tail) : null;
}

/** Compact description of a decision for result lists. */
function card(index: CorpusIndex | null, key: string, record: DecisionRecord | undefined, tuple?: NeighborTuple) {
  const row = index?.rowOf(key);
  const fromIndex = index && row !== undefined;
  return {
    b_number: key,
    date: record?.date ?? (fromIndex ? index.date(row) : null) ?? tuple?.[2] ?? null,
    agency: record?.agency ?? (fromIndex ? index.agency(row) || null : null),
    record_type: record?.record_type ?? (fromIndex ? index.recordType(row) || null : null),
    outcome_assessed: record?.outcome_assessed ?? tuple?.[3] ?? (fromIndex ? index.outcome(row) || null : null),
    core_issue: record?.core_issue ?? null,
    summary: record?.summary ?? null,
    issues: record?.issues ?? [],
  };
}

async function embedQuery(ai: Ai, text: string, dims: number): Promise<Float32Array> {
  let output: { data?: number[][] };
  try {
    output = (await ai.run(EMBEDDING_MODEL, { text: [text], pooling: "mean" })) as { data?: number[][] };
  } catch (err) {
    console.error("embedding failed", err);
    throw new ToolError(`Workers AI could not embed the query: ${err instanceof Error ? err.message : String(err)}`);
  }
  const vector = output?.data?.[0];
  if (!Array.isArray(vector) || vector.length !== dims) {
    throw new ToolError(`The embedding model returned an unexpected result (expected ${dims} dimensions).`);
  }
  return normalize(Float32Array.from(vector));
}

// ---------------------------------------------------------------------------
// search_decisions
// ---------------------------------------------------------------------------

export interface SearchArgs extends CorpusFilters {
  query: string;
  limit?: number;
}

export async function searchDecisions(ctx: ToolContext, args: SearchArgs) {
  const query = args.query.trim();
  if (query.length < 3) throw new ToolError("query must contain at least 3 characters.");
  const limit = args.limit ?? 10;
  const filters: Filters = {
    outcome: args.outcome,
    agency: args.agency,
    year_min: args.year_min,
    year_max: args.year_max,
    vehicle: args.vehicle,
    record_type: args.record_type,
  };
  if (!ctx.ai) {
    throw new ToolError("Free-text search is unavailable: the Worker has no Workers AI binding named AI.");
  }
  const [index, vectors] = await Promise.all([ctx.store.index(), ctx.store.vectors()]);
  if (!vectors) {
    throw new ToolError("Free-text search is unavailable: this data bundle was built without vectors.bin.");
  }
  const problem = filterProblem(index, filters);
  if (problem) throw new ToolError(problem);
  const { mask, count } = buildMask(index, filters);
  const echo = activeFilters(filters);
  if (count === 0) {
    return { query, filters: echo, searched: 0, results: [], note: "No decisions match these filters together." };
  }
  const [embedding, named] = await Promise.all([
    embedQuery(ctx.ai, query, vectors.dims),
    DECISION_NUMBER_ONLY.test(query) ? ctx.store.record(lookupCandidates(query)[0] ?? "") : Promise.resolve(null),
  ]);
  const hits = vectors.topK(embedding, limit, hasFilters(filters) ? mask : null);
  const keys = hits.map((h) => index.keys[h.row]);
  const records = await ctx.store.records(keys);
  return {
    query,
    filters: echo,
    searched: count,
    results: hits.map((h, i) => ({
      ...card(index, keys[i], records.get(keys[i])),
      similarity: roundScore(h.score),
    })),
    ...(named
      ? { note: `"${query}" is a decision number. Use find_similar_decisions with b_number ${named.key} for its closest decisions.` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// get_decision
// ---------------------------------------------------------------------------

export async function getDecision(ctx: ToolContext, args: { b_number: string }) {
  const record = await resolveRecord(ctx.store, args.b_number);
  const neighbors = record.neighbors?.reranked?.length
    ? record.neighbors.reranked
    : (record.neighbors?.cosine ?? []).slice(0, 5);
  const year = yearOf(record);
  return {
    b_number: record.key,
    ...(canonicalKey(args.b_number) !== canonicalKey(record.key) ? { requested: args.b_number } : {}),
    b_numbers: record.b_numbers ?? null,
    aliases: record.aliases ?? [],
    date: record.date ?? null,
    year,
    agency: record.agency ?? null,
    record_type: record.record_type ?? null,
    outcome_assessed: record.outcome_assessed ?? null,
    outcome_metadata: record.outcome ?? null,
    redacted: record.redacted ?? null,
    protective_order: record.protective_order ?? null,
    core_issue: record.core_issue ?? null,
    summary: record.summary ?? null,
    issues: record.issues ?? [],
    reasoning: record.reasoning ?? null,
    outcome_rationale: record.outcome_rationale ?? null,
    key_points: record.key_points ?? [],
    significance: record.significance || null,
    source_url: sourceUrl(record),
    similar_decisions: neighbors.map((t) => ({
      b_number: t[0],
      similarity: roundScore(t[1]),
      date: t[2] ?? null,
      outcome_assessed: t[3] ?? null,
    })),
    ...(ocrEra(year)
      ? { note: "Older decisions come from OCR scans: party names in the summary may be garbled and dates may be missing." }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// find_similar_decisions
// ---------------------------------------------------------------------------

export interface SimilarArgs extends Filters {
  b_number: string;
  limit?: number;
}

function precomputedCandidates(record: DecisionRecord): Candidate[] {
  const seen = new Set<string>([record.key]);
  const out: Candidate[] = [];
  const add = (list: NeighborTuple[] | null | undefined, source: RankSource) => {
    for (const t of list ?? []) {
      if (!t?.[0] || seen.has(t[0])) continue;
      seen.add(t[0]);
      out.push({ key: t[0], similarity: t[1], source, tuple: t });
    }
  };
  add(record.neighbors?.reranked, "llm_rerank");
  add(record.neighbors?.cosine, "cosine");
  return out;
}

export async function findSimilarDecisions(ctx: ToolContext, args: SimilarArgs) {
  const record = await resolveRecord(ctx.store, args.b_number);
  const limit = args.limit ?? 5;
  const filters: Filters = {
    outcome: args.outcome,
    agency: args.agency,
    year_min: args.year_min,
    year_max: args.year_max,
    vehicle: args.vehicle,
    record_type: args.record_type,
    opposite_outcome: args.opposite_outcome,
    exclude_same_docket: args.exclude_same_docket,
  };
  const filtered = hasFilters(filters);
  const notes: string[] = [];
  let ranking: string;
  let candidates: Candidate[] = [];
  let searched: number | undefined;
  let index: CorpusIndex | null = null;

  const precomputed = precomputedCandidates(record);
  if (!filtered && precomputed.length > 0) {
    candidates = precomputed.slice(0, limit);
    ranking = record.neighbors?.reranked?.length
      ? "Top 5 re-ranked by an LLM for the same core legal issue, then document cosine similarity."
      : "Document cosine similarity.";
  } else {
    const [idx, vectors] = await Promise.all([ctx.store.index(), ctx.store.vectors()]);
    index = idx;
    const problem = filterProblem(idx, filters);
    if (problem) throw new ToolError(problem);
    const row = idx.rowOf(record.key);
    const target = {
      row,
      outcome: (record.outcome_assessed || record.outcome || "").toLowerCase(),
      docket: docketBases([record.key, ...(record.aliases ?? [])]),
    };
    const { mask, count } = buildMask(idx, filters, target);
    if (vectors && row !== undefined) {
      searched = count - (mask[row] ? 1 : 0);
      candidates = vectors
        .topK(vectors.row(row), limit, filtered ? mask : null, row)
        .map((h) => ({ key: idx.keys[h.row], similarity: h.score, source: "live_cosine" as const }));
      ranking = filtered
        ? "Document cosine similarity over every decision that passes the filters."
        : "Document cosine similarity over the whole corpus.";
    } else {
      candidates = precomputed
        .filter((c) => {
          const r = idx.rowOf(c.key);
          return r !== undefined && mask[r] === 1;
        })
        .slice(0, limit);
      ranking = "Precomputed neighbors only.";
      if (filtered) notes.push("Search vectors are not available, so filters were applied to the precomputed top 20 only.");
    }
  }

  const records = await ctx.store.records(candidates.map((c) => c.key));
  if (filtered && candidates.length < limit) {
    notes.push(`Only ${candidates.length} decision(s) passed the filters.`);
  }
  return {
    b_number: record.key,
    date: record.date ?? null,
    outcome_assessed: record.outcome_assessed ?? null,
    core_issue: record.core_issue ?? null,
    filters: activeFilters(filters),
    ranking,
    ...(searched !== undefined ? { searched } : {}),
    results: candidates.map((c) => ({
      ...card(index, c.key, records.get(c.key), c.tuple),
      similarity: roundScore(c.similarity),
      rank_source: c.source,
    })),
    ...(notes.length ? { notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// get_similarity_synopsis
// ---------------------------------------------------------------------------

export async function getSimilaritySynopsis(
  ctx: ToolContext,
  args: { b_number: string; include_passages?: boolean },
) {
  let entry: SynopsisEntry | null = null;
  for (const canonical of lookupCandidates(args.b_number)) {
    entry = await ctx.store.synopsis(canonical);
    if (entry) break;
  }
  if (!entry) {
    const record = await resolveRecord(ctx.store, args.b_number);
    throw new ToolError(`No stored similarity synopsis for ${record.key}.`, {
      hint: "Use find_similar_decisions for its closest matches.",
    });
  }
  const includePassages = args.include_passages ?? true;
  return {
    b_number: entry.b_number,
    date: entry.date ?? null,
    outcome_assessed: entry.outcome_assessed ?? null,
    synopsis_version: entry.synopsis_version ?? null,
    synopsis: {
      shared: entry.synopsis?.shared ?? [],
      differences: entry.synopsis?.differences ?? [],
      grounds_to_distinguish: entry.synopsis?.grounds_to_distinguish ?? [],
      practical_use: entry.synopsis?.practical_use ?? null,
    },
    similar: (entry.similar ?? []).map((m) => ({
      b_number: m.b_number,
      similarity: roundScore(m.similarity),
      date: m.date ?? null,
      outcome_assessed: m.outcome_assessed ?? null,
      shared_authorities: m.shared_authorities ?? {},
      ...(includePassages ? { matched_passages: m.matched_passages ?? [] } : {}),
    })),
    note:
      "The synopsis is model-generated from the decisions' analyses and full text. Shared authorities " +
      "are citations found in both decisions by pattern matching. Verify in the decisions before relying on it.",
  };
}

// ---------------------------------------------------------------------------
// corpus_info
// ---------------------------------------------------------------------------

export async function corpusInfo(ctx: ToolContext) {
  const m = await ctx.store.manifest();
  return {
    data_version: m.data_version,
    built_at: m.built_at,
    decisions: m.records,
    lookup_keys: m.lookup_keys,
    coverage: m.coverage,
    free_text_search: Boolean(m.vectors) && Boolean(ctx.ai),
    years: m.years,
    outcomes: m.outcomes,
    record_types: m.record_types,
    vehicles: m.vehicles,
    top_agencies: m.top_agencies,
    filter_rules: {
      outcome: "Exact match on outcome_assessed, case-insensitive. Values are listed under outcomes.",
      agency: "Case-insensitive substring of the agency name, for example 'Navy' or 'Veterans'.",
      year_min_year_max: "Inclusive. Decisions without a known year are excluded when either is set.",
      vehicle: "The term appears in the decision's issues or key points.",
      record_type: "Exact match. Values are listed under record_types.",
      opposite_outcome: "find_similar_decisions only: keep matches whose outcome differs from the target's.",
      exclude_same_docket:
        "find_similar_decisions only: drop decisions with the target's GAO file number (B-417297, B-417297.2, ...).",
    },
    caveats: [
      "outcome_assessed is the disposition read from the decision text; outcome_metadata is scraped metadata and is missing for most pre-2004 decisions.",
      "Summaries, issues, key points and synopses are model-generated. Cite B-numbers and confirm key facts in the decision.",
      "Pre-1990 decisions are OCR scans: expect occasional noise in party names and missing dates.",
      "Keys ending in .v2, .v3 are distinct documents that share a B-number (for example an original and a reconsideration).",
    ],
  };
}
