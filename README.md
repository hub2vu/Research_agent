# Research Agent Util

Local MCP-based research workspace for paper search, ranking, graph exploration, note taking, and report generation.

## Runtime Credentials

OpenAI, Tavily, and Notion credentials are no longer loaded from a local env file.

Use the web UI instead:

1. Start the stack.
2. Open `http://localhost:3000`.
3. Click the top-right `Account` button.
4. Save the API keys you need.

Credentials are stored locally in:

- `output/_runtime/service_settings.json`

The MCP server and agent read that file at runtime, so saving new keys does not require a restart.

## Quick Start

```bash
docker compose build
docker compose up -d mcp-server web
```

Optional:

```bash
docker compose up -d agent
```

Then add PDFs under `./pdf/` and open `http://localhost:3000`.

## Services

- `mcp-server`: tool execution layer on port `8000`
- `agent`: orchestration layer on port `8001`
- `web`: React UI on port `3000`

## Notes

- Non-secret runtime settings such as `MCP_SERVER_URL`, `PDF_DIR`, and `OUTPUT_DIR` still use normal environment variables.
- Discord webhook settings are also stored in the same local runtime settings file.
- Ignore `output/_runtime/` in git because it contains local credentials.
