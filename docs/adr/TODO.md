# TODO — SecureLLM MCP Server Optimization Roadmap

> Última atualização: 2026-05-03

## Fase 1: Curadoria de Tools (ADR-0059) ✅ CONCLUÍDA

### 1.1 Remover tools redundantes/perigosas
- [ ] Remover **Laptop Defense** (8): `thermal_check`, `thermal_forensics`, `thermal_warroom`, `rebuild_safety_check`, `laptop_verdict`, `full_investigation`, `force_cooldown`, `reset_performance`
- [ ] Remover **Emergency perigosas** (4): `emergency_abort`, `emergency_cooldown`, `emergency_nuke`, `emergency_swap`
- [ ] Remover **Browser** (4): `browser_launch_advanced`, `browser_extract_data`, `browser_interact_form`, `browser_monitor_changes`
- [ ] Remover **OSINT** (4): `osint_dns`, `osint_subdomains`, `osint_portscan`, `web_crawl`
- [ ] Remover **Redundantes** (5): `tech_news_search`, `crypto_key_generate`, `build_and_test`, `security_audit`, `browser_search_aggregate`
- [ ] Manter código fonte (arquivos preservados, só imports removidos)
- [ ] Atualizar `buildServerStatus()` tool count
- [ ] Rodar tests: `npm test`
- [ ] Rodar lint: `npm run lint`

### 1.2 Atualizar catálogo
- [ ] `buildToolCatalog()`: 87 → ~62 tools
- [ ] `setupToolHandlers()`: remover handlers obsoletos
- [ ] Atualizar `README.md` com novo tool count
- [ ] Commit: `refactor(tools): curate toolset down to 62 ecosystem-aligned tools`

---

## Fase 2: Manifest Automático (ADR-0057) ✅ CONCLUÍDA

### 2.1 Script de manifest
- [ ] Criar `scripts/generate-mcp-manifest.ts`
- [ ] Ler todas as tools do `buildToolCatalog()`
- [ ] Gerar `.mcp.json` com `capabilities.tools` preciso
- [ ] Adicionar `build:manifest` no `package.json`
- [ ] CI gate: `npm run build:manifest -- --check`

### 2.2 Padronizar .mcp.json
- [ ] `securellm-mcp/.mcp.json`: já usa `node build/src/index.js` ✅
- [ ] `adr-ledger/.mcp.json`: atualizar pra `node build/src/index.js`
- [ ] Documentar no README

---

## Fase 3: Novas Tools (ADR-0002 a 0007) 🟡

### 3.1 session_bridge (ADR-0003) ✅ IMPLEMENTADO
- [ ] Criar `src/tools/session-bridge.ts`
- [ ] `recall`: FTS5 local + Cerebro API (`GET localhost:8009/api/rag/query`)
- [ ] `snapshot`: inserir knowledge DB + opcional Cerebro ingest
- [ ] `adr_context`: parse ADR Markdowns (`~/master/adr-ledger/adr/`)
- [ ] `digest`: aggregation SQLite por data
- [ ] `sync_cerebro`: indexar entries no Cerebro
- [ ] Schema Zod + handler
- [ ] Registrar no `buildToolCatalog()` e `setupToolHandlers()`
- [ ] Testes unitários

### 3.2 nvim_context (ADR-0002) ✅ IMPLEMENTADO
- [ ] Criar `src/tools/nvim-context.ts`
- [ ] Conexão socket UNIX + msgpack-RPC
- [ ] `get_buffer`, `get_selection`, `get_diagnostics`, `get_visible_range`
- [ ] Whitelist de comandos vim seguros
- [ ] Schema Zod + handler
- [ ] Testes unitários

### 3.3 nix_daemon (ADR-0004) ✅ IMPLEMENTADO
- [ ] Criar `src/tools/nix-daemon.ts`
- [ ] `store_health`, `gc`, `diff_generation`, `list_generations`, `optimise`, `verify`
- [ ] Schema Zod + handler
- [ ] Testes unitários

### 3.4 git_sherlock (ADR-0006) ✅ IMPLEMENTADO
- [ ] Criar `src/tools/git-sherlock.ts`
- [ ] `blame_heatmap`, `what_changed`, `review_uncommitted`, `churn`, `authors`, `file_history`
- [ ] Schema Zod + handler
- [ ] Testes unitários

### 3.5 notify_hook (ADR-0005) ✅ IMPLEMENTADO
- [ ] Criar `src/tools/notify-hook.ts`
- [ ] `send`: ntfy.sh, Gotify, Discord, notify-send
- [ ] `watch`: monitor PID
- [ ] Schema Zod + handler
- [ ] Testes unitários

### 3.6 meta_tool (ADR-0007) ✅ IMPLEMENTADO
- [ ] Criar `src/tools/meta-tool.ts`
- [ ] Parser de referências ($prefix.field)
- [ ] Executor sequencial + paralelo
- [ ] Detector de ciclos
- [ ] Validação contra ToolGovernanceManager
- [ ] Template system
- [ ] Schema Zod + handler
- [ ] Testes

---

## Fase 4: Integração Cross-System (ADR-0008) 🟢

### 4.1 Health checks
- [ ] `server_health` verifica Cerebro API (`localhost:8009`), ADR Ledger
- [ ] Status report cross-system no `server_status`

### 4.2 Documentação
- [ ] Diagrama de arquitetura integrada no README
- [ ] Guia de integração: MCP ↔ Cerebro ↔ ADR Ledger

---

## Fase 5: Polish & Go-to-Market (ADR-0055) 🟢

### 5.1 Qualidade
- [ ] CI verde: build + test + lint
- [ ] README polido com exemplos
- [ ] CHANGELOG atualizado

### 5.2 Distribuição
- [ ] GitHub release
- [ ] Nix package update
- [ ] Divulgação (comunidade NixOS, MCP, etc)

---

## Resumo

| Fase | ADR | Esforço | Status |
|------|-----|---------|--------|
| 1. Curadoria | 0059 | 3h | ⬜ Não iniciado |
| 2. Manifest | 0057 | 2h | ⬜ Não iniciado |
| 3. Novas Tools | 0002-0007 | 32h | ⬜ Não iniciado |
| 4. Cross-System | 0008 | 4h | ⬜ Não iniciado |
| 5. Go-to-Market | 0055 | 4h | ⬜ Não iniciado |
| **TOTAL** | | **45h** | |

---

## Legend

- 🔴 Fase atual
- 🟡 Próxima
- 🟢 Futuro
- ✅ Completo
- ⬜ Não iniciado
