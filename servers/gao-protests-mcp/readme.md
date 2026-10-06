# gao-protests-mcp

Remote MCP server for searching and comparing GAO bid protest decisions. It runs as a
Cloudflare Worker and serves a precomputed analysis of the decisions from an R2 bucket:
per-decision summaries, issues, reasoning, outcomes, nearest neighbors, LLM re-ranked
matches, and stored comparison synopses.

Nothing is generated at query time. The only model call is Workers AI embedding the text
of a `search_decisions` query.

## Tools

| Tool | What it returns |
|---|---|
| `search_decisions(query, limit?, filters...)` | Decisions closest to a plain-language description of an issue or fact pattern. |
| `get_decision(b_number)` | One decision's analysis: date, agency, `outcome_assessed`, summary, issues, reasoning, outcome rationale, key points, GAO source URL when known, and its five most similar decisions. |
| `find_similar_decisions(b_number, limit?, filters..., opposite_outcome?, exclude_same_docket?)` | Closest decisions to a given one. Unfiltered: the LLM re-ranked top 5, then document similarity. Filtered: every decision that passes the filters, ranked by document similarity. |
| `get_similarity_synopsis(b_number, include_passages?)` | Stored comparison with the five closest matches: shared issues, differences, grounds to distinguish, practical use, matched passages, and FAR/U.S.C./GAO citations found in both decisions. |
| `corpus_info()` | Coverage, counts by outcome and record type, year range, valid filter values, and data caveats. |

Decision numbers are matched loosely: `b-417297.2`, `B 417297.2`, the Unicode hyphens that
appear in copied PDF text, `A-76944`, and text such as `GAO decision B-420562 (2022)` all resolve. Any B-number of
a consolidated decision resolves to its primary record.

### Filters

| Filter | Matches |
|---|---|
| `outcome` | `outcome_assessed`, exact and case-insensitive (`denied`, `sustained`, `dismissed`, ... see `corpus_info`) |
| `agency` | Case-insensitive substring of the agency name (`Navy`, `Veterans`) |
| `year_min`, `year_max` | Inclusive. Decisions without a known year are excluded when either is set |
| `vehicle` | `idiq`, `torp`, `bpa`, `fss`, `set-aside`, `sole-source`, `task-order`, `delivery-order`, `call-order`, matched in the decision's issues and key points |
| `record_type` | `decision`, `reconsideration`, `advisory_opinion`, `letter`, `other`, `report` |
| `opposite_outcome` | `find_similar_decisions` only: matches with a known outcome different from the target's |
| `exclude_same_docket` | `find_similar_decisions` only: drops decisions sharing the target's GAO file number (`B-417297`, `B-417297.2`, ...) |

Filters are applied to the whole corpus before ranking, so a filtered query still returns the
best matches among the decisions that pass.

## How it works

```
build_bundle.py (once, where the analysis files live)
        |
        v
R2 bucket  <vN>/manifest.json   counts and build info
           <vN>/index.json      filter metadata for every decision (~2 MB)
           <vN>/vectors.bin     int8 document vectors (~23 MB)
           <vN>/records/*.json  one analysis record per B-number
           <vN>/synopsis/*.json one stored synopsis per B-number
        |
        v
Worker  /mcp   stateless MCP (Streamable HTTP, JSON responses)
        reads records on demand; loads index.json and vectors.bin once per isolate;
        ranks with a brute-force int8 dot product; embeds free-text queries with
        Workers AI @cf/baai/bge-base-en-v1.5 (mean pooling), the model the corpus
        vectors were built with
```

The int8 vectors keep rankings close to exact cosine similarity; the build script reports
how closely (`quantization_check` in the manifest). A full-corpus query costs roughly 30 to
50 ms of CPU.

## Deploy

You need a Cloudflare account on the **Workers Paid** plan (search and filtered similarity
use more CPU than the Free plan's 10 ms per request allows), Node 20 or newer,
[uv](https://docs.astral.sh/uv/) (or Python 3.10+ with numpy), and the corpus analysis files.

### 1. Build the data bundle

Point the script at the directory that holds the analysis outputs:

```bash
cd servers/gao-protests-mcp
uv run scripts/build_bundle.py /path/to/analysis ./bundle
```

| Source file | Used for | Required |
|---|---|---|
| `analysis_by_bnumber.json` | records, filters, alias lookup | yes |
| `corpus_doc_vectors.npz` (`vectors`, `keys`, `slugs`) | search and filtered similarity, source URLs | for search |
| `neighbors_top20.json` | similar decisions | recommended |
| `neighbors_top5_v2.json` | LLM re-ranked top 5 | recommended |
| `rerank_issue.json` | one-sentence core issue | optional |
| `similar_by_bnumber.jsonl` / `.json` | synopsis v1 | optional |
| `similar_by_bnumber_v2.jsonl` / `.json` | synopsis v2 (wins over v1) | optional |
| `corpus_doc_vectors_keys.json` | slugs, when the npz has none | optional |

The script prints what it wrote, any warnings, and the int8 ranking check. Expect roughly
70,000 small objects (one record and one synopsis per B-number) and a few hundred MB.

### 2. Create the bucket and upload

```bash
npx wrangler login
npx wrangler r2 bucket create gao-protests
```

Upload the contents of `./bundle` to the bucket root with any S3-compatible tool. Create an R2
API token (R2 > Manage API tokens) for the access key and secret, then for example with
[rclone](https://rclone.org/s3/#cloudflare-r2):

```bash
rclone copy ./bundle r2:gao-protests --transfers 64 --checkers 64
```

or with the AWS CLI:

```bash
aws s3 sync ./bundle s3://gao-protests --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

Object keys must start with the data version, for example `v1/manifest.json`.

### 3. Check query embeddings (optional, recommended)

Confirms that Workers AI embeds text the same way as the local model the corpus vectors came
from. Run it in an environment with `torch`, `transformers` and `numpy`:

```bash
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...   # token with Workers AI read access
python scripts/check_embedding_parity.py --bundle ./bundle/v1
```

### 4. Deploy the Worker

```bash
npm ci
npx wrangler deploy
curl https://gao-protests-mcp.<your-subdomain>.workers.dev/health
```

If you renamed the bucket, update `bucket_name` in `wrangler.jsonc` first.

### 5. Require a token (optional)

The endpoint is open by default. To require a bearer token:

```bash
npx wrangler secret put MCP_AUTH_TOKEN
```

Clients then send `Authorization: Bearer <token>`. Clients that cannot set headers can append
`?key=<token>` to the URL instead; the token then appears in URLs and request logs, so prefer
the header. `/health` stays open. For a public endpoint, consider a Cloudflare rate limiting
rule on `/mcp`.

## Connect a client

The MCP endpoint is `https://gao-protests-mcp.<your-subdomain>.workers.dev/mcp`.

Claude Code:

```bash
claude mcp add --transport http gao-protests https://gao-protests-mcp.<your-subdomain>.workers.dev/mcp
# with a token:
claude mcp add --transport http gao-protests https://gao-protests-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Claude (web and desktop): Settings > Connectors > Add custom connector, and paste the endpoint
URL.

Clients that only speak stdio can use [mcp-remote](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "gao-protests": {
      "command": "npx",
      "args": ["mcp-remote", "https://gao-protests-mcp.<your-subdomain>.workers.dev/mcp"]
    }
  }
}
```

## Updating the data

Build into a new version prefix, upload it, then point the Worker at it:

```bash
uv run scripts/build_bundle.py /path/to/analysis ./bundle --data-version v2
rclone copy ./bundle r2:gao-protests --transfers 64 --checkers 64
# set "DATA_VERSION": "v2" in wrangler.jsonc
npx wrangler deploy
```

The previous version stays in the bucket until you delete it, so rolling back is a one-line
change.

## Example prompts

- "Find GAO decisions where a bid was rejected because the bid bond was missing at bid opening."
- "Get B-420562 and tell me why GAO denied it."
- "Find decisions similar to B-417297.2 that were sustained, from 2015 on, involving IDIQ task orders."
- "Compare B-420562 with its closest matches. What grounds could distinguish it?"
- "Which Navy small business set-aside protests were sustained since 2018?"

## Data caveats

- `outcome_assessed` is the disposition read from the decision text and is authoritative.
  `outcome_metadata` is scraped metadata and is missing for most pre-2004 decisions.
- Summaries, issues, key points, core issues and synopses are model-generated. Cite B-numbers and
  confirm key facts in the decision itself.
- Pre-1990 decisions come from OCR scans: expect occasional noise in party names and missing dates.
- Keys ending in `.v2`, `.v3` are distinct documents that share a B-number (for example an original
  and a reconsideration).

## Development

```bash
npm ci
npm run typecheck
npm test                                              # unit, MCP protocol, and workerd tests
uv run --with pytest --with numpy pytest scripts -q   # bundle builder tests
uv run scripts/make_fixture.py                        # regenerate test/fixtures after changing the builder
```

`test/fixtures/bundle` is a small synthetic bundle (fictional B-9xxxxx decisions) built by
`scripts/make_fixture.py` with the real build script. The workerd test bundles the Worker with
`wrangler deploy --dry-run` and runs it in the local Workers runtime against that fixture.

## License

MIT
