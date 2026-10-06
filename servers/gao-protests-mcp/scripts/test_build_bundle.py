# SPDX-License-Identifier: MIT
"""Tests for build_bundle.py. Run: uv run --with pytest --with numpy pytest scripts"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import pytest

import build_bundle as bb
import make_fixture

ROOT = Path(__file__).resolve().parent.parent
CASES = json.loads((ROOT / "test" / "fixtures" / "canonical_cases.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("bundle")
    source = tmp / "source"
    source.mkdir()
    make_fixture.generate_source(source)
    manifest = bb.build(source, tmp / "out", built_at="2026-01-01T00:00:00+00:00", check_sample=10, log=lambda *_: None)
    return source, tmp / "out" / "v1", manifest


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("raw,expected", CASES)
def test_canonical_key_matches_worker(raw, expected):
    assert bb.canonical_key(raw) == expected


def test_aliases_resolve_to_primary(built):
    _, out, manifest = built
    alias = read(out / "records" / "B-900201.3.json")
    assert alias["key"] == "B-900201.2"
    assert alias == read(out / "records" / "B-900201.2.json")
    assert read(out / "index.json")["aliases"] == {"B-900201.3": "B-900201.2"}
    assert manifest["lookup_keys"] == manifest["records"] + 1


def test_neighbor_files_keyed_by_alias_still_attach(built):
    _, out, _ = built
    rec = read(out / "records" / "B-900201.2.json")
    assert len(rec["neighbors"]["cosine"]) == 20
    assert all(t[0] != "B-900201.2" for t in rec["neighbors"]["cosine"])


def test_unvectorized_analysis_entry_is_skipped(built):
    _, out, manifest = built
    assert not (out / "records" / "B-999999.json").exists()
    assert manifest["warnings"] == {"analysis key whose record is not in the vector row order": 1}


def test_synopsis_v2_wins_and_empty_entries_are_ignored(built):
    _, out, manifest = built
    assert read(out / "synopsis" / "B-900101.json")["synopsis_version"] == "v2"
    assert read(out / "synopsis" / "B-900102.json")["synopsis_version"] == "v1"
    # Index 2 has only a v1 line with synopsis=null (and a v2 entry, since 2 is even).
    assert read(out / "synopsis" / "B-900103.json")["synopsis_version"] == "v2"
    assert not (out / "synopsis" / "B-900106.2.json").exists()
    assert manifest["coverage"]["synopsis"] == {"total": 30, "v1": 12, "v2": 18}


def test_index_columns(built):
    _, out, _ = built
    index = read(out / "index.json")
    n = index["count"]
    for column in ("keys", "dates", "years", "outcome", "agency", "record_type", "vehicles"):
        assert len(index[column]) == n
    row = index["keys"].index("B-180101 B-180102")
    assert index["years"][row] == 1985  # year taken from the date
    row = index["keys"].index("B-180001")
    assert index["years"][row] == 0
    row = index["keys"].index("B-900101")
    bits = index["vehicles"][row]
    names = [name for i, name in enumerate(index["vehicle_names"]) if bits & (1 << i)]
    assert names == ["idiq", "set-aside", "delivery-order"]
    assert index["outcomes"][index["outcome"][index["keys"].index("A-70001")]] == ""


def test_vectors_round_trip(built):
    source, out, manifest = built
    raw = (out / "vectors.bin").read_bytes()
    assert raw[:8] == bb.VECTOR_MAGIC
    n, d = struct.unpack("<II", raw[8:16])
    scales = np.frombuffer(raw[16 : 16 + 4 * d], dtype="<f4")
    q = np.frombuffer(raw[16 + 4 * d :], dtype=np.int8).reshape(n, d)
    original = np.load(source / "corpus_doc_vectors.npz")["vectors"]
    assert np.abs(q * scales - original).max() < 0.01
    assert manifest["vectors"]["quantization_check"]["overlap_at_10"] == 1.0


def test_existing_output_requires_force(built, tmp_path):
    source, _, _ = built
    bb.build(source, tmp_path, check_sample=0, log=lambda *_: None)
    with pytest.raises(bb.BundleError, match="--force"):
        bb.build(source, tmp_path, check_sample=0, log=lambda *_: None)
    bb.build(source, tmp_path, check_sample=0, force=True, log=lambda *_: None)


def test_without_vectors(built, tmp_path):
    source, _, _ = built
    manifest = bb.build(source, tmp_path, include_vectors=False, log=lambda *_: None)
    assert manifest["vectors"] is None
    assert not (tmp_path / "v1" / "vectors.bin").exists()
    # Without the vector row order, every analysis record is a primary.
    assert manifest["records"] == 37


def test_colliding_primary_keys_are_rejected(tmp_path):
    analysis = {
        "B-1000 B-2000": {"key": "B-1000 B-2000"},
        "B-1000B-2000": {"key": "B-1000B-2000"},
    }
    (tmp_path / "analysis_by_bnumber.json").write_text(json.dumps(analysis), encoding="utf-8")
    with pytest.raises(bb.BundleError, match="collide"):
        bb.build(tmp_path, tmp_path / "out", log=lambda *_: None)


def test_bad_data_version_is_rejected(tmp_path):
    (tmp_path / "analysis_by_bnumber.json").write_text("{}", encoding="utf-8")
    with pytest.raises(bb.BundleError, match="data-version"):
        bb.build(tmp_path, tmp_path / "out", data_version="../v1", log=lambda *_: None)


def test_checked_in_fixture_is_current(tmp_path):
    make_fixture.build_fixture(tmp_path)
    assert make_fixture._same_tree(tmp_path / "bundle", make_fixture.FIXTURES / "bundle") == []


def test_lenient_field_shapes():
    assert bb._year_of({"year": "2021"}) == 2021
    assert bb._year_of({"year": None, "date": "May 25, 2022 "}) == 2022
    assert bb._year_of({"date": "undated"}) == 0
    assert bb._vehicle_bits({"issues": "Task order protest", "key_points": None}) == 1 << bb.VEHICLES.index("task-order")
    assert bb._outcome_of({"outcome_assessed": None, "outcome": " Denied "}) == "denied"
