---
id: "ADR-0003"
title: "Session Bridge — Persistent Cross-Session Memory via Cerebro RAG + ADR Ledger"
status: proposed
date: "2026-05-03"
classification: major
project: "GLOBAL"
---

## Context

Atualmente, cada conversa com o agente é stateless. Temos três sistemas que, integrados,
podem resolver isso de forma elegante:

1. **securellm-mcp**: Knowledge DB SQLite + FTS5 (2.2GB), Semantic Cache com llama.cpp embeddings
2. **Cerebro** (`~/master/cerebro`): Plataforma RAG enterprise com API REST (`localhost:8009`),
   ingestão de documentos, busca semântica via ChromaDB, suporte a LLM providers
3. **ADR Ledger** (`~/master/adr-ledger`): 57 ADRs (35 accepted, 22 proposed) em Markdown 
   estruturado com blockchain de governança, schema validation, OPA policies

O caminho natural é: o `session_bridge` não reimplementa busca semântica — ele **delega ao Cerebro**
a parte de retrievial e usa o ADR Ledger como fonte de decisões históricas.

## Decision

Criar a tool `session_bridge` como **camada de orquestração** entre o MCP, Cerebro e ADR Ledger:

```
┌──────────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   session_bridge     │────▶│     Cerebro      │────▶│   ADR Ledger     │
│   (orquestrador)     │     │   (RAG engine)   │     │  (decisões hist) │
└──────────────────────┘     └──────────────────┘     └──────────────────┘
         │                           │
         ▼                           ▼
┌──────────────────────┐     ┌──────────────────┐
│  Knowledge DB (SQL)  │     │  ChromaDB (vec)  │
│  FTS5 + metadata     │     │  + llama.cpp emb │
└──────────────────────┘     └──────────────────┘
```

### Schema:

```
session_bridge {
  action: "recall" | "snapshot" | "digest" | "adr_context" | "sync_cerebro"
  
  // recall — busca local (SQLite FTS5) + semântica (Cerebro API)
  context?: string        // descrição do que o usuário está fazendo agora
  limit?: number          // máximo de entradas
  include_adrs?: boolean  // também buscar ADRs relacionadas no ledger
  
  // snapshot — salva estado da conversa
  tags?: string[]
  summary?: string
  files?: string[]
  sync_to_cerebro?: boolean  // também indexar no Cerebro pra busca semântica futura
  
  // digest — resumo temporal
  since?: string          // "today", "yesterday", "this week"
  
  // adr_context — busca ADRs relevantes no ledger
  context: string         // descrição do que está sendo decidido agora
  project?: string        // filtrar por projeto (CEREBRO, SPECTRE, etc)
  
  // sync_cerebro — indexa knowledge entries no Cerebro
  since?: string          // "last_snapshot", "today", "1 week ago"
  entry_types?: string[]  // filtrar tipos
}
```

### Exemplo de fluxo:

1. Usuário: "preciso debugar o erro de hash mismatch no nixos-rebuild"
2. `session_bridge.recall("hash mismatch nixos rebuild")` →
   - SQLite FTS5 local: acha 3 sessões anteriores sobre nixos-rebuild
   - Cerebro API (`GET /api/rag/query?q=...`): acha documentos relacionados
3. `session_bridge.adr_context("nixos build failure")` →
   - Varre ADR-ledger por ADRs sobre build, CI/CD, Nix store
   - Retorna ADR-0012 (STF Protocol), ADR-0026 (Code Quality), etc

## Rationale

### Drivers

1. **Não reinventar a roda**: Cerebro já é um RAG engine maduro com ingestão, busca semântica, 
   ChromaDB, suporte a múltiplos LLM providers
2. **ADR Ledger como fonte canônica**: 57 ADRs documentam decisões arquiteturais — 
   o agente pode consultar o histórico de decisões antes de sugerir novas
3. **Caminho natural de integração**: Cerebro → MCP → ADR Ledger é o fluxo de 
   inteligência da stack VoidNxSEC
4. **Baixo acoplamento**: session_bridge só chama APIs REST, não depende de imports

### Alternativas Consideradas

#### Opção A: Reimplementar RAG no MCP (ADR original)
- **Pros:** Zero dependências externas
- **Cons:** Duplicação de esforço; Cerebro já faz melhor; 2 codebases de busca
- **Por que rejeitada:** O ecossistema já tem a solução pronta

#### Opção B: Migrar tudo pro Cerebro
- **Pros:** Consolidação
- **Cons:** MCP perderia capacidade offline; latência de rede; acoplamento forte
- **Por que rejeitada:** MCP precisa funcionar standalone também

### Trade-offs

- **Disponibilidade**: Se Cerebro estiver offline, fallback pra SQLite local apenas
- **Latência**: Chamada HTTP adiciona ~20-50ms vs busca puramente local
- **Consistência**: Dois índices (SQLite + ChromaDB) podem divergir — sync periódico resolve

## Consequences

### Positive

- Agente tem acesso ao conhecimento histórico completo (MCP + Cerebro + ADRs)
- Decisões arquiteturais passadas informam sugestões atuais
- Cerebro pode indexar conhecimento pra busca semântica de alta qualidade
- Stack VoidNxSEC integrada: MCP ↔ Cerebro ↔ ADR Ledger

### Negative

- Dependência do Cerebro estar rodando (`cerebro dashboard` ou API)
- Dois índices pra manter em sync
- Mais complexidade de configuração

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Cerebro offline | médio | baixo | Fallback para SQLite FTS5 local; graceful degradation |
| Índices divergem | baixo | médio | `sync_cerebro` action periódica; checksum validation |
| ADR ledger schema muda | baixo | baixo | Parser tolerante a campos novos; sem breaking changes |

## Implementation

### Tasks

- [ ] Criar `src/tools/session-bridge.ts` com schema Zod + handler
- [ ] `recall`: FTS5 local + fetch `GET localhost:8009/api/rag/query` (Cerebro)
- [ ] `snapshot`: inserir no knowledge DB + opcionalmente `POST localhost:8009/api/rag/ingest`
- [ ] `digest`: aggregation query SQLite por data
- [ ] `adr_context`: parse dos Markdowns do ADR ledger (`~/master/adr-ledger/adr/`)
- [ ] `sync_cerebro`: ler entradas recentes, gerar JSONL, enviar pro Cerebro ingestar
- [ ] Integrar com `PreActionInterceptor` pra recall automático
- [ ] Config: `CEREBRO_API_URL` (default: `http://localhost:8009`), `ADR_LEDGER_PATH` (default: `~/master/adr-ledger`)
- [ ] Registrar no `buildToolCatalog()` e `setupToolHandlers()`
- [ ] Testes unitários com mock de fetch

### Dependências

- **Cerebro RAG API** (`localhost:8009`): endpoints `/api/rag/query`, `/api/rag/ingest`
- **ADR Ledger** (`~/master/adr-ledger/adr/`): Markdown files com frontmatter YAML
- **Knowledge DB** (já existe)
- **Semantic Cache** (já existe, com llama.cpp embeddings)
- **PreActionInterceptor** (já existe — hook point pra recall automático)

### Relações com ADRs existentes

| ADR | Relação |
|-----|---------|
| ADR-0012 (STF Protocol) | Governance que rege o fluxo MCP→Cerebro→Ledger |
| ADR-0014 (Spider-Nix + Phantom RAG) | Pipeline de inteligência que o session_bridge pode consumir |
| ADR-0026 (Code Quality) | Correções que habilitaram a integração estável |
| ADR-0029 (Modularize large files) | Refator que o session_bridge pode ajudar a rastrear |

### Timeline

~8 horas de desenvolvimento (2h extras pela integração com Cerebro + ADR Ledger)
