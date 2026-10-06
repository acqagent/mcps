import { describe, expect, it } from "vitest";
import { DataStore, DataUnavailableError } from "../src/store";
import {
  EMBEDDING_MODEL,
  ToolError,
  corpusInfo,
  findSimilarDecisions,
  getDecision,
  getSimilaritySynopsis,
  searchDecisions,
} from "../src/tools";
import type { DecisionRecord, Manifest } from "../src/types";
import { QUERIES, SET_ASIDE_QUERY, makeContext, readBundleJson } from "./helpers";

const record = (canonical: string) => readBundleJson<DecisionRecord>(`v1/records/${canonical}.json`);

async function toolError(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected a ToolError");
}

describe("get_decision", () => {
  it("returns the analysis with similar decisions and a source URL", async () => {
    const { ctx } = makeContext();
    const d = await getDecision(ctx, { b_number: "b-900101" });
    expect(d.b_number).toBe("B-900101");
    expect(d).not.toHaveProperty("requested");
    expect(d.outcome_assessed).toBe("denied");
    expect(d.source_url).toBe("https://www.gao.gov/products/b-900101");
    expect(d.similar_decisions.map((s) => s.b_number)).toEqual(record("B-900101").neighbors!.reranked!.map((t) => t[0]));
    expect(d).not.toHaveProperty("note");
  });

  it("resolves an alias of a consolidated decision to its primary record", async () => {
    const { ctx } = makeContext();
    const d = await getDecision(ctx, { b_number: "B\u2011900201.3" });
    expect(d.b_number).toBe("B-900201.2");
    expect(d.requested).toBe("B\u2011900201.3");
    expect(d.aliases).toEqual(["B-900201.2", "B-900201.3"]);
    expect(d.source_url).toBeNull(); // composite slug
  });

  it("finds a decision number inside free text", async () => {
    const { ctx } = makeContext();
    expect((await getDecision(ctx, { b_number: "GAO decision B-900302 (2019)" })).b_number).toBe("B-900302");
  });

  it("resolves .vN, A-number, slug and space-separated keys", async () => {
    const { ctx } = makeContext();
    for (const [input, key] of [
      ["b-180001.v2", "B-180001.v2"],
      ["a-70001", "A-70001"],
      ["400001", "400001"],
      ["B-180101 B-180102", "B-180101 B-180102"],
      ["B-900301a", "B-900301A"],
    ]) {
      expect((await getDecision(ctx, { b_number: input })).b_number).toBe(key);
    }
  });

  it("flags OCR-era decisions, taking the year from the date when needed", async () => {
    const { ctx } = makeContext();
    const d = await getDecision(ctx, { b_number: "B-180201" });
    expect(d.year).toBe(1979);
    expect(d.note).toMatch(/OCR/);
    expect((await getDecision(ctx, { b_number: "B-180001" })).year).toBeNull();
  });

  it("falls back to the cosine top 5 without a re-ranked list", async () => {
    const { ctx } = makeContext();
    const d = await getDecision(ctx, { b_number: "B-900106.2" });
    expect(d.similar_decisions.map((s) => s.b_number)).toEqual(
      record("B-900106.2").neighbors!.cosine!.slice(0, 5).map((t) => t[0]),
    );
  });

  it("suggests decisions from the same GAO file when a number is unknown", async () => {
    const { ctx } = makeContext();
    const err = await toolError(getDecision(ctx, { b_number: "B-900201.9" }));
    expect(err.message).toMatch(/No decision found/);
    expect(err.details.related_decisions).toEqual(["B-900201", "B-900201.2", "B-900201.4"]);
    const none = await toolError(getDecision(ctx, { b_number: "B-123" }));
    expect(none.details).not.toHaveProperty("related_decisions");
  });
});

describe("find_similar_decisions", () => {
  it("puts the LLM re-ranked top 5 first, then cosine neighbors", async () => {
    const { ctx } = makeContext();
    const r = await findSimilarDecisions(ctx, { b_number: "B-900101", limit: 8 });
    const rec = record("B-900101");
    const reranked = rec.neighbors!.reranked!.map((t) => t[0]);
    expect(r.results.slice(0, 5).map((m) => m.b_number)).toEqual(reranked);
    expect(r.results.slice(0, 5).every((m) => m.rank_source === "llm_rerank")).toBe(true);
    expect(r.results.slice(5).every((m) => m.rank_source === "cosine")).toBe(true);
    const keys = r.results.map((m) => m.b_number);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("B-900101");
    expect(r.results[0].summary).toBeTruthy();
    expect(r).not.toHaveProperty("searched");
  });

  it("uses cosine order when there is no re-ranked list", async () => {
    const { ctx } = makeContext();
    const r = await findSimilarDecisions(ctx, { b_number: "B-900106.2" });
    expect(r.results.map((m) => m.b_number)).toEqual(
      record("B-900106.2").neighbors!.cosine!.slice(0, 5).map((t) => t[0]),
    );
    expect(r.ranking).toBe("Document cosine similarity.");
  });

  it("ranks the whole filtered corpus with live vectors", async () => {
    const { ctx } = makeContext();
    const r = await findSimilarDecisions(ctx, { b_number: "B-900101", outcome: "sustained", limit: 20 });
    const manifest = readBundleJson<Manifest>("v1/manifest.json");
    expect(r.searched).toBe(manifest.outcomes["sustained"]);
    expect(r.results).toHaveLength(manifest.outcomes["sustained"]);
    expect(r.results.every((m) => m.outcome_assessed === "sustained" && m.rank_source === "live_cosine")).toBe(true);
    // Same-topic decisions come first.
    expect(r.results[0].issues).toContain("Small business set-aside");
  });

  it("finds contrary outcomes and skips the same GAO file", async () => {
    const { ctx } = makeContext();
    const opposite = await findSimilarDecisions(ctx, { b_number: "B-900201.3", opposite_outcome: true, limit: 20 });
    expect(opposite.b_number).toBe("B-900201.2");
    expect(opposite.results.every((m) => m.outcome_assessed && m.outcome_assessed !== "sustained")).toBe(true);

    const docket = await findSimilarDecisions(ctx, { b_number: "B-900201.2", exclude_same_docket: true, limit: 20 });
    const keys = docket.results.map((m) => m.b_number);
    expect(keys).not.toContain("B-900201");
    expect(keys).not.toContain("B-900201.4");
    expect(docket.searched).toBe(33);
  });

  it("reports when filters leave fewer matches than requested", async () => {
    const { ctx } = makeContext();
    const r = await findSimilarDecisions(ctx, { b_number: "B-900101", record_type: "reconsideration", limit: 5 });
    expect(r.results.map((m) => m.b_number)).toEqual(["B-900201.4"]);
    expect(r.notes).toEqual(["Only 1 decision(s) passed the filters."]);
  });

  it("filters the precomputed neighbors when the bundle has no vectors", async () => {
    const manifest = readBundleJson<Manifest>("v1/manifest.json");
    const { ctx, bucket } = makeContext({
      overrides: { "v1/manifest.json": JSON.stringify({ ...manifest, vectors: null }) },
    });
    const r = await findSimilarDecisions(ctx, { b_number: "B-900101", outcome: "sustained" });
    expect(r.ranking).toBe("Precomputed neighbors only.");
    expect(r.notes?.[0]).toMatch(/precomputed top 20/);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((m) => m.outcome_assessed === "sustained")).toBe(true);
    expect(bucket.gets).not.toContain("v1/vectors.bin");
  });
});

describe("search_decisions", () => {
  it("embeds the query with mean pooling and ranks by topic", async () => {
    const { ctx, ai } = makeContext();
    const r = await searchDecisions(ctx, { query: SET_ASIDE_QUERY, limit: 5 });
    expect(ai.calls).toEqual([{ model: EMBEDDING_MODEL, input: { text: [SET_ASIDE_QUERY], pooling: "mean" } }]);
    expect(r.searched).toBe(36);
    expect(r.results).toHaveLength(5);
    for (const m of r.results) expect(m.issues).toContain("Small business set-aside");
    const scores = r.results.map((m) => m.similarity!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("applies filters before ranking", async () => {
    const { ctx } = makeContext();
    const r = await searchDecisions(ctx, { query: QUERIES[2], year_max: 1990, limit: 10 });
    expect(r.filters).toEqual({ year_max: 1990 });
    expect(r.results.map((m) => m.b_number).sort()).toEqual(["B-180101 B-180102", "B-180201"]);
  });

  it("returns an empty result without calling the model when nothing matches", async () => {
    const { ctx, ai } = makeContext();
    const r = await searchDecisions(ctx, { query: "anything at all", vehicle: "bpa" });
    expect(r.results).toEqual([]);
    expect(r.searched).toBe(0);
    expect(r.note).toMatch(/No decisions match/);
    expect(ai.calls).toHaveLength(0);
  });

  it("explains filters that cannot match", async () => {
    const { ctx, ai } = makeContext();
    const outcome = await toolError(searchDecisions(ctx, { query: "bid bond", outcome: "won" }));
    expect(outcome.message).toBe(
      'Unknown outcome "won". Use one of: denied, sustained, dismissed, sustained in part.',
    );
    const agency = await toolError(searchDecisions(ctx, { query: "bid bond", agency: "Space Force" }));
    expect(agency.message).toMatch(/^No agency name contains "Space Force". Common agencies: Department of the Navy;/);
    const years = await toolError(findSimilarDecisions(ctx, { b_number: "B-900101", year_min: 2020, year_max: 2010 }));
    expect(years.message).toMatch(/year_min \(2020\) is after year_max \(2010\)/);
    expect(ai.calls).toHaveLength(0);
  });

  it("points a bare decision number to find_similar_decisions", async () => {
    const { ctx } = makeContext();
    const r = await searchDecisions(ctx, { query: "b-900101" });
    expect(r.note).toMatch(/find_similar_decisions with b_number B-900101/);
    const unknown = await searchDecisions(ctx, { query: "B-123456" });
    expect(unknown).not.toHaveProperty("note");
  });

  it("explains why search is unavailable", async () => {
    const noAi = makeContext({ ai: false });
    expect((await toolError(searchDecisions(noAi.ctx, { query: "bid bond" }))).message).toMatch(/Workers AI/);
    const manifest = readBundleJson<Manifest>("v1/manifest.json");
    const noVectors = makeContext({ overrides: { "v1/manifest.json": JSON.stringify({ ...manifest, vectors: null }) } });
    expect((await toolError(searchDecisions(noVectors.ctx, { query: "bid bond" }))).message).toMatch(/vectors/);
    const { ctx } = makeContext();
    expect((await toolError(searchDecisions(ctx, { query: "  a " }))).message).toMatch(/at least 3/);
  });

  it("rejects an embedding with the wrong shape", async () => {
    const { ctx } = makeContext();
    ctx.ai = { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai;
    expect((await toolError(searchDecisions(ctx, { query: "bid bond" }))).message).toMatch(/768 dimensions/);
  });

  it("reports a Workers AI failure as a tool error", async () => {
    const { ctx } = makeContext();
    ctx.ai = {
      run: async () => {
        throw new Error("3010: Invalid or incomplete input");
      },
    } as unknown as Ai;
    const err = await toolError(searchDecisions(ctx, { query: "bid bond" }));
    expect(err.message).toBe("Workers AI could not embed the query: 3010: Invalid or incomplete input");
  });
});

describe("get_similarity_synopsis", () => {
  it("returns the v2 synopsis with passages and authorities", async () => {
    const { ctx } = makeContext();
    const s = await getSimilaritySynopsis(ctx, { b_number: "B-900101" });
    expect(s.synopsis_version).toBe("v2");
    expect(s.synopsis.grounds_to_distinguish).toEqual(["Ground to distinguish B-900101."]);
    expect(s.similar).toHaveLength(5);
    expect(s.similar[0].matched_passages?.[0].query_excerpt).toMatch(/B-900101/);
    expect(s.similar[0].shared_authorities).toEqual({ far: ["19.502-2"], hhsar: [], us_c: [], gao_refs: [] });
  });

  it("falls back to v1 and can drop passages", async () => {
    const { ctx } = makeContext();
    const s = await getSimilaritySynopsis(ctx, { b_number: "B-900102", include_passages: false });
    expect(s.synopsis_version).toBe("v1");
    expect(s.synopsis.grounds_to_distinguish).toEqual([]);
    expect(s.similar[0]).not.toHaveProperty("matched_passages");
  });

  it("resolves aliases", async () => {
    const { ctx } = makeContext();
    expect((await getSimilaritySynopsis(ctx, { b_number: "B-900201.3" })).b_number).toBe("B-900201.2");
  });

  it("distinguishes a missing synopsis from an unknown decision", async () => {
    const { ctx } = makeContext();
    expect((await toolError(getSimilaritySynopsis(ctx, { b_number: "B-900106.2" }))).message).toBe(
      "No stored similarity synopsis for B-900106.2.",
    );
    expect((await toolError(getSimilaritySynopsis(ctx, { b_number: "B-777777" }))).message).toMatch(/No decision found/);
  });
});

describe("corpus_info", () => {
  it("summarizes the manifest", async () => {
    const { ctx } = makeContext();
    const info = await corpusInfo(ctx);
    expect(info.decisions).toBe(36);
    expect(info.free_text_search).toBe(true);
    expect(info.outcomes.denied).toBe(18);
    expect(info.caveats.length).toBeGreaterThan(0);
    expect((await corpusInfo(makeContext({ ai: false }).ctx)).free_text_search).toBe(false);
  });
});

describe("DataStore", () => {
  it("explains a missing bundle and retries after an upload", async () => {
    const overrides: Record<string, string | null> = { "v1/manifest.json": null };
    const { ctx } = makeContext({ overrides });
    await expect(corpusInfo(ctx)).rejects.toThrow(DataUnavailableError);
    await expect(corpusInfo(ctx)).rejects.toThrow(/DATA_VERSION/);
    delete overrides["v1/manifest.json"];
    expect((await corpusInfo(ctx)).decisions).toBe(36);
  });

  it("rejects an unsupported bundle schema", async () => {
    const manifest = readBundleJson<Manifest>("v1/manifest.json");
    const { ctx } = makeContext({ overrides: { "v1/manifest.json": JSON.stringify({ ...manifest, schema: 99 }) } });
    await expect(corpusInfo(ctx)).rejects.toThrow(/schema 99/);
  });

  it("loads the index and vectors once and caches records", async () => {
    const { ctx, bucket } = makeContext();
    await findSimilarDecisions(ctx, { b_number: "B-900101", outcome: "denied" });
    await findSimilarDecisions(ctx, { b_number: "B-900101", outcome: "denied" });
    expect(bucket.gets.filter((k) => k === "v1/index.json")).toHaveLength(1);
    expect(bucket.gets.filter((k) => k === "v1/vectors.bin")).toHaveLength(1);
    expect(bucket.gets.filter((k) => k === "v1/records/B-900101.json")).toHaveLength(1);
  });

  it("never asks R2 for an unsafe key", async () => {
    const { bucket } = makeContext();
    const store = new DataStore(bucket as unknown as R2Bucket, "v1");
    expect(await store.record("../manifest")).toBeNull();
    expect(await store.synopsis("A/B")).toBeNull();
    expect(bucket.gets).toEqual([]);
  });
});
