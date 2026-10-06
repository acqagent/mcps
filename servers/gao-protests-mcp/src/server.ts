import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import { RECORD_TYPES, VEHICLES } from "./filters";
import { DataStore, DataUnavailableError } from "./store";
import {
  ToolError,
  corpusInfo,
  findSimilarDecisions,
  getDecision,
  getSimilaritySynopsis,
  searchDecisions,
  type ToolContext,
} from "./tools";
import type { Env } from "./types";
import { VERSION } from "./version";

export const DEFAULT_DATA_VERSION = "v1";

const INSTRUCTIONS = `Searches and compares GAO bid protest decisions using precomputed analyses of the decisions.

- search_decisions: find decisions by topic or fact pattern in plain language.
- get_decision: the analysis of one decision by B-number (summary, issues, reasoning, key points, outcome).
- find_similar_decisions: the decisions closest to a given one, with optional filters.
- get_similarity_synopsis: a stored memo comparing a decision with its five closest matches.
- corpus_info: coverage, valid filter values, and caveats.

outcome_assessed is the disposition read from the decision text and is authoritative. Summaries, issues,
key points and synopses are model-generated, so cite B-numbers and confirm key facts in the decision
(source_url) before relying on them. Pre-1990 decisions are OCR scans with occasional noise.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const bNumber = z
  .string()
  .min(1)
  .max(200)
  .describe("GAO decision number, for example B-420562 or B-417297.2. A-numbers (A-76944) work too.");

const corpusFilters = {
  outcome: z
    .string()
    .max(60)
    .optional()
    .describe("Keep decisions with this outcome_assessed, for example denied, sustained, dismissed (see corpus_info)."),
  agency: z.string().max(200).optional().describe("Keep decisions whose agency contains this text, for example Navy."),
  year_min: z.number().int().min(1900).max(2100).optional().describe("Earliest decision year, inclusive."),
  year_max: z.number().int().min(1900).max(2100).optional().describe("Latest decision year, inclusive."),
  vehicle: z
    .enum(VEHICLES)
    .optional()
    .describe("Keep decisions whose issues or key points mention this contracting vehicle."),
  record_type: z.enum(RECORD_TYPES).optional().describe("Keep only this kind of record."),
};

function ok(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function fail(message: string, details: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, ...details }, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message, err.details);
    if (err instanceof DataUnavailableError) return fail(err.message);
    console.error("tool failed", err);
    return fail("Internal error while reading the corpus. Try again; if it persists, check the Worker logs.");
  }
}

export function createServer(env: Env): McpServer {
  const ctx: ToolContext = {
    store: new DataStore(env.GAO_DATA, env.DATA_VERSION || DEFAULT_DATA_VERSION),
    ai: env.AI,
  };
  const server = new McpServer(
    { name: "gao-protests", title: "GAO Bid Protest Decisions", version: VERSION },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  server.registerTool(
    "search_decisions",
    {
      title: "Search Decisions",
      description:
        "Semantic search over GAO bid protest decisions. Describe a legal issue or fact pattern in plain " +
        "language (for example 'bid bond missing at bid opening' or 'agency failed to evaluate price " +
        "realism'). Returns the closest decisions with similarity score, date, agency, outcome_assessed, " +
        "a one-sentence core issue, summary and issues. Optional filters narrow the corpus before ranking.",
      inputSchema: {
        query: z.string().min(3).max(2000).describe("What to look for, in plain language."),
        limit: z.number().int().min(1).max(25).optional().describe("Number of results (default 10)."),
        ...corpusFilters,
      },
      annotations: { title: "Search Decisions", ...READ_ONLY },
    },
    async (args) => run(() => searchDecisions(ctx, args)),
  );

  server.registerTool(
    "get_decision",
    {
      title: "Get Decision",
      description:
        "The analysis of one GAO bid protest decision by B-number: date, agency, outcome_assessed " +
        "(authoritative disposition from the decision text), summary, issues, reasoning, outcome rationale, " +
        "key points, the GAO source URL when known, and its five most similar decisions. Consolidated " +
        "decisions resolve from any of their B-numbers.",
      inputSchema: { b_number: bNumber },
      annotations: { title: "Get Decision", ...READ_ONLY },
    },
    async (args) => run(() => getDecision(ctx, args)),
  );

  server.registerTool(
    "find_similar_decisions",
    {
      title: "Find Similar Decisions",
      description:
        "Decisions most similar to a given B-number. Without filters, the first five are re-ranked by an " +
        "LLM for the same core legal issue (better than raw similarity) and the rest follow by document " +
        "similarity. With filters, every decision that passes them is ranked by document similarity. " +
        "Use opposite_outcome to find contrary results and exclude_same_docket to skip the same protest's " +
        "other decisions.",
      inputSchema: {
        b_number: bNumber,
        limit: z.number().int().min(1).max(20).optional().describe("Number of results (default 5)."),
        ...corpusFilters,
        opposite_outcome: z
          .boolean()
          .optional()
          .describe("Keep only decisions whose outcome differs from the target's."),
        exclude_same_docket: z
          .boolean()
          .optional()
          .describe("Drop decisions sharing the target's GAO file number (B-417297, B-417297.2, ...)."),
      },
      annotations: { title: "Find Similar Decisions", ...READ_ONLY },
    },
    async (args) => run(() => findSimilarDecisions(ctx, args)),
  );

  server.registerTool(
    "get_similarity_synopsis",
    {
      title: "Get Similarity Synopsis",
      description:
        "A stored comparison of a decision with its five closest matches: shared issues, differences, " +
        "grounds to distinguish, practical use, matched passage pairs from the full texts, and FAR, U.S.C. " +
        "and GAO citations that appear in both decisions. Not every decision has one; if missing, use " +
        "find_similar_decisions.",
      inputSchema: {
        b_number: bNumber,
        include_passages: z
          .boolean()
          .optional()
          .describe("Include matched passage excerpts for each match (default true)."),
      },
      annotations: { title: "Get Similarity Synopsis", ...READ_ONLY },
    },
    async (args) => run(() => getSimilaritySynopsis(ctx, args)),
  );

  server.registerTool(
    "corpus_info",
    {
      title: "Corpus Info",
      description:
        "Corpus coverage and valid filter values: decision counts by outcome and record type, year range, " +
        "contracting vehicles, most common agencies, how each filter matches, and known data caveats.",
      inputSchema: {},
      annotations: { title: "Corpus Info", ...READ_ONLY },
    },
    async () => run(() => corpusInfo(ctx)),
  );

  return server;
}
