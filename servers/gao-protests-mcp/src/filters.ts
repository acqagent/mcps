// Corpus filters, evaluated as a row mask over index.json.

import type { CorpusIndex } from "./store";

export const VEHICLES = [
  "idiq",
  "torp",
  "bpa",
  "fss",
  "set-aside",
  "sole-source",
  "task-order",
  "delivery-order",
  "call-order",
] as const;
export type Vehicle = (typeof VEHICLES)[number];

export const RECORD_TYPES = ["decision", "reconsideration", "advisory_opinion", "letter", "other", "report"] as const;

export interface CorpusFilters {
  outcome?: string;
  agency?: string;
  year_min?: number;
  year_max?: number;
  vehicle?: Vehicle;
  record_type?: string;
}

export interface TargetFilters {
  opposite_outcome?: boolean;
  exclude_same_docket?: boolean;
}

export type Filters = CorpusFilters & TargetFilters;

/** The decision that similarity filters are relative to. */
export interface FilterTarget {
  row?: number;
  outcome: string;
  docket: Set<string>;
}

/** Only the filters that are actually set, for echoing back to the caller. */
export function activeFilters(f: Filters): Partial<Filters> {
  const out: Partial<Filters> = {};
  if (f.outcome?.trim()) out.outcome = f.outcome.trim().toLowerCase();
  if (f.agency?.trim()) out.agency = f.agency.trim();
  if (f.year_min !== undefined) out.year_min = f.year_min;
  if (f.year_max !== undefined) out.year_max = f.year_max;
  if (f.vehicle) out.vehicle = f.vehicle;
  if (f.record_type?.trim()) out.record_type = f.record_type.trim().toLowerCase();
  if (f.opposite_outcome) out.opposite_outcome = true;
  if (f.exclude_same_docket) out.exclude_same_docket = true;
  return out;
}

export function hasFilters(f: Filters): boolean {
  return Object.keys(activeFilters(f)).length > 0;
}

/** A message explaining why the filters cannot match anything, or null when they are usable. */
export function filterProblem(index: CorpusIndex, filters: Filters): string | null {
  const f = activeFilters(filters);
  const file = index.file;
  if (f.outcome !== undefined && !file.outcomes.includes(f.outcome)) {
    const known = file.outcomes.filter(Boolean);
    return `Unknown outcome "${f.outcome}". Use one of: ${known.join(", ")}.`;
  }
  if (f.agency !== undefined) {
    const needle = f.agency.toLowerCase();
    if (!file.agencies.some((a) => a.toLowerCase().includes(needle))) {
      const examples = file.agencies.filter(Boolean).slice(0, 8);
      return `No agency name contains "${f.agency}". Common agencies: ${examples.join("; ")}.`;
    }
  }
  if (f.year_min !== undefined && f.year_max !== undefined && f.year_min > f.year_max) {
    return `year_min (${f.year_min}) is after year_max (${f.year_max}).`;
  }
  return null;
}

/**
 * Rows that pass every active filter.
 *  - outcome: exact match on outcome_assessed (falls back to the scraped outcome), case-insensitive
 *  - agency: case-insensitive substring of the agency name
 *  - year_min / year_max: inclusive; decisions with no known year are excluded when either is set
 *  - vehicle: the term appears in the decision's issues or key points
 *  - record_type: exact match
 *  - opposite_outcome: known outcome that differs from the target's
 *  - exclude_same_docket: drops decisions sharing a GAO file number with the target
 *    (B-417297, B-417297.2, B-417297.3 ...), including the target's aliases
 */
export function buildMask(index: CorpusIndex, filters: Filters, target?: FilterTarget): { mask: Uint8Array; count: number } {
  const f = activeFilters(filters);
  const file = index.file;
  const n = index.count;
  const mask = new Uint8Array(n).fill(1);

  const allowIds = (vocab: string[], test: (value: string) => boolean): Uint8Array => {
    const ok = new Uint8Array(vocab.length);
    vocab.forEach((value, i) => {
      if (test(value)) ok[i] = 1;
    });
    return ok;
  };

  const outcomeOk = f.outcome !== undefined ? allowIds(file.outcomes, (v) => v === f.outcome) : null;
  const needle = f.agency?.toLowerCase();
  const agencyOk = needle !== undefined ? allowIds(file.agencies, (v) => v.toLowerCase().includes(needle)) : null;
  const typeOk = f.record_type !== undefined ? allowIds(file.record_types, (v) => v === f.record_type) : null;
  const vehicleBit = f.vehicle !== undefined ? file.vehicle_names.indexOf(f.vehicle) : -1;
  const yearMin = f.year_min;
  const yearMax = f.year_max;
  const yearFilter = yearMin !== undefined || yearMax !== undefined;
  const targetOutcome = target?.outcome.toLowerCase() ?? "";

  let count = 0;
  for (let r = 0; r < n; r++) {
    let ok =
      (!outcomeOk || outcomeOk[file.outcome[r]] === 1) &&
      (!agencyOk || agencyOk[file.agency[r]] === 1) &&
      (!typeOk || typeOk[file.record_type[r]] === 1);
    if (ok && f.vehicle !== undefined) {
      ok = vehicleBit >= 0 && (file.vehicles[r] & (1 << vehicleBit)) !== 0;
    }
    if (ok && yearFilter) {
      const y = file.years[r] || 0;
      ok = y !== 0 && (yearMin === undefined || y >= yearMin) && (yearMax === undefined || y <= yearMax);
    }
    if (ok && f.opposite_outcome && target) {
      const o = index.outcome(r);
      ok = o !== "" && o !== targetOutcome;
    }
    if (ok && f.exclude_same_docket && target) {
      ok = r !== target.row && !index.docketOf(r).some((b) => target.docket.has(b));
    }
    mask[r] = ok ? 1 : 0;
    if (ok) count++;
  }
  return { mask, count };
}
