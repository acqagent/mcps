#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Check that Workers AI embeds queries the same way the corpus vectors were built.

search_decisions embeds the query with Workers AI (@cf/baai/bge-base-en-v1.5, mean
pooling) and compares it against document vectors built locally with the Hugging
Face BAAI/bge-base-en-v1.5 model (mean pooling, L2-normalized). This script embeds
the same texts both ways and reports their cosine similarity; values near 1.0 mean
search results will match a local query. Run it once before deploying.

Requires torch, transformers and numpy in the current environment, plus a
Cloudflare API token with Workers AI read access:

  export CLOUDFLARE_ACCOUNT_ID=...
  export CLOUDFLARE_API_TOKEN=...
  python scripts/check_embedding_parity.py
  python scripts/check_embedding_parity.py --bundle OUT_DIR/v1 --sample 50

With --bundle, it also embeds the summaries of a sample of decisions through
Workers AI and reports how often each decision ranks in the top 10 of the int8
search the Worker runs (an end-to-end check of the deployed search path).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import struct
import sys
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_bundle import canonical_key  # noqa: E402

MODEL = "BAAI/bge-base-en-v1.5"
WORKERS_AI_MODEL = "@cf/baai/bge-base-en-v1.5"
SAMPLE_TEXTS = [
    "bid bond missing when bids were opened",
    "agency unreasonably evaluated the protester's past performance and made a flawed best-value tradeoff",
    "small business set-aside of a delivery order under an unrestricted IDIQ contract; rule of two",
    "organizational conflict of interest based on unequal access to nonpublic information",
    "protest of solicitation terms is untimely because it was filed after the closing time for proposals",
]


def local_embed(texts: list[str]) -> np.ndarray:
    import torch
    from transformers import AutoModel, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL)
    model.eval()
    inp = tok(texts, padding=True, truncation=True, max_length=512, return_tensors="pt")
    with torch.no_grad():
        out = model(**inp)
    mask = inp["attention_mask"].unsqueeze(-1)
    vec = (out.last_hidden_state * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
    vec = vec / vec.norm(dim=1, keepdim=True)
    return vec.numpy().astype(np.float32)


def workers_ai_embed(texts: list[str], account: str, token: str) -> np.ndarray:
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{WORKERS_AI_MODEL}"
    rows = []
    for start in range(0, len(texts), 50):
        body = json.dumps({"text": texts[start : start + 50], "pooling": "mean"}).encode()
        req = urllib.request.Request(
            url, data=body, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read())
        if not payload.get("success"):
            raise SystemExit(f"Workers AI error: {payload.get('errors')}")
        rows.extend(payload["result"]["data"])
    v = np.asarray(rows, dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def load_bundle(bundle: Path) -> tuple[list[str], np.ndarray, np.ndarray]:
    index = json.loads((bundle / "index.json").read_text(encoding="utf-8"))
    raw = (bundle / "vectors.bin").read_bytes()
    n, d = struct.unpack("<II", raw[8:16])
    scales = np.frombuffer(raw[16 : 16 + 4 * d], dtype="<f4")
    q = np.frombuffer(raw[16 + 4 * d :], dtype=np.int8).reshape(n, d)
    return index["keys"], q, scales


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle", type=Path, help="a built bundle version directory (contains index.json)")
    parser.add_argument("--sample", type=int, default=50, help="decisions to test with --bundle")
    parser.add_argument("--min-cosine", type=float, default=0.99, help="fail below this local/remote cosine")
    args = parser.parse_args()

    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        print("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.", file=sys.stderr)
        return 2

    local = local_embed(SAMPLE_TEXTS)
    remote = workers_ai_embed(SAMPLE_TEXTS, account, token)
    cosines = (local * remote).sum(axis=1)
    for text, c in zip(SAMPLE_TEXTS, cosines):
        print(f"{c:.5f}  {text[:70]}")
    print(f"min {cosines.min():.5f}  mean {cosines.mean():.5f}")
    ok = bool(cosines.min() >= args.min_cosine)

    if args.bundle:
        keys, q, scales = load_bundle(args.bundle)
        rng = random.Random(7)
        rows = rng.sample(range(len(keys)), min(args.sample, len(keys)))
        summaries, picked = [], []
        for r in rows:
            path = args.bundle / "records" / f"{canonical_key(keys[r])}.json"
            summary = json.loads(path.read_text(encoding="utf-8")).get("summary") if path.exists() else None
            if summary:
                summaries.append(summary)
                picked.append(r)
        emb = workers_ai_embed(summaries, account, token)
        scores = emb @ (q.astype(np.float32) * scales).T
        ranks = [int((scores[i] > scores[i, r]).sum()) + 1 for i, r in enumerate(picked)]
        top1 = sum(1 for x in ranks if x == 1) / len(ranks)
        top10 = sum(1 for x in ranks if x <= 10) / len(ranks)
        print(f"summary -> own decision: top-1 {top1:.0%}, top-10 {top10:.0%} over {len(ranks)} decisions")

    print("OK" if ok else f"FAIL: local and Workers AI embeddings differ (min cosine < {args.min_cosine})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
