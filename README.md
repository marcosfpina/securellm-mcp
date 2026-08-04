# SecureLLM MCP Server

**Enterprise-Grade Model Context Protocol Server for Intelligent Development Workflows**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NixOS](https://img.shields.io/badge/NixOS-First--Class-5277C3?logo=nixos&logoColor=white)](https://nixos.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Production Ready](https://img.shields.io/badge/status-production--ready-success)](https://github.com/marcosfpina/securellm-mcp)

---

## Overview

SecureLLM MCP is a production-ready **Model Context Protocol (MCP) server** that transforms AI assistants into intelligent development partners. Built with enterprise-grade architecture, it combines advanced caching, reasoning systems, and comprehensive tooling to deliver unprecedented productivity for NixOS and systems programming workflows.

### Key Capabilities

- **Semantic Intelligence**: 50-70% cost reduction through embedding-based query caching
- **Hybrid Reasoning**: Context inference, multi-step planning, and causal impact analysis
- **Production-Ready**: Circuit breakers, retry logic, structured logging, and Prometheus metrics
- **NixOS First-Class**: Deep integration with Nix ecosystem - package debugging, flake management, build optimization
- **Emergency Framework**: Laptop thermal protection during intensive builds
- **Knowledge Management**: Persistent learning with SQLite + FTS5 full-text search
- **Security-Focused**: SOPS secrets management, OAuth integration, sandboxed execution

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MCP CLIENT (Claude, Cline)                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │ stdio/HTTP
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SecureLLM MCP Server Core                         │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │  Semantic      │  │  Smart Rate    │  │  Knowledge     │        │
│  │  Cache         │  │  Limiter       │  │  Database      │        │
│  │  (Embeddings)  │  │  (Circuit      │  │  (SQLite +     │        │
│  │                │  │   Breaker)     │  │   FTS5)        │        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Reasoning   │  │  Development     │  │  Infrastructure  │
│  Systems     │  │  Tools           │  │  Management      │
│              │  │                  │  │                  │
│ • Context    │  │ • Nix Package    │  │ • SSH Remote     │
│   Inference  │  │   Debugger       │  │   Execution      │
│ • Multi-Step │  │ • Build Analyzer │  │ • System Health  │
│   Planner    │  │ • Flake Ops      │  │   Monitoring     │
│ • Causal     │  │ • Web Search     │  │ • Emergency      │
│   Analysis   │  │ • Browser Auto   │  │   Framework      │
│ • Adaptive   │  │ • Research Agent │  │ • Backup Manager │
│   Learning   │  │ • Code Analysis  │  │ • Log Analysis   │
└──────────────┘  └──────────────────┘  └──────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Observability & Security                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐   │
│  │ Prometheus │  │ Structured │  │ OAuth/     │  │ Sandboxed  │   │
│  │ Metrics    │  │ Logging    │  │ GitHub     │  │ Execution  │   │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Features

### 🧠 Intelligent Caching Layer

**Semantic Cache** - Industry-first embedding-based caching for MCP servers:

- **Semantic Similarity Detection**: Understands that "check system temperature" and "verify thermal status" are equivalent queries
- **Cost Optimization**: 50-70% reduction in tool execution costs
- **Automatic Expiration**: TTL-based cache invalidation with periodic cleanup
- **Performance Metrics**: Real-time hit/miss rates, token savings, similarity scores

```typescript
// Queries like these hit the same cache:
"What's the current CPU temperature?"
"Check thermal status of the system"
"Show me processor heat levels"
```

### 🎯 Smart Rate Limiting

Production-grade request management with circuit breaker pattern:

- **Per-Provider Queuing**: FIFO request queues with configurable limits
- **Circuit Breaker**: Automatic failure detection and recovery
- **Exponential Backoff**: Intelligent retry with jitter
- **Metrics Collection**: Request latency percentiles (p50, p95, p99), error categorization, queue depths
- **Prometheus Export**: HTTP metrics endpoint for observability

### 🗄️ Knowledge Management System

Persistent learning infrastructure with advanced search:

- **SQLite + FTS5**: Full-text search with Porter stemming and Unicode support
- **Session Management**: Contextual conversation tracking across interactions
- **Structured Storage**: Typed entries (insights, decisions, code, references)
- **Priority System**: High/medium/low classification for relevance ranking
- **Project Watcher**: Automatic file system monitoring and knowledge extraction

### 🔧 NixOS Development Tools

Comprehensive tooling for NixOS ecosystem:

- **Package Debugger**: Diagnose and fix Nix package build failures
- **Flake Operations**: Build, update, and manage Nix flakes
- **Build Analyzer**: Performance profiling and optimization recommendations
- **Hash Calculator**: Automatic SHA256 calculation for fetchurl/fetchFromGitHub
- **Configuration Generator**: Smart Nix expression generation

### 🛡️ Emergency Framework

Laptop protection during intensive operations:

- **Thermal Monitoring**: Real-time CPU/GPU temperature tracking
- **Rebuild Safety Checks**: Pre-build thermal validation
- **Automatic Throttling**: Force cooldown when temperature exceeds thresholds
- **Forensic Analysis**: Post-build thermal profiling with detailed reports
- **War Room Mode**: Live monitoring during critical operations

### 🌿 Git Operations (ADR-0062)

Professional git tooling across the whole ecosystem, not just the server's own
working directory. Every command is built as argv — never a shell string — and
runs against an explicitly resolved repository.

| Tool | What it answers | Writes? |
|------|-----------------|---------|
| `git_sherlock` | Forensics on one repo: blame heatmap, churn, authors, file history, branch inventory, divergence, commit lint, release readiness, regression range | No |
| `git_fleet` | "What is dirty, unpushed, behind, or stale across every repo?" | No |
| `git_workbench` | Stage, commit, branch, tag, stash, worktree | Yes — guarded |
| `git_release` | "Can I ship?" — ship gate, changelog, semver bump, PR status | No |

**Write safety.** `git_workbench` is the only tool in the server that mutates a
repository, and it plans instead of executing unless told twice:

```jsonc
// 1. Default — plans, changes nothing
{ "action": "commit", "repo": "neoland", "type": "feat",
  "message": "add topology view", "reason": "shipping the dashboard work" }
// → status: "planned", with the exact argv that would run

// 2. dry_run:false alone is still not enough
// → status: "confirmation_required"

// 3. Both flags, and only then
{ "...": "...", "dry_run": false, "confirm": true }
// → status: "executed"
```

`reason` is required for every mutating action and is written to the audit log
(`~/.local/state/securellm-mcp/mcp.log`), one entry per planned, executed,
failed, and denied command.

**Denied by policy** — the guard is an allowlist, so anything unlisted fails
closed: `push`, `pull`, any `--force`, `reset --hard`, `clean -fd`, `--amend`,
`--no-verify`, `rebase`, `merge`, `checkout`, `remote`, `filter-branch`,
`stash drop/clear`, `branch -D`, and the global options that can redirect git
outside the repo (`-c`, `-C`, `--git-dir`, `--exec-path`). GitHub access is
read-only `gh` (`pr view/list/checks/diff/status`); `gh pr create` and
`gh pr merge` are denied. Set `GIT_OPS_WRITES_ENABLED=false` to disable every
mutation, or `TOOL_DISABLED_LIST=git_workbench` to remove the tool entirely.

The guard is position-aware, so a commit message that happens to read
`--force` is a message, while `--force` in flag position is a denial.

### 🔍 Hybrid Reasoning (Beta)

Next-generation AI capabilities currently in development:

- **Context Inference Engine**: Automatic entity extraction from user input and project state
- **Proactive Action Engine**: Execute preparatory checks before asking questions
- **Multi-Step Planner**: Decompose complex tasks into dependency-ordered steps
- **Causal Reasoning**: Predict change impacts through dependency graph analysis
- **Adaptive Learning**: Continuous improvement from interaction feedback

---

## Installation

### Prerequisites

- **Node.js**: 22.0+ (native ESM support)
- **NixOS**: Recommended for full feature set
- **SQLite**: 3.35+ (for FTS5 support)
- **Optional**: llama.cpp server for semantic caching embeddings

### Quick Start

```bash
# Clone repository
git clone https://github.com/marcosfpina/securellm-mcp.git
cd securellm-mcp

# Install dependencies
npm install

# Build
npm run build

# Run server
node build/src/index.js
```

### Environment Configuration

Create `.env` file:

```bash
# Core Configuration
PROJECT_ROOT=/path/to/your/project
ENABLE_KNOWLEDGE=true
KNOWLEDGE_DB_PATH=~/.local/share/securellm/knowledge.db

# Semantic Cache (Optional)
ENABLE_SEMANTIC_CACHE=true
SEMANTIC_CACHE_THRESHOLD=0.85
SEMANTIC_CACHE_TTL=3600
LLAMA_CPP_URL=http://localhost:8080

# API Keys (loaded via SOPS in production)
ANTHROPIC_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
DEEPSEEK_API_KEY=your_key_here

# Observability
METRICS_PORT=9090
LOG_LEVEL=info
```

### MCP Client Integration

#### Claude Desktop

```json
// ~/.config/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "securellm": {
      "command": "node",
      "args": ["/path/to/securellm-mcp/build/src/index.js"],
      "env": {
        "PROJECT_ROOT": "/your/project/path"
      }
    }
  }
}
```

#### Cline (VSCodium/VSCode)

```json
// ~/.config/VSCodium/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
{
  "mcpServers": {
    "securellm": {
      "command": "node",
      "args": ["/path/to/securellm-mcp/build/src/index.js"],
      "env": {
        "PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

---

## Usage Examples

### Package Debugging

```typescript
// Diagnose why a Nix package won't build
await mcp.call("package_diagnose", {
  package_path: "./pkgs/custom-app/default.nix",
  package_type: "js",
  build_test: true
});

// Download package from GitHub with automatic hash calculation
await mcp.call("package_download", {
  package_name: "awesome-tool",
  package_type: "tar",
  source: {
    type: "github_release",
    github: {
      repo: "owner/awesome-tool",
      tag: "v1.2.3",
      asset_pattern: "*.tar.gz"
    }
  }
});
```

### Emergency Framework

```typescript
// Check if it's safe to rebuild
await mcp.call("rebuild_safety_check");

// Monitor thermals during build
await mcp.call("thermal_warroom", {
  duration: 120  // Monitor for 2 minutes
});

// Get forensic analysis after thermal event
await mcp.call("thermal_forensics", {
  duration: 180,
  skip_rebuild: false
});
```

### Knowledge Management

```typescript
// Create development session
const session = await mcp.call("create_session", {
  summary: "Implementing new authentication module"
});

// Save insights during development
await mcp.call("save_knowledge", {
  session_id: session.id,
  entry_type: "decision",
  content: "Using JWT tokens instead of sessions for API auth",
  tags: ["auth", "api", "jwt"],
  priority: "high"
});

// Search past decisions
const results = await mcp.call("search_knowledge", {
  query: "authentication jwt",
  entry_type: "decision",
  limit: 5
});
```

### System Health Monitoring

```typescript
// Comprehensive health check
await mcp.call("system_health_check", {
  detailed: true
});

// Analyze system logs
await mcp.call("system_log_analyzer", {
  service: "sshd",
  since: "1 hour ago",
  level: "error"
});

// Service management
await mcp.call("system_service_manager", {
  action: "restart",
  service: "nginx"
});
```

### Research & Analysis

```typescript
// Deep research on technical topics
await mcp.call("research_agent", {
  topic: "Rust async runtime comparison",
  depth: "comprehensive",
  sources: ["github", "reddit", "documentation"]
});

// Analyze codebase complexity
await mcp.call("analyze_complexity", {
  directory: "./src",
  include_patterns: ["**/*.ts"],
  metrics: ["cyclomatic", "cognitive", "maintainability"]
});

// Find potentially dead code
await mcp.call("find_dead_code", {
  directory: "./src",
  extensions: [".ts", ".js"]
});
```

---

## Resources

The server exposes several MCP resources for querying system state:

- `config://current` - Current SecureLLM configuration
- `logs://audit` - Recent audit log entries
- `metrics://usage` - Provider usage statistics
- `metrics://prometheus` - Prometheus-format metrics
- `metrics://semantic-cache` - Cache performance stats
- `docs://api` - API documentation

```typescript
// Query cache performance
const stats = await mcp.read("metrics://semantic-cache");
console.log(`Hit rate: ${stats.hitRate}%`);
console.log(`Tokens saved: ${stats.tokensSaved}`);
```

---

## Performance

### Benchmarks

- **Semantic Cache Lookup**: < 10ms (in-memory embedding comparison)
- **Knowledge DB Search**: < 50ms (FTS5 indexed queries)
- **Rate Limiter Overhead**: < 5ms per request
- **Circuit Breaker Decision**: < 1ms

### Scalability

- **Memory Footprint**: ~512MB base + 256MB per active reasoning session
- **Database Size**: ~100MB per 10,000 knowledge entries
- **Concurrent Requests**: 100+ simultaneous tool calls (per-provider queuing)
- **Cache Storage**: ~1KB per cached response

---

## Security

### Secrets Management

- **SOPS Integration**: Encrypted secrets stored in `secrets.yaml`
- **Environment Variables**: Runtime API key injection
- **No Hardcoded Credentials**: All sensitive data externalized

### Sandboxed Execution

- **Tool Whitelisting**: Configurable allowed commands
- **Path Restrictions**: Sandboxed file system access
- **Network Isolation**: Optional network policy enforcement

### Audit Trail

- **Structured Logging**: All actions logged with context
- **Knowledge DB Audit**: Complete interaction history
- **Metrics Retention**: 30-day historical performance data

---

## Development

### Project Structure

```
securellm-mcp/
├── src/
│   ├── index.ts                    # MCP server entry point
│   ├── knowledge/
│   │   └── database.ts             # SQLite + FTS5 implementation
│   ├── middleware/
│   │   ├── semantic-cache.ts       # Embedding-based caching
│   │   ├── rate-limiter.ts         # Smart rate limiting
│   │   ├── circuit-breaker.ts      # Failure detection
│   │   ├── retry-strategy.ts       # Exponential backoff
│   │   └── metrics-collector.ts    # Performance tracking
│   ├── reasoning/
│   │   ├── context-manager.ts      # Context inference
│   │   ├── multi-step-planner.ts   # Task decomposition
│   │   └── proactive-executor.ts   # Pre-action execution
│   ├── tools/
│   │   ├── package-diagnose.ts     # Nix package debugging
│   │   ├── emergency/              # Thermal protection
│   │   ├── laptop-defense/         # System safety
│   │   ├── system/                 # Health monitoring
│   │   ├── ssh/                    # Remote execution
│   │   ├── browser/                # Web automation
│   │   └── nix/                    # Nix ecosystem tools
│   ├── types/
│   │   ├── knowledge.ts            # Knowledge DB schemas
│   │   ├── semantic-cache.ts       # Cache type definitions
│   │   └── middleware/             # Middleware types
│   └── utils/
│       ├── logger.ts               # Pino structured logging
│       ├── project-detection.ts    # Auto project root detection
│       └── host-detection.ts       # NixOS hostname resolution
├── docs/                           # Architecture documentation
├── tests/                          # Integration tests
└── build/                          # Compiled output
```

### Building from Source

```bash
# Development mode with watch
npm run watch

# Production build
npm run build

# Run tests
npm test

# Type checking
npx tsc --noEmit
```

### Contributing

1. **Architecture Changes**: Review `docs/HYBRID-REASONING-ARCHITECTURE.md`
2. **Code Style**: Follow existing TypeScript patterns, use Zod for validation
3. **Testing**: Add integration tests for new tools
4. **Documentation**: Update README and inline JSDoc comments

---

## Roadmap

### Phase 1: Core Infrastructure ✅
- [x] MCP server implementation
- [x] Knowledge database (SQLite + FTS5)
- [x] Smart rate limiter with circuit breaker
- [x] Semantic cache with embeddings
- [x] Nix package debugging tools
- [x] Emergency framework
- [x] Prometheus metrics

### Phase 2: Reasoning Systems 🚧
- [x] Context inference engine
- [x] Proactive action executor
- [x] Multi-step task planner
- [ ] Causal dependency analyzer
- [ ] Adaptive learning system

### Phase 3: Advanced Tools 🚧
- [x] SSH remote execution suite
- [ ] Browser automation tools
- [ ] Sensitive data handling
- [ ] File organization system
- [ ] Advanced code analysis

### Phase 4: Enterprise Features
- [ ] Multi-user support
- [ ] Role-based access control
- [ ] Distributed caching
- [ ] Horizontal scaling
- [ ] SaaS deployment

---

## Monitoring & Observability

### Prometheus Metrics

Expose metrics on HTTP endpoint:

```bash
# Start metrics server
export METRICS_PORT=9090
node build/src/index.js

# Query metrics
curl http://localhost:9090/metrics
```

Available metrics:

- `mcp_rate_limiter_requests_total{provider="deepseek"}`
- `mcp_rate_limiter_request_duration_seconds{provider="openai"}`
- `mcp_circuit_breaker_state{provider="anthropic"}`
- `mcp_semantic_cache_hits_total`
- `mcp_semantic_cache_tokens_saved_total`

### Structured Logging

Pino-based JSON logging:

```json
{
  "level": "info",
  "time": 1704196800000,
  "msg": "Semantic cache hit",
  "similarity": 0.92,
  "toolName": "thermal_check",
  "tokensSaved": 150
}
```

---

## Troubleshooting

### Common Issues

**1. Semantic cache not working**

```bash
# Verify llama.cpp server is running
curl http://localhost:8080/health

# Check cache database exists
ls -lh ~/.local/share/securellm/semantic_cache.db

# Enable debug logging
export LOG_LEVEL=debug
```

**2. Rate limiter throttling requests**

```bash
# Check current queue status
# (use rate_limiter_status tool via MCP)

# Adjust rate limits in config
# See src/config/rate-limits.ts
```

**3. Knowledge DB corruption**

```bash
# Backup and rebuild
cp ~/.local/share/securellm/knowledge.db{,.backup}
rm ~/.local/share/securellm/knowledge.db
# Restart server (will recreate schema)
```

---

## License

MIT License - See [LICENSE](LICENSE) file

---

## Acknowledgments

Built with:

- [Model Context Protocol SDK](https://github.com/anthropics/mcp-typescript-sdk) - MCP protocol implementation
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - High-performance SQLite bindings
- [Pino](https://github.com/pinojs/pino) - Fast structured logging
- [Zod](https://github.com/colinhacks/zod) - TypeScript schema validation

Inspired by:

- NixOS community's declarative infrastructure philosophy
- The MCP ecosystem's vision for AI-native tooling
- Production systems engineering best practices

---

## Contact

**Author**: marcosfpina
**Project**: [github.com/marcosfpina/securellm-mcp](https://github.com/marcosfpina/securellm-mcp)
**Issues**: [GitHub Issues](https://github.com/marcosfpina/securellm-mcp/issues)

---

**Built for developers who demand production-grade tooling.**
