# OpenAI plugin package

The listing for the hosted server at `https://mcp.acqagent.ai/mcp` in OpenAI's plugin directory
(ChatGPT and Codex). It is the AcqAgent deployment's package, not something a self-hosted copy
needs.

| File | What it holds |
|---|---|
| `plugin.json` | Listing text, the four policy URLs, icons, review test cases and release notes |
| `mcp.json` | The one remote MCP server, with no authentication |
| `assets/logo.png`, `assets/icon.png` | The AcqAgent mark, 512 and 136 pixels square |

Build the ZIP from `servers/gao-protests-mcp`:

```bash
npm run plugin:zip     # writes dist/acqagent-protest-search.zip
```

`npm test` checks the package against the directory's submission limits (name, text lengths,
prompts, URLs, icons, brand colors, one unauthenticated server, five positive and three negative
review cases that name real tools).

## Updating the listing

Changes to anything in this folder need a new ZIP and a new review: raise `version` in
`plugin.json`, rebuild, and upload it through **Upload plugin to make changes**. Keep `name` as
it is; the directory rejects an update whose name differs. Changes to the server itself (tools,
descriptions, data) don't need a new ZIP: OpenAI rescans the server daily.

The demo video link (`review.demo_recording_url`) is required for review. Add it here once the
video is recorded, or enter it in the portal's **Review details**.
