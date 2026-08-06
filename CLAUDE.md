# securellm-mcp

MCP server for the SecureLLM suite. Built with TypeScript/Node.js.

## Machine: Ubuntu (`/home/nx`)

This server runs on Ubuntu with user `nx`. All paths use `/home/nx/`.

### Build

```bash
npm run build
```

TypeScript is a **per-project** dependency (`node_modules/.bin/tsc`), not global. Always rebuild after source changes before restarting the server.

### MCP Configuration

The server is configured **globally** so it connects from any project directory:

- **Global config**: `~/.claude/claude.json`
- **Per-project config** (this repo): `.mcp.json` — kept in sync with the global config

The `.mcp.json` exists for local dev convenience but the **global config is the canonical one**. If you update env vars or paths, update both files.

### Key environment variables

| Variable            | Value                                          | Purpose                             |
| ------------------- | ---------------------------------------------- | ----------------------------------- |
| `ADR_REPO_PATH`     | `/home/nx/suit/adr-ledger`                     | Where ADR tools look for the ledger |
| `PROJECT_ROOT`      | `/home/nx/suit`                                | Suite root                          |
| `KNOWLEDGE_DB_PATH` | `/home/nx/.local/share/securellm/knowledge.db` | SQLite knowledge base               |

### Why `ADR_REPO_PATH` matters

`adr_new` and `adr_show` write/read files directly using `ADR_REPO_PATH`. `adr_list`, `adr_accept`, etc. delegate to `bash /home/nx/suit/adr-ledger/scripts/adr` — the script auto-detects its location via `ADR_ROOT`, but the env var makes it explicit.

### Previous machine (kernelcore)

The original `.mcp.json` had paths pointing to `/home/kernelcore/` (different machine). When migrating to a new machine, update all absolute paths in both `~/.claude/claude.json` and `.mcp.json`.
