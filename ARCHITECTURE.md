# Architecture

## System Purpose

SecureLLM-MCP is a Model Context Protocol (MCP) server that exposes the VoidNX Labs ecosystem
to MCP clients as a set of named, schema-validated tools. It is the single integration point
between an LLM client and the platform's capabilities — code analysis, RAG, ADR governance,
supply-chain checks, ecosystem search and system operations.

It is deliberately **not** network-addressable. All external access arrives through
`securellm-bridge`, which terminates TLS, authenticates, rate-limits and audits before piping
requests here over stdio.

## High-Level Overview

```
MCP client (Claude, IDE, CLI)
  │  HTTPS + OAuth 2.0 / Bearer
  ▼
securellm-bridge :3000          ← the only listening socket
  │  stdio (no port, no bind)
  ▼
securellm-mcp
  ├── server/     dispatcher, tool-registry, wrap
  ├── middleware/ circuit breaker, rate limiter, semantic cache, dedup, retry, metrics
  ├── auth/       OAuth manager, token storage, GitHub provider
  ├── security/   input validators, path validator, sandbox manager
  ├── tools/      62 tool modules across ~11 categories
  ├── knowledge/  local knowledge base + compaction
  ├── reasoning/  planning and decision support
  └── telemetry/  Prometheus metrics
        │
        ├──▶ phantom :8008   document intelligence
        ├──▶ cerebro :8009   RAG over the ADR knowledge base
        ├──▶ llama.cpp :8081 local inference (optional)
        └──▶ NATS :4222      event mesh (optional)
```

## Components

| Directory | Files | Responsibility |
|---|---|---|
| `src/tools/` | 62 | Tool implementations, one module per capability group |
| `src/utils/` | 21 | Shared helpers |
| `src/types/` | 17 | Schema and type definitions shared across tools |
| `src/reasoning/` | 15 | Planning, deep research, decision support |
| `src/middleware/` | 11 | Cross-cutting request concerns (see below) |
| `src/knowledge/` | 7 | Local knowledge store and compaction |
| `src/config/` | 6 | Configuration loading and validation |
| `src/auth/` | 4 | OAuth manager, token storage, provider adapters |
| `src/server/` | 3 | `dispatcher.ts`, `tool-registry.ts`, `wrap.ts` |
| `src/security/` | 3 | Input validation, path validation, sandboxing |
| `src/intelligence/` | 3 | Vector store, error classification, research |
| `src/telemetry/` | 1 | Prometheus metrics export |

### Middleware chain

Every tool invocation passes through `src/middleware/`:

- `circuit-breaker.ts` — canonical Open / Closed / Half-Open state machine with exponential
  backoff; prevents a failing downstream from cascading.
- `rate-limiter.ts` and `tool-limiter.ts` — global and per-tool budgets.
- `semantic-cache.ts` — cosine similarity over `Float32Array` embeddings, with a deterministic
  character-frequency fallback when no embedding backend is reachable. A mutex guards SQLite
  statistics updates against concurrent writers.
- `request-deduplicator.ts` — collapses identical in-flight requests.
- `retry-strategy.ts` — bounded retry with backoff.
- `metrics-collector.ts` / `tool-metrics.ts` — Prometheus counters and histograms.
- `error-classifier.ts` — maps failures to retryable / terminal classes.
- `adr-hygiene.ts` — enforces ADR governance rules on decision-affecting tools.

## Data Flow

1. Client sends an MCP request; `securellm-bridge` authenticates and pipes it to stdio.
2. `server/dispatcher.ts` resolves the tool via `server/tool-registry.ts`.
3. `security/input-validators.ts` and `path-validator.ts` reject malformed or out-of-bounds
   input before any work happens.
4. The middleware chain applies caching, deduplication and rate limiting.
5. The tool executes, calling out to phantom, cerebro, llama.cpp or NATS as needed.
6. Results are wrapped by `server/wrap.ts`; metrics are recorded; the response returns over
   stdio.

## Trust Boundaries

| Boundary | Control |
|---|---|
| Internet → bridge | TLS, OAuth 2.0 / Bearer, rate limiting, audit log |
| Bridge → MCP server | stdio pipe only; **the MCP server never binds a socket** |
| MCP server → filesystem | `security/path-validator.ts` constrains all path access |
| MCP server → shell | `security/sandbox-manager.ts` mediates execution |
| MCP server → downstream | per-provider timeouts and circuit breakers |

The design intent is that compromising the MCP server still requires first defeating the
gateway, and that the MCP server cannot be reached directly even from inside the host network.

## Runtime Model

Single Node.js process speaking MCP over stdio. No listening socket. Concurrency is
event-loop based; the semantic cache uses a mutex for its SQLite statistics because those
updates are read-modify-write.

## Configuration

Environment-driven, loaded and validated through `src/config/`. See `.env.example`.
Secrets are managed via SOPS (`.sops.yaml`) and never committed.

## Storage

- Encrypted SQLite with FTS5 for the local knowledge base and semantic cache.
- `~/.local/share/securellm/knowledge.db` for cross-project knowledge.

## External Integrations

| Service | Port | Required |
|---|---|---|
| phantom | 8008 | no — document intelligence tools degrade |
| cerebro | 8009 | no — RAG tools degrade |
| llama.cpp | 8081 | no — falls back to character-frequency embeddings |
| NATS | 4222 | no — event publication is best-effort |

All downstreams are optional by design; each has a circuit breaker and a degraded path.

## Security Model

- No inbound network surface.
- Input validation and path constraints applied before dispatch.
- Sandboxed execution for tools that shell out.
- Secrets via SOPS; nothing sensitive in the repository.
- OAuth token storage isolated in `src/auth/token-storage.ts`.

## Testing Model

38 test files. `pnpm test` runs the suite; `.c8rc.json` configures coverage. Unit coverage is
strongest around the middleware (circuit breaker, semantic cache). Integration tests that
exercise the full MCP path require llama.cpp and cerebro to be reachable.

## Operational Notes

- Health probe and Prometheus metrics endpoint are exposed for the container.
- Graceful shutdown is implemented.
- `docker-compose.yml` and `Dockerfile` are committed; the service also runs as part of
  `deploy/docker-compose.master.yml`.
- Build: `nix develop` then `pnpm build`. The flake exposes `packages` and `overlays`.

## Known Architectural Risks

1. **Security posture is the weakest of the backbone** (49/100 in the ecosystem scan) despite
   this service holding credentials for every downstream provider. No `SECURITY.md`, no threat
   model document. This is the highest-leverage hardening target in the ecosystem.
2. **No operational runbook.** The service is operated daily but nothing records how to
   diagnose or recover it.
3. **Semantic cache fallback can collide.** The character-frequency embedding used when no GPU
   backend is present may produce false cache hits on short queries. Collision rate is not
   currently monitored.
4. **Integration tests depend on live infrastructure**, so they do not run in CI.
5. **62 tool modules under one registry** is a large surface for a single process; there is no
   per-tool isolation beyond the sandbox manager.
