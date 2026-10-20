# Changelog

## 1.2.0

- Allowance: a shared count of tool calls per UTC day and month (`DAILY_TOOL_CALLS`,
  `MONTHLY_TOOL_CALLS`; 20,000 and 300,000 in `wrangler.jsonc`), kept by the `UsageCounter`
  Durable Object. Past it, tools answer "try again later" without doing any work. Only valid
  tool calls count. `/health` reports usage under `tool_calls`.
- Allowlist: with `ALLOWLIST` set to `"on"`, `/mcp` accepts only ChatGPT's and Claude's published
  outbound addresses, plus clients sending `MCP_AUTH_TOKEN`, and answers 403 otherwise. OpenAI's list
  is refreshed hourly and saved in the bucket, with a built-in copy as the fallback. Off by default.
- Off switch: with the `OFF_SWITCH_*` secrets set, an hourly check counts the month's requests
  through the GraphQL Analytics API and, past `OFF_SWITCH_REQUESTS` (60 million), turns on a WAF
  custom rule that blocks the server's hostname.
- An hourly cron trigger runs the list refresh and the off switch check.
- `search_decisions` queries are limited to 500 characters, down from 2,000.
- `/health` also reports the allowlist and off switch status.
- `workers_dev` is no longer set, so deploying with a custom domain turns the workers.dev URL off,
  and `preview_urls` is off: zone WAF rules don't cover workers.dev.

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
