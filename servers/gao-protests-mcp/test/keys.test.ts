import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalKey, docketBases, isValidCanonical, lookupCandidates } from "../src/keys";
import { FIXTURES } from "./helpers";

// Shared with scripts/test_build_bundle.py so both implementations stay identical.
const CASES: [string, string][] = JSON.parse(readFileSync(join(FIXTURES, "canonical_cases.json"), "utf8"));

describe("canonicalKey", () => {
  it.each(CASES)("%j -> %j", (input, expected) => {
    expect(canonicalKey(input)).toBe(expected);
  });

  it("only accepts safe R2 key characters", () => {
    expect(isValidCanonical("B-417297.2")).toBe(true);
    expect(isValidCanonical("B-189045.V2")).toBe(true);
    expect(isValidCanonical("../B-1")).toBe(false);
    expect(isValidCanonical("B-1/2")).toBe(false);
    expect(isValidCanonical("")).toBe(false);
    expect(isValidCanonical("B".repeat(65))).toBe(false);
  });
});

describe("lookupCandidates", () => {
  it("tries the whole input, then a decision number inside it", () => {
    expect(lookupCandidates("b-420562")).toEqual(["B-420562"]);
    expect(lookupCandidates("GAO decision B-420562 (May 2022)")).toEqual(["B-420562"]);
    expect(lookupCandidates("see B\u2011417297.2, B-417297.3")).toEqual(["B-417297.2"]);
    expect(lookupCandidates("A-76944")).toEqual(["A-76944"]);
  });

  it("skips input that cannot be an R2 key", () => {
    expect(lookupCandidates("../../etc/passwd")).toEqual([]);
  });
});

describe("docketBases", () => {
  it("reduces keys to GAO file numbers", () => {
    expect([...docketBases(["B-417297.2"])]).toEqual(["B-417297"]);
    expect([...docketBases(["B-186545 B-187413.v2"])]).toEqual(["B-186545", "B-187413"]);
    expect([...docketBases(["B-244663A", "a-76944.3"])]).toEqual(["B-244663", "A-76944"]);
    expect([...docketBases(["459643"])]).toEqual([]);
  });
});
