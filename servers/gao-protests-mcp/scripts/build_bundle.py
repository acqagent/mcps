#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.24"]
# ///
# SPDX-License-Identifier: MIT
"""Build the R2 data bundle that gao-protests-mcp serves.

Reads the GAO bid protest corpus analysis outputs from SOURCE_DIR and writes
the object tree the Worker reads from R2:

  OUT_DIR/<version>/manifest.json         corpus counts and build info
  OUT_DIR/<version>/index.json            per-decision filter metadata, in vector row order
  OUT_DIR/<version>/vectors.bin           int8 document vectors for search (when the npz is present)
  OUT_DIR/<version>/records/<KEY>.json    analysis record + neighbors, one per lookup key
  OUT_DIR/<version>/synopsis/<KEY>.json   stored similarity synopsis, one per lookup key

Source files (only the first is required):

  analysis_by_bnumber.json                       per-decision analysis, keyed by every B-number
  neighbors_top20.json                           cosine top-20 per decision
  neighbors_top5_v2.json                         LLM re-ranked top-5 per decision
  rerank_issue.json                              one-sentence core issue per decision
  similar_by_bnumber.jsonl (or .json)            synopsis v1
  similar_by_bnumber_v2.jsonl (or .json)         synopsis v2 (wins over v1)
  corpus_doc_vectors.npz                         'vectors', 'keys' and optionally 'slugs'
  corpus_doc_vectors_keys.json                   row-order slugs, used when the npz has none

Usage:
  uv run scripts/build_bundle.py SOURCE_DIR OUT_DIR [--data-version v1] [--force]

Then upload OUT_DIR to the root of the R2 bucket, for example:
  rclone copy OUT_DIR r2:gao-protests --transfers 64 --checkers 64
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import struct
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

BUNDLE_SCHEMA = 1
VECTOR_MAGIC = b"GAOVEC01"
EMBEDDING_MODEL = "BAAI/bge-base-en-v1.5"

# Contracting vehicles the filter understands. A decision carries a vehicle when
# the term appears in its issues or key points (hyphens and spaces are equivalent).
VEHICLES = (
    "idiq",
    "torp",
    "bpa",
    "fss",
    "set-aside",
    "sole-source",
    "task-order",
    "delivery-order",
    "call-order",
)

_DASHES = re.compile("[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d]")
_WHITESPACE = re.compile(r"\s+")
_LETTER_PREFIX = re.compile(r"^([AB])-?(?=\d)")
VALID_CANONICAL = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,63}$")


def canonical_key(value: Any) -> str:
    """Normalize a decision number for lookup. Must match src/keys.ts exactly.

    'b-417297.2' -> 'B-417297.2', 'B 417297' -> 'B-417297', 'B-189045.v2' -> 'B-189045.V2',
    'B-186545 B-187413' -> 'B-186545B-187413'. Dash variants become '-'.
    """
    s = _DASHES.sub("-", "" if value is None else str(value))
    s = _WHITESPACE.sub("", s).upper()
    return _LETTER_PREFIX.sub(r"\1-", s)


class BundleError(Exception):
    """The source data cannot be turned into a consistent bundle."""


# ---------------------------------------------------------------------------
# Source loading
# ---------------------------------------------------------------------------

def _load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                yield entry


def _load_synopsis_file(source: Path, stem: str) -> tuple[str | None, list[dict[str, Any]]]:
    """Read stem.jsonl, else stem.json (keyed object or list). Later entries win."""
    jsonl = source / f"{stem}.jsonl"
    merged = source / f"{stem}.json"
    if jsonl.exists():
        return jsonl.name, list(_iter_jsonl(jsonl))
    if merged.exists():
        data = _load_json(merged)
        if isinstance(data, dict):
            entries = [v for v in data.values() if isinstance(v, dict)]
        elif isinstance(data, list):
            entries = [v for v in data if isinstance(v, dict)]
        else:
            raise BundleError(f"{merged.name}: expected an object or a list")
        return merged.name, entries
    return None, []


def _as_str(value: Any) -> str:
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


def _year_of(record: dict[str, Any]) -> int:
    year = record.get("year")
    if year:
        try:
            return int(year)
        except (TypeError, ValueError):
            pass
    tail = str(record.get("date") or "").strip()[-4:]
    return int(tail) if tail.isdigit() else 0


def _outcome_of(record: dict[str, Any]) -> str:
    return str(record.get("outcome_assessed") or record.get("outcome") or "").strip().lower()


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return list(value) if isinstance(value, (list, tuple)) else [value]


def _vehicle_bits(record: dict[str, Any]) -> int:
    parts = [str(x) for x in _as_list(record.get("issues")) + _as_list(record.get("key_points"))]
    blob = " ".join(parts).lower().replace("-", " ")
    bits = 0
    for i, name in enumerate(VEHICLES):
        if name.replace("-", " ") in blob:
            bits |= 1 << i
    return bits


def _neighbor_list(raw: Any, self_key: str) -> list[list[Any]] | None:
    if not isinstance(raw, list):
        return None
    out: list[list[Any]] = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 2 or not item[0]:
            continue
        b_number = str(item[0])
        if b_number == self_key:
            continue
        try:
            similarity = round(float(item[1]), 4)
        except (TypeError, ValueError):
            similarity = None
        date = item[2] if len(item) > 2 else None
        outcome = item[3] if len(item) > 3 else None
        out.append([b_number, similarity, date, outcome])
    return out


def _core_issue(raw: Any) -> str | None:
    if isinstance(raw, str):
        return raw.strip() or None
    if isinstance(raw, dict):
        for field in ("core_issue", "issue", "text"):
            value = raw.get(field)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _dictionary_encode(values: list[str]) -> tuple[list[int], list[str]]:
    counts = Counter(values)
    vocab = sorted(counts, key=lambda v: (-counts[v], v))
    position = {v: i for i, v in enumerate(vocab)}
    return [position[v] for v in values], vocab


# ---------------------------------------------------------------------------
# Vectors
# ---------------------------------------------------------------------------

def quantize(vectors: Any) -> tuple[Any, Any, Any]:
    """Per-dimension symmetric int8 quantization of L2-normalized rows.

    Returns (normalized float32 rows, int8 rows, float32 per-dimension scales).
    The Worker scores a row as sum_j q[row, j] * (query[j] * scale[j]).
    """
    import numpy as np

    v = np.asarray(vectors, dtype=np.float32)
    if v.ndim != 2:
        raise BundleError(f"vectors must be 2-D, got shape {v.shape}")
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    v = v / norms
    scales = np.abs(v).max(axis=0) / 127.0
    scales[scales == 0] = 1.0
    q = np.clip(np.rint(v / scales), -127, 127).astype(np.int8)
    return v, q, scales.astype(np.float32)


def encode_vectors(q: Any, scales: Any) -> bytes:
    import numpy as np

    n, d = q.shape
    header = VECTOR_MAGIC + struct.pack("<II", n, d)
    return header + np.asarray(scales, dtype="<f4").tobytes() + np.ascontiguousarray(q).tobytes()


def quantization_check(v: Any, q: Any, scales: Any, sample: int, seed: int = 7) -> dict[str, Any]:
    """Compare exact cosine rankings with the int8 scores the Worker computes."""
    import numpy as np

    n = v.shape[0]
    if n < 3 or sample <= 0:
        return {"sample": 0}
    rng = np.random.default_rng(seed)
    rows = rng.choice(n, size=min(sample, n), replace=False)
    deq = q.astype(np.float32) * scales
    k = min(20, n - 1)
    k10 = min(10, k)
    overlap10, overlap20, max_err = [], [], 0.0
    for r in rows:
        exact = v @ v[r]
        approx = deq @ v[r]
        exact[r] = approx[r] = -np.inf
        top_exact = np.argsort(-exact)[:k]
        top_approx = np.argsort(-approx)[:k]
        overlap10.append(len(set(top_exact[:k10]) & set(top_approx[:k10])) / k10)
        overlap20.append(len(set(top_exact) & set(top_approx)) / k)
        finite = np.isfinite(exact)
        max_err = max(max_err, float(np.max(np.abs(exact[finite] - approx[finite]))))
    return {
        "sample": int(len(rows)),
        "overlap_at_10": round(float(np.mean(overlap10)), 4),
        "overlap_at_20": round(float(np.mean(overlap20)), 4),
        "max_abs_error": round(max_err, 5),
    }


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build(
    source: Path,
    out: Path,
    *,
    data_version: str = "v1",
    include_vectors: bool = True,
    check_sample: int = 200,
    built_at: str | None = None,
    force: bool = False,
    log=print,
) -> dict[str, Any]:
    """Build the bundle and return the manifest."""
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", data_version):
        raise BundleError("--data-version may only contain letters, digits, '.', '_' and '-'")
    analysis_path = source / "analysis_by_bnumber.json"
    if not analysis_path.exists():
        raise BundleError(f"missing required file: {analysis_path.name}")

    target = out / data_version
    if target.exists():
        if not force:
            raise BundleError(f"{target} already exists; pass --force to replace it")
        shutil.rmtree(target)

    warnings: Counter[str] = Counter()
    sources: list[str] = [analysis_path.name]

    log(f"reading {analysis_path.name}")
    analysis = _load_json(analysis_path)
    if not isinstance(analysis, dict):
        raise BundleError(f"{analysis_path.name}: expected a JSON object keyed by B-number")

    # Primary keys: vector row order when vectors exist, else analysis order.
    vectors_raw = None
    slugs: list[str | None] | None = None
    npz_path = source / "corpus_doc_vectors.npz"
    if include_vectors and npz_path.exists():
        import numpy as np

        log(f"reading {npz_path.name}")
        z = np.load(npz_path)
        if "vectors" not in z.files or "keys" not in z.files:
            raise BundleError(f"{npz_path.name}: needs 'vectors' and 'keys' arrays")
        primaries = [_as_str(k) for k in z["keys"]]
        vectors_raw = z["vectors"]
        if vectors_raw.shape[0] != len(primaries):
            raise BundleError(f"{npz_path.name}: {vectors_raw.shape[0]} vectors but {len(primaries)} keys")
        if "slugs" in z.files:
            slugs = [_as_str(s) for s in z["slugs"]]
        sources.append(npz_path.name)
    else:
        if include_vectors:
            warnings["no vectors file; search and filtered similarity are disabled"] += 1
        seen: dict[str, None] = {}
        for k, obj in analysis.items():
            if isinstance(obj, dict):
                seen.setdefault(str(obj.get("key") or k), None)
        primaries = list(seen)

    keys_json = source / "corpus_doc_vectors_keys.json"
    if slugs is None and keys_json.exists():
        data = _load_json(keys_json)
        if isinstance(data, dict) and data.get("row_order_keys") == primaries:
            slugs = [str(s) if s else None for s in data.get("row_order_slugs") or []]
            sources.append(keys_json.name)
    if slugs is not None and len(slugs) != len(primaries):
        slugs = None
        warnings["slug list length does not match keys; source URLs omitted"] += 1

    if len(set(primaries)) != len(primaries):
        raise BundleError("duplicate primary keys in vector row order")
    primary_set = set(primaries)

    # Analysis record for each primary: its own entry, else any entry whose 'key' names it.
    by_key_field: dict[str, dict[str, Any]] = {}
    for k, obj in analysis.items():
        if isinstance(obj, dict):
            by_key_field.setdefault(str(obj.get("key") or k), obj)
    records: dict[str, dict[str, Any]] = {}
    for p in primaries:
        obj = analysis.get(p)
        if not isinstance(obj, dict):
            obj = by_key_field.get(p)
        if obj is None:
            warnings["primary key without an analysis record"] += 1
            continue
        records[p] = obj

    # Lookup: canonical form of every analysis key and primary key -> primary key.
    lookup: dict[str, str] = {}
    primary_canon: dict[str, str] = {}
    for p in primaries:
        c = canonical_key(p)
        if not VALID_CANONICAL.match(c):
            raise BundleError(f"primary key {p!r} has no safe canonical form ({c!r})")
        if c in primary_canon:
            raise BundleError(f"primary keys {primary_canon[c]!r} and {p!r} collide as {c!r}")
        primary_canon[c] = p
    for k, obj in analysis.items():
        if not isinstance(obj, dict):
            continue
        dest = str(obj.get("key") or k)
        if dest not in primary_set:
            dest = k if k in primary_set else ""
        if not dest:
            warnings["analysis key whose record is not in the vector row order"] += 1
            continue
        c = canonical_key(k)
        if not VALID_CANONICAL.match(c):
            warnings["analysis key without a safe canonical form"] += 1
            continue
        if c in primary_canon:
            continue  # a primary key always resolves to itself
        if lookup.get(c, dest) != dest:
            warnings["alias claimed by two decisions (first kept)"] += 1
            continue
        lookup[c] = dest
    aliases = {c: p for c, p in lookup.items()}
    lookup.update(primary_canon)

    def to_primary(key: Any) -> str | None:
        k = str(key)
        if k in primary_set:
            return k
        return lookup.get(canonical_key(k))

    # Neighbors and core issues.
    def load_keyed(name: str) -> dict[str, Any]:
        path = source / name
        if not path.exists():
            warnings[f"missing optional file {name}"] += 1
            return {}
        sources.append(name)
        log(f"reading {name}")
        data = _load_json(path)
        if not isinstance(data, dict):
            raise BundleError(f"{name}: expected a JSON object keyed by B-number")
        keyed: dict[str, Any] = {}
        for k, value in data.items():
            p = to_primary(k)
            if p is None:
                warnings[f"{name}: key not in corpus"] += 1
                continue
            if p == k or p not in keyed:
                keyed[p] = value
        return keyed

    cosine = load_keyed("neighbors_top20.json")
    reranked = load_keyed("neighbors_top5_v2.json")
    issues = load_keyed("rerank_issue.json")

    # Synopses: v1 first, v2 layered on top. Entries without a synopsis are ignored.
    synopses: dict[str, dict[str, Any]] = {}
    synopsis_versions: Counter[str] = Counter()
    for stem, version in (("similar_by_bnumber", "v1"), ("similar_by_bnumber_v2", "v2")):
        name, entries = _load_synopsis_file(source, stem)
        if name is None:
            continue
        sources.append(name)
        log(f"reading {name}")
        for entry in entries:
            if not entry.get("synopsis"):
                continue
            p = to_primary(entry.get("b_number"))
            if p is None:
                warnings[f"{name}: b_number not in corpus"] += 1
                continue
            synopses[p] = {**entry, "synopsis_version": version}
    for entry in synopses.values():
        synopsis_versions[entry["synopsis_version"]] += 1

    # Per-row metadata for filters.
    dates: list[str | None] = []
    years: list[int] = []
    outcomes: list[str] = []
    agencies: list[str] = []
    record_types: list[str] = []
    vehicle_bits: list[int] = []
    for p in primaries:
        rec = records.get(p, {})
        date = rec.get("date")
        dates.append(str(date) if date else None)
        years.append(_year_of(rec))
        outcomes.append(_outcome_of(rec))
        agencies.append(str(rec.get("agency") or "").strip())
        record_types.append(str(rec.get("record_type") or "").strip().lower())
        vehicle_bits.append(_vehicle_bits(rec))

    outcome_idx, outcome_vocab = _dictionary_encode(outcomes)
    agency_idx, agency_vocab = _dictionary_encode(agencies)
    type_idx, type_vocab = _dictionary_encode(record_types)

    index = {
        "schema": BUNDLE_SCHEMA,
        "count": len(primaries),
        "keys": primaries,
        "dates": dates,
        "years": years,
        "outcome": outcome_idx,
        "outcomes": outcome_vocab,
        "agency": agency_idx,
        "agencies": agency_vocab,
        "record_type": type_idx,
        "record_types": type_vocab,
        "vehicles": vehicle_bits,
        "vehicle_names": list(VEHICLES),
        "aliases": dict(sorted(aliases.items())),
    }

    # Vectors.
    vectors_info: dict[str, Any] | None = None
    vector_bytes: bytes | None = None
    if vectors_raw is not None:
        log("quantizing vectors")
        v, q, scales = quantize(vectors_raw)
        vector_bytes = encode_vectors(q, scales)
        check = quantization_check(v, q, scales, check_sample)
        vectors_info = {
            "file": "vectors.bin",
            "count": int(q.shape[0]),
            "dims": int(q.shape[1]),
            "bytes": len(vector_bytes),
            "quantization": "int8, symmetric per-dimension scale",
            "embedding_model": EMBEDDING_MODEL,
            "pooling": "mean",
            "quantization_check": check,
        }
        log(f"quantization check: {check}")

    # Write records and synopses under every lookup key.
    target.mkdir(parents=True)
    (target / "records").mkdir()
    (target / "synopsis").mkdir()
    row_of = {p: i for i, p in enumerate(primaries)}
    written_records = written_synopses = 0
    with_reranked = with_cosine = with_issue = 0
    record_payloads: dict[str, bytes] = {}
    for p in primaries:
        rec = records.get(p)
        if rec is None:
            continue
        slug = slugs[row_of[p]] if slugs else None
        payload = dict(rec)
        payload["key"] = p
        payload["core_issue"] = _core_issue(issues.get(p))
        payload["slug"] = slug or None
        payload["neighbors"] = {
            "reranked": _neighbor_list(reranked.get(p), p),
            "cosine": _neighbor_list(cosine.get(p), p),
        }
        with_reranked += bool(payload["neighbors"]["reranked"])
        with_cosine += bool(payload["neighbors"]["cosine"])
        with_issue += bool(payload["core_issue"])
        record_payloads[p] = _dumps(payload)

    synopsis_payloads = {p: _dumps(entry) for p, entry in synopses.items() if p in record_payloads}
    for c, p in sorted(lookup.items()):
        body = record_payloads.get(p)
        if body is None:
            continue
        (target / "records" / f"{c}.json").write_bytes(body)
        written_records += 1
        syn = synopsis_payloads.get(p)
        if syn is not None:
            (target / "synopsis" / f"{c}.json").write_bytes(syn)
            written_synopses += 1

    (target / "index.json").write_bytes(_dumps(index))
    if vector_bytes is not None:
        (target / "vectors.bin").write_bytes(vector_bytes)

    known_years = [y for y in years if y]
    manifest = {
        "schema": BUNDLE_SCHEMA,
        "data_version": data_version,
        "built_at": built_at or _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat(),
        "records": len(record_payloads),
        "lookup_keys": written_records,
        "synopsis_objects": written_synopses,
        "coverage": {
            "reranked_neighbors": with_reranked,
            "cosine_neighbors": with_cosine,
            "core_issue": with_issue,
            "synopsis": {"total": sum(synopsis_versions.values()), **dict(sorted(synopsis_versions.items()))},
        },
        "vectors": vectors_info,
        "years": {
            "min": min(known_years) if known_years else None,
            "max": max(known_years) if known_years else None,
            "unknown": len(years) - len(known_years),
        },
        "outcomes": _counts(o or "unknown" for o in outcomes),
        "record_types": _counts(t or "unknown" for t in record_types),
        "vehicles": {name: sum(1 for b in vehicle_bits if b & (1 << i)) for i, name in enumerate(VEHICLES)},
        "top_agencies": [[a, n] for a, n in Counter(a for a in agencies if a).most_common(50)],
        "sources": sorted(set(sources)),
        "warnings": dict(sorted(warnings.items())),
    }
    (target / "manifest.json").write_bytes(_dumps(manifest, indent=2))

    log(
        f"wrote {written_records} record objects, {written_synopses} synopsis objects, "
        f"{len(primaries)} index rows{', vectors' if vector_bytes else ''} to {target}"
    )
    for message, count in sorted(warnings.items()):
        log(f"warning: {message} ({count})")
    return manifest


def _counts(values: Iterable[str]) -> dict[str, int]:
    counts = Counter(values)
    return {k: counts[k] for k in sorted(counts, key=lambda v: (-counts[v], v))}


def _dumps(obj: Any, indent: int | None = None) -> bytes:
    if indent:
        text = json.dumps(obj, ensure_ascii=False, indent=indent)
    else:
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return text.encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="directory holding the analysis outputs")
    parser.add_argument("out", type=Path, help="bundle output directory (upload its contents to R2)")
    parser.add_argument("--data-version", default="v1", help="R2 key prefix; must match DATA_VERSION in wrangler.jsonc")
    parser.add_argument("--no-vectors", action="store_true", help="skip vectors.bin (disables search)")
    parser.add_argument("--check-sample", type=int, default=200, help="rows used to check int8 ranking fidelity")
    parser.add_argument("--built-at", default=None, help="override the build timestamp (ISO 8601)")
    parser.add_argument("--force", action="store_true", help="replace an existing OUT_DIR/<version>")
    args = parser.parse_args(argv)

    if args.built_at is None and os.environ.get("SOURCE_DATE_EPOCH"):
        epoch = int(os.environ["SOURCE_DATE_EPOCH"])
        args.built_at = _dt.datetime.fromtimestamp(epoch, _dt.timezone.utc).isoformat()
    try:
        build(
            args.source,
            args.out,
            data_version=args.data_version,
            include_vectors=not args.no_vectors,
            check_sample=args.check_sample,
            built_at=args.built_at,
            force=args.force,
        )
    except BundleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
