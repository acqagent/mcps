# AcqAgent acquisition-policy MCP servers

Four free, open-source MCP servers that support the AcqAgent Acquisition Policy
Agent. They query published federal sources through deterministic, read-only tools
instead of relying on a model's memory of acquisition policy.

This repository continues work originally published in
[1102tools-dev/federal-contracting-mcps](https://github.com/1102tools-dev/federal-contracting-mcps).

## Transfer boundary

This repository contains only the four MCP servers transferred with the Acquisition
Policy Agent:

- `ecfr-mcp` `1.0.6`: current CFR text, structure, search, and version comparisons
- `federal-register-mcp` `1.0.5`: proposed rules, final rules, notices, effective dates, and rulemaking history
- `regulations-gov-mcp` `1.0.8`: dockets, documents, public comments, and comment-period evidence
- `acquisition-gov-mcp` `1.0.2`: RFO model text, official guidance, and posted agency deviations

The SAM.gov MCP is not part of this transfer. It remains maintained in
[1102tools-dev/federal-contracting-mcps](https://github.com/1102tools-dev/federal-contracting-mcps),
even though the separately transferred Market Research Agent uses its published
package. USASpending, GSA CALC+, BLS OEWS, and GSA Per Diem also remain there.

## Install

Python 3.10 or newer and [uv](https://docs.astral.sh/uv/) are required. eCFR,
Federal Register, and Acquisition.gov require no credentials. Regulations.gov can
use `REGULATIONS_GOV_API_KEY`; otherwise it discloses and uses the limited shared
`DEMO_KEY` fallback.

Install any server from its published Python package:

```bash
uvx ecfr-mcp==1.0.6
uvx federal-register-mcp==1.0.5
uvx regulationsgov-mcp==1.0.8
uvx acquisition-gov-mcp==1.0.2
```

Each directory under `servers/` contains source, tests, release history, and a
standalone client configuration example.

## Development

```bash
cd servers/ecfr-mcp
uv sync --group dev
uv run pytest -q
```

Use the same commands from any of the other server directories. Tests are also run
for all four packages on pull requests.

## License and credit

MIT licensed. Originally built by James Jenrette / 1102tools. Independently
developed and not endorsed by any federal agency.
