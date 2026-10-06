import { describe, expect, it } from "vitest";
import { activeFilters, buildMask, hasFilters, type Filters, type FilterTarget } from "../src/filters";
import { docketBases } from "../src/keys";
import { CorpusIndex } from "../src/store";
import type { IndexFile, Manifest } from "../src/types";
import { readBundleJson } from "./helpers";

const index = new CorpusIndex(readBundleJson<IndexFile>("v1/index.json"));
const manifest = readBundleJson<Manifest>("v1/manifest.json");

function passing(filters: Filters, target?: FilterTarget): string[] {
  const { mask, count } = buildMask(index, filters, target);
  const keys = index.keys.filter((_, r) => mask[r] === 1);
  expect(keys).toHaveLength(count);
  return keys;
}

function rowsWhere(test: (row: number) => boolean): string[] {
  return index.keys.filter((_, r) => test(r));
}

function targetFor(key: string, aliases: string[] = []): FilterTarget {
  const row = index.rowOf(key)!;
  return { row, outcome: index.outcome(row), docket: docketBases([key, ...aliases]) };
}

describe("activeFilters", () => {
  it("drops unset and blank filters and normalizes case", () => {
    expect(activeFilters({ outcome: " Sustained ", agency: "  ", year_min: undefined })).toEqual({ outcome: "sustained" });
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ opposite_outcome: false })).toBe(false);
    expect(hasFilters({ exclude_same_docket: true })).toBe(true);
  });
});

describe("buildMask", () => {
  it("passes everything without filters", () => {
    expect(passing({})).toHaveLength(index.count);
  });

  it("matches outcome exactly, ignoring case", () => {
    expect(passing({ outcome: "SUSTAINED" })).toHaveLength(manifest.outcomes["sustained"]);
    expect(passing({ outcome: "sustained in part" })).toEqual(["B-900203"]);
    expect(passing({ outcome: "sustain" })).toEqual([]);
  });

  it("matches agency as a case-insensitive substring", () => {
    const navy = passing({ agency: "navy" });
    expect(navy.length).toBeGreaterThan(0);
    expect(navy).toEqual(rowsWhere((r) => index.agency(r).includes("Navy")));
  });

  it("applies inclusive year bounds and drops unknown years", () => {
    expect(passing({ year_min: 2020 })).toEqual(rowsWhere((r) => index.year(r) >= 2020));
    expect(passing({ year_max: 1990 }).sort()).toEqual(["B-180101 B-180102", "B-180201"]);
    expect(passing({ year_min: 2014, year_max: 2014 }).sort()).toEqual(["B-900103", "B-900104"]);
  });

  it("matches vehicles from issues and key points", () => {
    expect(passing({ vehicle: "set-aside" })).toHaveLength(manifest.vehicles["set-aside"]);
    expect(passing({ vehicle: "sole-source" })).toHaveLength(manifest.vehicles["sole-source"]);
    expect(passing({ vehicle: "bpa" })).toEqual([]);
  });

  it("matches record type", () => {
    expect(passing({ record_type: "reconsideration" })).toEqual(["B-900201.4"]);
  });

  it("keeps only known, different outcomes for opposite_outcome", () => {
    const keys = passing({ opposite_outcome: true }, targetFor("B-900101"));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const o = index.outcome(index.rowOf(k)!);
      expect(o).not.toBe("denied");
      expect(o).not.toBe("");
    }
  });

  it("drops the target's whole GAO file for exclude_same_docket", () => {
    const keys = passing({ exclude_same_docket: true }, targetFor("B-900201.2", ["B-900201.2", "B-900201.3"]));
    expect(keys).not.toContain("B-900201");
    expect(keys).not.toContain("B-900201.2");
    expect(keys).not.toContain("B-900201.4");
    expect(keys).toHaveLength(index.count - 3);
  });

  it("combines filters", () => {
    expect(passing({ vehicle: "set-aside", outcome: "sustained", year_min: 2010 })).toEqual(["B-900108"]);
  });
});
