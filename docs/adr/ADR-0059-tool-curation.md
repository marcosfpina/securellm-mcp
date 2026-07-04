---
id: "ADR-0059"
title: "Tool Curation — Slim Down to Ecosystem-Aligned Toolset"
status: proposed
date: "2026-05-03"
classification: major
project: "GLOBAL"
---

## Context

O `securellm-mcp` tem 87 tools registradas. Uma análise de relevância revelou:

1. **Laptop Defense** (8 tools): ferramentas de monitoramento térmico criadas sem caso de uso claro
2. **Emergency** (7 tools): `emergency_nuke` e `emergency_swap` são perigosos
3. **Browser** (5 tools): Puppeteer+Chromium pesam >500MB; `spider-nix` já faz crawler/OSINT
4. **OSINT** (3 tools + web_crawl): `spider-nix` é o projeto canônico de red team
5. **Redundâncias**: `build_and_test`, `security_audit`, `crypto_key_generate`, `tech_news_search`
6. **Ecossistema real**: 19 projetos em `~/master/` — tools devem refletir a stack VoidNxSEC

## Decision

Reduzir de 87 para ~62 tools, reorganizadas por afinidade ao ecossistema:

### ❌ REMOVER (25 tools)

| # | Tool | Motivo |
|---|------|--------|
| 1-8 | `thermal_check`, `thermal_forensics`, `thermal_warroom`, `rebuild_safety_check`, `laptop_verdict`, `full_investigation`, `force_cooldown`, `reset_performance` | Laptop Defense — sem caso de uso claro. Código arquivado em `src/tools/laptop-defense/` (não deletado). |
| 9-12 | `emergency_abort`, `emergency_cooldown`, `emergency_nuke`, `emergency_swap` | Perigosos (`nuke` mata processos aleatórios). Manter `emergency_status`. |
| 13-15 | `osint_dns`, `osint_subdomains`, `osint_portscan` | Redundantes — `spider-nix` já é o projeto canônico de OSINT. |
| 16 | `web_crawl` | Redundante — `spider-nix crawl` faz melhor. |
| 17-18 | `browser_launch_advanced`, `browser_extract_data` | Puppeteer pesado. `spider-nix` faz browser automation. |
| 19-20 | `browser_interact_form`, `browser_monitor_changes` | Puppeteer pesado, nicho. |
| 21 | `tech_news_search` | Hacker News/Reddit — raramente usado. |
| 22 | `crypto_key_generate` | Muito específico (TLS keys). |
| 23 | `build_and_test` | Só roda `npm test` local — frágil. |
| 24 | `security_audit` | Implementação genérica, sem valor real. |
| 25 | `browser_search_aggregate` | Sobreposição com `web_search` + `research_agent`. |

### 🆕 ADICIONAR (6 tools do coquetel)

| # | Tool | ADR | Descrição |
|---|------|-----|-----------|
| 1 | `nvim_context` | 0002 | Live editor context via Neovim msgpack-RPC |
| 2 | `session_bridge` | 0003 | Persistent memory via Cerebro RAG + ADR Ledger |
| 3 | `nix_daemon` | 0004 | Nix store health, GC, generation diff |
| 4 | `notify_hook` | 0005 | Async notifications (ntfy/Discord/local) |
| 5 | `git_sherlock` | 0006 | Git forensics, heatmaps, smart commits |
| 6 | `meta_tool` | 0007 | Declarative tool composition pipeline |

### ✅ RESULTADO FINAL: ~68 tools

| Categoria | Antes | Depois | Delta |
|-----------|-------|--------|-------|
| Core/Infra | 14 | 11 | -3 |
| Knowledge | 7 | 7 | 0 |
| Emergency | 7 | 3 | -4 |
| Laptop Defense | 8 | 0 | -8 |
| Web Search | 8 | 5 | -3 |
| OSINT | 4 | 0 | -4 |
| Browser | 5 | 0 | -5 |
| ADR | 22 | 22 | 0 |
| DevTools | 4 | 4 | 0 |
| Professional | 11 | 11 | 0 |
| SSH | 6 | 6 | 0 |
| **Novas** | 0 | **6** | +6 |
| **TOTAL** | **87** | **~68** | **-19** |

### Catálogo final:

```
CORE (11):
  server_status          server_health           cache_stats
  cache_tuning_advisor   rate_limit_check        rate_limiter_status
  provider_test          provider_config_validate
  tool_control_plane     performance_report
  workspace_quality_gate

KNOWLEDGE (7):
  create_session         save_knowledge           search_knowledge
  load_session           list_sessions            get_recent_knowledge
  knowledge_maintenance

EMERGENCY (3):
  emergency_status       system_health_check      safe_rebuild_check

WEB SEARCH (5):
  web_search             github_search            stackoverflow_search
  nix_search             nixos_discourse_search

ADR (22):
  (todas mantidas — integração com ADR Ledger)

DEV TOOLS (4):
  lint_code              format_code              run_tests
  github_actions

PROFESSIONAL (11):
  format_check           lint                     build
  change_impact          ci_failure_summary       ci_batch_triage
  advanced_code_analysis analyze_complexity       find_dead_code
  research_agent         execute_in_sandbox

SSH (6):
  ssh_execute            ssh_file_transfer         ssh_maintenance_check
  ssh_tunnel             ssh_jump_host             ssh_session_manager

NIX ECOSYSTEM (3):
  package_diagnose       package_download          package_configure

NOVAS — ECOSYSTEM (6):
  nvim_context           session_bridge            nix_daemon
  notify_hook            git_sherlock              meta_tool
```

## Rationale

### Drivers

1. **Foco no ecossistema**: Tools devem refletir a stack VoidNxSEC (19 projetos), não casos de uso hipotéticos
2. **spider-nix é o canônico**: Browser automation, crawler, OSINT → spider-nix. MCP não precisa duplicar
3. **Segurança**: Remover `emergency_nuke` e similares reduz superfície de ataque
4. **Manutenibilidade**: Menos código = menos bugs = mais velocidade
5. **Go-to-market**: Toolset enxuto e ecossistêmico é mais atraente pra novos usuários (ADR-0055)

### Alternativas Consideradas

#### Opção A: Manter tudo (status quo)
- **Pros:** Nenhum esforço
- **Cons:** 87 tools com ~25 redundantes/perigosas/inúteis; manutenção custosa; confusão pro usuário
- **Por que rejeitada:** Vai contra ADR-0055 (go-to-market) e ADR-0052 (ecosystem integration)

#### Opção B: Feature flags pra tudo
- **Pros:** Flexibilidade
- **Cons:** Complexidade; todo tool precisa de `if (ENABLE_FEATURE_X)`
- **Por que rejeitada:** Overhead. Melhor remover código morto; se precisar, re-adiciona depois

### Trade-offs

- **Código arquivado, não deletado**: `src/tools/laptop-defense/` e `src/tools/browser/` ficam no repo
- **spider-nix perde integração MCP**: Ferramentas OSINT somem do catálogo. Mas spider-nix pode ter seu próprio MCP server no futuro
- **Menos é mais**: Catálogo menor = onboarding mais rápido = mais estrelas no GitHub

## Consequences

### Positive

- Toolset focado no ecossistema VoidNxSEC
- Menos superfície de ataque (sem `emergency_nuke`)
- Build mais leve (sem Puppeteer/Chromium forçado)
- Onboarding mais claro pra novos usuários
- Alinhado com ADR-0055 (go-to-market)

### Negative

- Perde capacidade de OSINT/browser automation no MCP
- Usuários que usavam laptop defense perdem as tools
- Código arquivado pode acumular bitrot

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Usuário depende de tool removida | baixo | médio | Código arquivado, não deletado; fácil reativação |
| spider-nix sem MCP | médio | baixo | spider-nix pode ganhar MCP server próprio depois |
| Regressão no build | baixo | médio | CI gate com tool count validation (ADR-0057) |

## Implementation

### Tasks — Remoção

- [ ] Remover imports de `laptopDefenseTools` do `buildToolCatalog()`
- [ ] Remover imports de `browserTools` do `buildToolCatalog()`
- [ ] Remover `osint_*`, `web_crawl`, `tech_news_search` do catálogo
- [ ] Remover `emergency_abort/cooldown/nuke/swap` do catálogo
- [ ] Remover `build_and_test`, `security_audit`, `crypto_key_generate` do catálogo
- [ ] Manter código fonte (arquivos não deletados, só desregistrados)
- [ ] Atualizar `buildServerStatus()` pra refletir tool count real
- [ ] Rodar testes (257 atuais devem continuar passando)
- [ ] Rodar lint (0 errors)

### Tasks — Manifest (ADR-0057)

- [ ] Criar script `npm run build:manifest` que gera `.mcp.json` automático
- [ ] Padronizar invocação em todos os `.mcp.json`
- [ ] CI gate: validar tool count pós-build

### Dependências

- ADR-0057 (manifest automático) — em paralelo
- ADR-0055 (go-to-market strategy) — alinhamento estratégico
- Test suite existente (257 tests)
- spider-nix (projeto standalone — sem mudanças necessárias)

### Timeline

~3 horas (remoção) + 2 horas (manifest) = 5 horas total
