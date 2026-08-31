# mcps

Free and open source MCP servers for federal contracting data and policy tracking. SAM.gov, USASpending, GSA CALC+, BLS OEWS, GSA Per Diem, eCFR, Federal Register, Regulations.gov, and Acquisition.gov are exposed through deterministic tool calls.

Your assistant queries the real APIs instead of recalling what it thinks the FAR says. Same input, same output, every time.

This repository continues the work originally published as [1102tools-dev/federal-contracting-mcps](https://github.com/1102tools-dev/federal-contracting-mcps) ([1102tools.com](https://1102tools.com)).

## Server catalog

Source lives under `servers/<name>/`. Each server is self-contained: code, tests, and a per-server README with a copy-paste config block.

**Procurement data**
- `sam-gov-mcp` — SAM.gov entity registration, exclusions, opportunities, contract awards, federal hierarchy, FFATA subawards
- `usaspending-gov-mcp` — federal contract, award, subaward, recipient, agency, and Treasury federal account data
- `gsa-calc-mcp` — GSA CALC+ awarded NTE hourly rates from MAS contracts
- `bls-oews-mcp` — BLS OEWS market wage data across ~830 occupations and 530+ metros
- `gsa-perdiem-mcp` — federal travel lodging and M&IE rates for CONUS

**Regulatory and policy tracking**
- `ecfr-mcp` — current CFR text updated daily; FAR, DFARS, and agency supplement lookups
- `federal-register-mcp` — proposed rules, final rules, notices, executive orders, FAR cases
- `regulations-gov-mcp` — rulemaking dockets, public comments, comment period tracking
- `acquisition-gov-mcp` — RFO model-part pages, the posted agency-deviation index, indexed deviation PDFs, and approved RFO guidance

## Install

Requires Python 3.10+ and [uv](https://docs.astral.sh/uv/).

**1. Register the free API keys you need.** [BLS](https://data.bls.gov/registrationEngine/), [api.data.gov](https://api.data.gov/signup/) (covers Per Diem and Regulations.gov), and [SAM.gov Help](https://sam.gov/help). USASpending, GSA CALC+, eCFR, Federal Register, and Acquisition.gov need no key. Never paste a key into chat.

**2. Add the servers you want to your client config.**

```json
{
  "mcpServers": {
    "ecfr": {
      "command": "uvx",
      "args": ["--refresh-package", "ecfr-mcp", "--from", "ecfr-mcp", "ecfr-mcp"]
    },
    "sam-gov": {
      "command": "uvx",
      "args": ["--refresh-package", "sam-gov-mcp", "--from", "sam-gov-mcp", "sam-gov-mcp"],
      "env": { "SAM_API_KEY": "your-key-here" }
    }
  }
}
```

`--refresh-package` makes uv check PyPI for a newer release each time the client launches the server. Without it, uv keeps serving the version it first cached.

**3. Restart the client.** Each server's README has its own block with the correct package name and environment variable.

## Status

Repository maintenance is being taken over from the original publisher. Content is being migrated here; server directories, tests, and per-server documentation will land in follow-up commits.

## License

MIT

## Credit

Originally built by [James Jenrette](https://www.linkedin.com/in/jamesjenrette/). Independently developed and not endorsed by any federal agency.
