#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.24"]
# ///
# SPDX-License-Identifier: MIT
"""Generate the synthetic test bundle in test/fixtures/.

Writes synthetic source files in the same formats as the real corpus analysis,
runs build_bundle.py on them, and stores the result in test/fixtures/bundle/.
Every decision number, party, and summary here is fictional (B-9xxxxx numbers
and invented company names). The real corpus is never read.

  uv run scripts/make_fixture.py           # regenerate test/fixtures
  uv run scripts/make_fixture.py --check   # exit 1 if the checked-in fixture is stale
"""

from __future__ import annotations

import argparse
import filecmp
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_bundle  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "test" / "fixtures"
DIMS = 768
BUILT_AT = "2026-01-01T00:00:00+00:00"

TOPICS: dict[str, dict[str, Any]] = {
    "set_aside": {
        "query": "small business set-aside rule of two for delivery orders under an IDIQ contract",
        "issues": ["Small business set-aside", "IDIQ delivery order", "Rule of two analysis"],
        "points": [
            "Agencies may set aside orders under multiple-award contracts when the rule of two is met.",
            "Market research must support a reasonable expectation of two responsible small business offers.",
        ],
        "summary": "{p} protested the {a}'s decision to set aside a delivery order for small businesses. GAO {o} the protest after reviewing the agency's market research.",
        "agencies": ["Department of the Navy", "Department of the Army", "Department of the Navy"],
    },
    "evaluation": {
        "query": "unreasonable past performance evaluation and best-value tradeoff",
        "issues": ["Past performance evaluation", "Best-value tradeoff", "Technical evaluation"],
        "points": [
            "GAO will not substitute its judgment for the agency's if the evaluation was reasonable and documented.",
            "A tradeoff decision must be consistent with the solicitation's stated evaluation criteria.",
        ],
        "summary": "{p} challenged the {a}'s evaluation of past performance and the resulting best-value tradeoff. GAO {o} the protest.",
        "agencies": ["Department of Veterans Affairs", "Centers for Medicare & Medicaid Services", "Department of the Air Force"],
    },
    "bid_bond": {
        "query": "bid bond missing when bids were opened, sealed bid responsiveness",
        "issues": ["Bid bond", "Responsiveness of sealed bid", "Bid opening"],
        "points": [
            "A bid bond requirement is a material term; a bid without the required bond is nonresponsive.",
            "Responsiveness is determined at bid opening from the bid documents alone.",
        ],
        "summary": "{p} protested rejection of its sealed bid by the {a} for a defective bid bond. GAO {o} the protest.",
        "agencies": ["General Services Administration", "Department of the Army", "Department of the Interior"],
    },
    "oci": {
        "query": "organizational conflict of interest, unequal access to information",
        "issues": ["Organizational conflict of interest", "Unequal access to information", "Task order award"],
        "points": [
            "Contracting officers must identify and mitigate significant potential conflicts of interest.",
            "GAO reviews OCI determinations for reasonableness based on hard facts.",
        ],
        "summary": "{p} argued that the awardee had an organizational conflict of interest in a {a} task order competition. GAO {o} the protest.",
        "agencies": ["Department of Homeland Security", "General Services Administration", "Department of Energy"],
    },
    "timeliness": {
        "query": "untimely protest dismissed, solicitation improprieties before closing time",
        "issues": ["Timeliness of protest", "Solicitation improprieties", "Sole-source justification"],
        "points": [
            "Protests of apparent solicitation improprieties must be filed before the closing time for proposals.",
            "Other protest grounds must be filed within 10 days of when the basis was known.",
        ],
        "summary": "{p} protested the {a}'s sole-source award. GAO {o} the protest as untimely.",
        "agencies": ["Department of Defense", "Department of Transportation", "Department of Commerce"],
    },
}

PARTIES = [
    "Acme Shipyard LLC", "Blue Heron Logistics", "Cobalt Analytics Inc.", "Delta Fabrication Co.",
    "Evergreen Health Partners", "Falcon Systems Group", "Granite Construction Services", "Harbor Point Medical",
    "Ironwood Federal", "Juniper Research Corp.",
]

# (key, topic, outcome, date, record_type, extra analysis keys pointing to it)
DECISIONS: list[tuple[str, str, str, str | None, str, list[str]]] = [
    ("B-900101", "set_aside", "denied", "May 25, 2022", "decision", []),
    ("B-900102", "set_aside", "sustained", "October 8, 2008", "decision", []),
    ("B-900103", "set_aside", "denied", "December 01, 2014", "decision", []),
    ("B-900104", "set_aside", "denied", "March 5, 2014", "decision", []),
    ("B-900105", "set_aside", "denied", "December 23, 2020", "decision", []),
    ("B-900106.2", "set_aside", "denied", "September 15, 2025", "decision", []),
    ("B-900107", "set_aside", "dismissed", "July 2, 2019", "decision", []),
    ("B-900108", "set_aside", "sustained", "January 30, 2017", "decision", []),
    ("B-900201", "evaluation", "denied", "April 4, 2023", "decision", []),
    ("B-900201.2", "evaluation", "sustained", "August 14, 2023", "decision", ["B-900201.3"]),
    ("B-900201.4", "evaluation", "denied", "November 20, 2023", "reconsideration", []),
    ("B-900202", "evaluation", "denied", "June 11, 2018", "decision", []),
    ("B-900203", "evaluation", "sustained in part", "February 27, 2021", "decision", []),
    ("B-900204", "evaluation", "denied", "September 9, 2016", "decision", []),
    ("B-900205", "evaluation", "denied", "May 5, 2024", "decision", []),
    ("B-900206", "evaluation", "sustained", "March 18, 2012", "decision", []),
    ("B-180001", "bid_bond", "denied", None, "decision", []),
    ("B-180001.v2", "bid_bond", "denied", None, "decision", []),
    ("A-70001", "bid_bond", "", None, "decision", []),
    ("400001", "bid_bond", "", None, "letter", []),
    ("B-180101 B-180102", "bid_bond", "sustained", "March 3, 1985", "decision", []),
    ("B-180201", "bid_bond", "denied", "June 30, 1979", "decision", []),
    ("B-180202", "bid_bond", "dismissed", None, "advisory_opinion", []),
    ("B-900301", "oci", "sustained", "July 22, 2015", "decision", []),
    ("B-900301A", "oci", "denied", "July 23, 2015", "decision", []),
    ("B-900302", "oci", "denied", "October 3, 2019", "decision", []),
    ("B-900303", "oci", "denied", "January 14, 2022", "decision", []),
    ("B-900304", "oci", "sustained", "August 8, 2010", "decision", []),
    ("B-900305", "oci", "denied", "April 19, 2024", "decision", []),
    ("B-900306", "oci", "dismissed", "December 12, 2013", "decision", []),
    ("B-900401", "timeliness", "dismissed", "February 2, 2021", "decision", []),
    ("B-900402", "timeliness", "dismissed", "March 9, 2018", "decision", []),
    ("B-900403", "timeliness", "denied", "May 30, 2011", "decision", []),
    ("B-900404", "timeliness", "dismissed", "September 1, 2023", "decision", []),
    ("B-900405", "timeliness", "dismissed", "November 15, 2009", "decision", []),
    ("B-900406", "timeliness", "sustained", "June 6, 2016", "decision", []),
]

# Records whose analysis 'year' is missing but whose date carries one.
YEAR_FROM_DATE_ONLY = {"B-180101 B-180102", "B-180201"}


def _record(i: int, key: str, topic: str, outcome: str, date: str | None, record_type: str,
            extra: list[str]) -> dict[str, Any]:
    spec = TOPICS[topic]
    party = PARTIES[i % len(PARTIES)]
    agency = spec["agencies"][i % len(spec["agencies"])]
    verb = {"": "resolved", "sustained in part": "sustained in part"}.get(outcome, outcome)
    year = None
    if date and key not in YEAR_FROM_DATE_ONLY:
        year = int(date[-4:])
    issues = list(spec["issues"])
    if i % 3 == 0:
        issues = issues[:2]
    return {
        "b_numbers": ", ".join([key, *extra]),
        "key": key,
        "aliases": [key, *extra],
        "date": date,
        "year": year,
        "agency": agency if date else None,
        "outcome": outcome if date and i % 4 else None,
        "redacted": i % 5 == 0,
        "protective_order": i % 2 == 0,
        "record_type": record_type,
        "outcome_assessed": outcome or None,
        "summary": spec["summary"].format(p=party, a=agency, o=verb),
        "issues": issues,
        "reasoning": f"Synthetic reasoning for fixture decision {key}.",
        "outcome_rationale": f"Synthetic outcome rationale for fixture decision {key}.",
        "key_points": list(spec["points"]),
        "significance": "",
    }


def generate_source(source: Path) -> dict[str, list[float]]:
    """Write the synthetic source files and return query text -> embedding."""
    rng = np.random.default_rng(20261006)
    centroids = {t: rng.standard_normal(DIMS) for t in TOPICS}
    for t, c in centroids.items():
        centroids[t] = c / np.linalg.norm(c)

    keys = [d[0] for d in DECISIONS]
    vectors = []
    analysis: dict[str, Any] = {}
    for i, (key, topic, outcome, date, record_type, extra) in enumerate(DECISIONS):
        v = centroids[topic] + 0.03 * rng.standard_normal(DIMS)
        vectors.append(v / np.linalg.norm(v))
        rec = _record(i, key, topic, outcome, date, record_type, extra)
        analysis[key] = rec
        for alias in extra:
            analysis[alias] = rec
    matrix = np.asarray(vectors, dtype=np.float32)
    # A decision with an analysis entry but no vector row: the build must warn and skip it.
    analysis["B-999999"] = _record(99, "B-999999", "oci", "denied", "May 1, 2020", "decision", [])

    slugs = [k.lower().replace(" ", "_") for k in keys]
    slugs[keys.index("B-900201.2")] = "b-900201.2_b-900201.3"
    np.savez(source / "corpus_doc_vectors.npz", vectors=matrix, keys=np.array(keys), slugs=np.array(slugs))

    sims = matrix @ matrix.T
    np.fill_diagonal(sims, -np.inf)
    by_key = {k: analysis[k] for k in keys}

    def tup(j: int, score: float) -> list[Any]:
        rec = by_key[keys[j]]
        return [keys[j], round(float(score), 4), rec["date"], rec["outcome_assessed"]]

    top20: dict[str, Any] = {}
    top5_v2: dict[str, Any] = {}
    core: dict[str, Any] = {}
    for i, key in enumerate(keys):
        order = np.argsort(-sims[i])[:20]
        top20[key] = [tup(j, sims[i, j]) for j in order]
        if i % 6 != 5:
            first5 = list(order[:5])
            first5[0], first5[2] = first5[2], first5[0]  # the re-ranker reorders
            top5_v2[key] = [tup(j, sims[i, j]) for j in first5]
            core[key] = f"Whether the agency acted reasonably on {TOPICS[DECISIONS[i][1]]['issues'][0].lower()}."
    # Neighbor files keyed by an alias must resolve to the primary.
    top20["B-900201.3"] = top20.pop("B-900201.2")
    _write_json(source / "neighbors_top20.json", top20)
    _write_json(source / "neighbors_top5_v2.json", top5_v2)
    _write_json(source / "rerank_issue.json", core)
    _write_json(source / "analysis_by_bnumber.json", analysis)

    def synopsis_entry(i: int, version: str) -> dict[str, Any]:
        key = keys[i]
        similar = []
        for j in np.argsort(-sims[i])[:5]:
            similar.append({
                "b_number": keys[j],
                "similarity": round(float(sims[i, j]), 4),
                "date": by_key[keys[j]]["date"],
                "outcome_assessed": by_key[keys[j]]["outcome_assessed"],
                "matched_passages": [{
                    "similarity": 0.88,
                    "query_excerpt": f"[GAO Decision {key}]\nSynthetic passage from the target decision.",
                    "match_excerpt": f"[GAO Decision {keys[j]}]\nSynthetic passage from the matched decision.",
                }],
                "shared_authorities": {"far": ["19.502-2"] if DECISIONS[i][1] == "set_aside" else [],
                                       "hhsar": [], "us_c": [], "gao_refs": []},
            })
        synopsis: dict[str, Any] = {
            "shared": [f"Shared issue for {key} ({version})."],
            "differences": [f"Difference for {key} ({version})."],
            "practical_use": f"Practical use of {key} ({version}).",
        }
        if version == "v2":
            synopsis["grounds_to_distinguish"] = [f"Ground to distinguish {key}."]
        return {
            "b_number": key,
            "date": by_key[key]["date"],
            "outcome_assessed": by_key[key]["outcome_assessed"],
            "similar": similar,
            "synopsis": synopsis,
            "error": None,
        }

    v1_lines = [json.dumps(synopsis_entry(i, "v1")) for i in range(len(keys)) if i % 3 != 2]
    v1_lines.append(json.dumps({"b_number": keys[2], "synopsis": None, "error": "timeout"}))
    v1_lines.append("{not json")
    (source / "similar_by_bnumber.jsonl").write_text("\n".join(v1_lines) + "\n", encoding="utf-8")
    v2 = {keys[i]: synopsis_entry(i, "v2") for i in range(len(keys)) if i % 2 == 0}
    _write_json(source / "similar_by_bnumber_v2.json", v2)

    return {spec["query"]: [round(float(x), 6) for x in centroids[t]] for t, spec in TOPICS.items()}


def _write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def build_fixture(dest: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source"
        source.mkdir()
        queries = generate_source(source)
        bundle = dest / "bundle"
        if bundle.exists():
            shutil.rmtree(bundle)
        build_bundle.build(source, bundle, data_version="v1", check_sample=10, built_at=BUILT_AT,
                           log=lambda *_: None)
    (dest / "query_vectors.json").write_text(json.dumps(queries, indent=1) + "\n", encoding="utf-8")


def _same_tree(a: Path, b: Path) -> list[str]:
    diffs: list[str] = []
    files_a = {p.relative_to(a) for p in a.rglob("*") if p.is_file()}
    files_b = {p.relative_to(b) for p in b.rglob("*") if p.is_file()}
    diffs += [f"only in generated: {p}" for p in sorted(files_a - files_b)]
    diffs += [f"only in checked-in: {p}" for p in sorted(files_b - files_a)]
    for p in sorted(files_a & files_b):
        if not filecmp.cmp(a / p, b / p, shallow=False):
            diffs.append(f"differs: {p}")
    return diffs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="compare with the checked-in fixture instead of writing")
    args = parser.parse_args()
    if not args.check:
        FIXTURES.mkdir(parents=True, exist_ok=True)
        build_fixture(FIXTURES)
        print(f"wrote {FIXTURES / 'bundle'} and {FIXTURES / 'query_vectors.json'}")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        build_fixture(Path(tmp))
        diffs = _same_tree(Path(tmp) / "bundle", FIXTURES / "bundle")
        if not filecmp.cmp(Path(tmp) / "query_vectors.json", FIXTURES / "query_vectors.json", shallow=False):
            diffs.append("differs: query_vectors.json")
    if diffs:
        print("test/fixtures is stale; run: uv run scripts/make_fixture.py", file=sys.stderr)
        for d in diffs:
            print(f"  {d}", file=sys.stderr)
        return 1
    print("test/fixtures is up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
