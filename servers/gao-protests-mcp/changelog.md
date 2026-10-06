# Changelog

## 1.0.0

Initial release. A stateless remote MCP server on Cloudflare Workers that serves the GAO bid
protest corpus analysis from R2, with five read-only tools: `search_decisions`,
`get_decision`, `find_similar_decisions`, `get_similarity_synopsis`, and `corpus_info`.
Includes `scripts/build_bundle.py` to turn the analysis outputs into the R2 bundle and
`scripts/check_embedding_parity.py` to confirm Workers AI query embeddings match the corpus
vectors.
