// Decision-number normalization. canonicalKey() must stay identical to
// canonical_key() in scripts/build_bundle.py: R2 object names are built from it.

const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
const VALID_CANONICAL = /^[A-Z0-9][A-Z0-9.\-]{0,63}$/;
const NUMBER_IN_TEXT = /\b([AB])\s*-?\s*(\d{4,7}(?:\.\d{1,3})?)/i;

/**
 * 'b-417297.2' -> 'B-417297.2', 'B 417297' -> 'B-417297', 'B-189045.v2' -> 'B-189045.V2',
 * 'B-186545 B-187413' -> 'B-186545B-187413'. Dash variants become '-'.
 */
export function canonicalKey(value: string): string {
  const s = String(value ?? "")
    .replace(DASHES, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
  return s.replace(/^([AB])-?(?=\d)/, "$1-");
}

export function isValidCanonical(canonical: string): boolean {
  return VALID_CANONICAL.test(canonical);
}

/**
 * Canonical keys to try for user input: the whole string first, then the first
 * B-/A-number found inside it (so "GAO decision B-420562 (2022)" still resolves).
 */
export function lookupCandidates(input: string): string[] {
  const out: string[] = [];
  const whole = canonicalKey(input);
  if (isValidCanonical(whole)) out.push(whole);
  const match = String(input ?? "")
    .replace(DASHES, "-")
    .match(NUMBER_IN_TEXT);
  if (match) {
    const found = `${match[1].toUpperCase()}-${match[2]}`;
    if (!out.includes(found)) out.push(found);
  }
  return out;
}

/** GAO file numbers a key belongs to: 'B-417297.2' -> {'B-417297'}. */
export function docketBases(keys: Iterable<string>): Set<string> {
  const bases = new Set<string>();
  for (const key of keys) {
    for (const m of canonicalKey(key).matchAll(/([AB])-(\d+)/g)) {
      bases.add(`${m[1]}-${m[2]}`);
    }
  }
  return bases;
}
