# Changelog

## 1.1.0

- Rate limit: `/mcp` allows 120 requests a minute per client IP (per /64 for IPv6) through a
  Workers rate limiting binding (`MCP_RATE_LIMITER`), and answers HTTP 429 with `Retry-After`
  over the limit. The binding is approximate, so treat it as a backstop. Without the binding
  nothing is limited.
- `/.well-known/openai-apps-challenge` serves the `OPENAI_APPS_CHALLENGE` secret as plain text,
  for domain verification in OpenAI's plugin directory. Unset, it returns 404.
- `workers_dev` is set explicitly so deploying with `--domain` keeps the workers.dev URL, and
  `npm run deploy:acqagent` deploys the hosted copy to `mcp.acqagent.ai`.

## 1.0.0

Initial release. A stateless remote MCP server on Cloudflare Workers that serves the GAO bid
protest corpus analysis from R2, with five read-only tools: `search_decisions`,
`get_decision`, `find_similar_decisions`, `get_similarity_synopsis`, and `corpus_info`.
Includes `scripts/build_bundle.py` to turn the analysis outputs into the R2 bundle and
`scripts/check_embedding_parity.py` to confirm Workers AI query embeddings match the corpus
vectors.
