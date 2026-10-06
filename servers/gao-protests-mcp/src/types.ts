export interface Env {
  /** R2 bucket holding the bundle written by scripts/build_bundle.py. */
  GAO_DATA: R2Bucket;
  /** Workers AI, used only to embed free-text search queries. */
  AI?: Ai;
  /** R2 key prefix of the bundle to serve (build_bundle.py --data-version). */
  DATA_VERSION?: string;
  /** When set, /mcp requires "Authorization: Bearer <token>" (or ?key=<token>). */
  MCP_AUTH_TOKEN?: string;
}

/** [b_number, cosine similarity, date, outcome_assessed] */
export type NeighborTuple = [string, number | null, string | null, string | null];

export interface DecisionRecord {
  key: string;
  b_numbers?: string | null;
  aliases?: string[] | null;
  date?: string | null;
  year?: number | null;
  agency?: string | null;
  outcome?: string | null;
  outcome_assessed?: string | null;
  record_type?: string | null;
  redacted?: boolean | null;
  protective_order?: boolean | null;
  summary?: string | null;
  issues?: string[] | null;
  reasoning?: string | null;
  outcome_rationale?: string | null;
  key_points?: string[] | null;
  significance?: string | null;
  core_issue?: string | null;
  slug?: string | null;
  neighbors?: {
    reranked?: NeighborTuple[] | null;
    cosine?: NeighborTuple[] | null;
  } | null;
}

export interface MatchedPassage {
  similarity?: number;
  query_excerpt?: string;
  match_excerpt?: string;
}

export interface SynopsisMatch {
  b_number: string;
  similarity?: number | null;
  date?: string | null;
  outcome_assessed?: string | null;
  matched_passages?: MatchedPassage[] | null;
  shared_authorities?: Record<string, string[]> | null;
}

export interface SynopsisEntry {
  b_number: string;
  date?: string | null;
  outcome_assessed?: string | null;
  similar?: SynopsisMatch[] | null;
  synopsis?: {
    shared?: string[];
    differences?: string[];
    grounds_to_distinguish?: string[];
    practical_use?: string;
  } | null;
  synopsis_version?: string;
}

export interface IndexFile {
  schema: number;
  count: number;
  keys: string[];
  dates: (string | null)[];
  years: number[];
  outcome: number[];
  outcomes: string[];
  agency: number[];
  agencies: string[];
  record_type: number[];
  record_types: string[];
  vehicles: number[];
  vehicle_names: string[];
  aliases: Record<string, string>;
}

export interface Manifest {
  schema: number;
  data_version: string;
  built_at: string;
  records: number;
  lookup_keys: number;
  synopsis_objects: number;
  coverage: Record<string, unknown>;
  vectors: {
    file: string;
    count: number;
    dims: number;
    bytes: number;
    embedding_model: string;
    pooling: string;
    quantization_check?: Record<string, unknown>;
  } | null;
  years: { min: number | null; max: number | null; unknown: number };
  outcomes: Record<string, number>;
  record_types: Record<string, number>;
  vehicles: Record<string, number>;
  top_agencies: [string, number][];
}
