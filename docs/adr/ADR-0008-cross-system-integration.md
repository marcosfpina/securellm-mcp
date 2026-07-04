---
id: "ADR-0008"
title: "Cross-System Integration: MCP ↔ Cerebro RAG ↔ ADR Ledger"
status: proposed
date: "2026-05-03"
classification: critical
project: "GLOBAL"
---

## Context

A stack VoidNxSEC tem três sistemas maduros que operam em isolamento:

| Sistema | Propósito | Interface | Porta |
|---------|-----------|-----------|-------|
| **securellm-mcp** | MCP server com 87 tools, knowledge DB, cache | stdio / HTTP metrics | :3000 |
| **Cerebro** | RAG enterprise, code analysis, dashboard | CLI / TUI / REST API | :8009 (API), :18321 (dashboard) |
| **ADR Ledger** | Governance de decisões arquiteturais, blockchain | CLI / Markdown / MCP tools | — |

Atualmente eles não se comunicam. O potencial de integração é enorme:
- MCP tem o contexto do usuário em tempo real
- Cerebro tem a capacidade de busca semântica e análise de código
- ADR Ledger tem o histórico de decisões e governance

## Decision

Estabelecer um protocolo de integração bidirecional entre os três sistemas:

```
                    ┌──────────────────────────────────────┐
                    │           ADR Ledger                 │
                    │  (source of truth for decisions)     │
                    └──────────┬───────────────────────────┘
                               │ adr_context(), sync
                               ▼
┌──────────────────────┐     ┌──────────────────────────────┐
│   securellm-mcp      │────▶│         Cerebro              │
│   (real-time agent)  │◀────│   (deep analysis & search)   │
└──────────────────────┘     └──────────────────────────────┘
         │  recall()                     │  query()
         │  adr_context()                │  ingest()
         ▼                               ▼
┌──────────────────────┐     ┌──────────────────────────────┐
│  Knowledge DB (SQL)  │     │  ChromaDB + Elasticsearch    │
│  FTS5 + embeddings   │     │  + code analysis artifacts   │
└──────────────────────┘     └──────────────────────────────┘
```

### Protocolo de comunicação:

```
MCP ──GET /api/rag/query──▶ Cerebro     (busca semântica)
MCP ──POST /api/rag/ingest─▶ Cerebro    (indexar conhecimento)
MCP ──read adr/*.md────────▶ ADR Ledger (consultar decisões)
MCP ──adr_context()────────▶ ADR Ledger (busca contextual de ADRs)
```

### Ferramentas que materializam a integração:

| Tool | Origem | Função na integração |
|------|--------|---------------------|
| `session_bridge` | Novo (ADR-0003) | Orquestrador: recall via Cerebro, contexto via ADR Ledger |
| `research_agent` | Existente | Busca multi-source que pode consumir Cerebro como fonte |
| `adr_context` (dentro de session_bridge) | Novo | Parse e busca nas ADRs do ledger |
| `sync_cerebro` (dentro de session_bridge) | Novo | Sincronizar knowledge entries → Cerebro |

## Rationale

### Drivers

1. **Eliminar silos**: Três sistemas excelentes que não se falam é desperdício
2. **Cada sistema no seu forte**: MCP = real-time, Cerebro = deep search, ADR Ledger = governance
3. **Baixo acoplamento**: APIs REST + leitura de arquivos, sem dependências de código
4. **Prepara para Fase 4**: Multi-user, distributed caching — precisa de integração entre sistemas

### Alternativas Consideradas

#### Opção A: Unificar tudo em um monolito
- **Pros:** Simples, sem latência de rede
- **Cons:** Perde modularidade, cada sistema tem seu domínio, pesadelo de manutenção
- **Por que rejeitada:** Violação do princípio de separação de responsabilidades

#### Opção B: Message broker (NATS/Kafka)
- **Pros:** Event-driven, escalável, desacoplado
- **Cons:** Overkill agora, adiciona infraestrutura, complexidade operacional
- **Por que rejeitada:** Planejado pra Fase 4 (Enterprise), não agora

### Trade-offs

- **Latência**: Chamadas HTTP adicionam latência, mas são assíncronas e cacheadas
- **Disponibilidade**: Se Cerebro cair, MCP ainda funciona (graceful degradation)
- **Consistência eventual**: Índices podem divergir; sync periódico resolve

## Consequences

### Positive

- Stack integrada, cada sistema potencializado pelos outros
- Agente MCP tem acesso a busca semântica (Cerebro) + decisões históricas (ADR Ledger)
- Base pra features enterprise (multi-user, distributed cache)
- Documentação clara de como os sistemas se relacionam

### Negative

- Mais superfície de falha (3 sistemas em vez de 1)
- Configuração mais complexa
- Precisa manter compatibilidade de API entre versões

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Cerebro API breaking change | médio | médio | Versionar API (/api/v1/...); testes de integração |
| ADR schema change | baixo | baixo | Parser tolerante; campos opcionais |
| Tráfego entre sistemas sobrecarrega rede | baixo | baixo | Cache agressivo; batch operations |

## Implementation

### Fase 1: Integração básica (agora)
- [ ] `session_bridge` com recall via Cerebro e adr_context via ADR Ledger
- [ ] Health checks cross-system no `server_health`
- [ ] Documentação da arquitetura integrada no README

### Fase 2: Sync bidirecional (próximo)
- [ ] `sync_cerebro`: MCP → Cerebro (knowledge entries viram documentos RAG)
- [ ] Cerebro → MCP: resultados de análise de código alimentam knowledge DB
- [ ] ADR Ledger → MCP: novas ADRs automaticamente disponíveis no contexto

### Fase 3: Event-driven (Fase 4 Enterprise)
- [ ] Message broker (NATS) para eventos entre sistemas
- [ ] Webhooks: nova ADR → notifica MCP → atualiza contexto
- [ ] Distributed cache entre MCP e Cerebro

### Dependências

- Cerebro API rodando em `localhost:8009`
- ADR Ledger em `~/master/adr-ledger`
- `session_bridge` tool (ADR-0003)

### Timeline

- Fase 1: 8 horas (junto com ADR-0003)
- Fase 2: 4 horas adicionais
- Fase 3: Planejamento futuro (Fase 4 do roadmap)

## Relações com ADRs existentes

| ADR | Relação |
|-----|---------|
| ADR-0001 (Optimize MCP) | Pré-requisito: knowledge engine + proactive reasoning ativos |
| ADR-0003 (Session Bridge) | Tool que implementa a integração |
| ADR-0005 (Notify Hook) | Notificações跨-system |
| ADR-0007 (Meta Tool) | Pipelines跨-system |
| ADR-0012 (STF Protocol) | Governance que rege a integração |
| ADR-0014 (Spider-Nix + Phantom RAG) | Pipeline de inteligência upstream |
