---
id: "ADR-0007"
title: "Meta Tool — Declarative Tool Composition Pipeline Engine"
status: proposed
date: "2026-05-03"
classification: critical
project: "GLOBAL"
---

## Context

Atualmente, cada tool call é atômico e isolado. Para executar workflows multi-step
(quality gate → git review → notify), o agente precisa fazer múltiplos tool calls
sequenciais, esperar cada uma, passar output manualmente. Isso é:

- **Lento**: Cada round-trip agente↔server adiciona latência
- **Frágil**: Se uma tool falha, o agente precisa decidir o que fazer
- **Verbaloso**: O output de uma tool polui o contexto antes da próxima

## Decision

Criar a tool `meta_tool` — um mini workflow engine declarativo que:

1. Aceita um pipeline de tool calls com dependências
2. Executa no server-side (sem round-trips)
3. Passa output de uma tool como input da próxima (com transformações)
4. Suporta condicionais (`on_failure`, `on_success`)
5. Retorna apenas o resultado consolidado

### Schema:

```
meta_tool {
  pipeline: [
    {
      tool: string                    // nome da tool
      args?: object                   // argumentos (pode referenciar outputs anteriores com $prefix)
      output_as?: string              // alias pra referenciar este output depois
      on_failure?: "stop" | "skip" | "continue"
      timeout_ms?: number
      condition?: string              // "$previous.success === true"
    }
  ]
  
  // Opções globais
  parallel?: boolean                  // executar steps independentes em paralelo
  stop_on_first_failure?: boolean     // default: true
  max_total_timeout_ms?: number
}
```

### Exemplo:

```json
{
  "pipeline": [
    {
      "tool": "workspace_quality_gate",
      "args": { "profile": "quick" },
      "output_as": "quality",
      "on_failure": "stop"
    },
    {
      "tool": "git_sherlock",
      "args": { "action": "review_uncommitted" },
      "output_as": "git_review",
      "on_failure": "skip"
    },
    {
      "tool": "notify_hook",
      "args": {
        "action": "send",
        "channel": "ntfy.sh/builds",
        "message": "Quality: $quality.summary.overall_status | Changes: $git_review.summary"
      },
      "on_failure": "continue"
    }
  ]
}
```

## Rationale

### Drivers

1. **Reduzir latência**: 3 tool calls em pipeline = 1 round-trip em vez de 3
2. **Atomicidade**: Pipeline executa server-side sem depender do agente
3. **Reusabilidade**: Pipelines frequentes podem ser salvos como templates
4. **Diferencial arquitetural**: Nenhum outro MCP server tem composição de tools

### Alternativas Consideradas

#### Opção A: Deixar o agente orquestrar (status quo)
- **Pros:** Zero implementação
- **Cons:** Lento (múltiplos round-trips), frágil, verbose
- **Por que rejeitada:** É exatamente o problema que queremos resolver

#### Opção B: LangChain/LangGraph integration
- **Pros:** Motor de workflow maduro
- **Cons:** Dependência pesada, overkill, foge do escopo MCP
- **Por que rejeitada:** Implementação leve em TypeScript puro é mais adequada

### Trade-offs

- **Complexidade**: Adiciona um mini-interpreter de variáveis ($prefix.field)
- **Segurança**: Pipeline precisa de sandbox (não executar tools bloqueadas pelo governance)
- **Debugabilidade**: Pipeline que falha no meio precisa de bom error reporting

## Consequences

### Positive

- Workflows multi-step viram 1 tool call
- Redução massiva de latência em operações compostas
- Templates de pipeline reutilizáveis
- Server-side execution = menos tráfego agente↔servidor

### Negative

- Mais complexidade no handler principal
- Referências circulares no pipeline precisam ser detectadas
- Debug de pipeline falho é mais difícil que debug de tool individual

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Pipeline executa tool bloqueada | baixo | alto | Validar cada step contra ToolGovernanceManager |
| Referência circular | baixo | médio | Detecção de ciclo antes de executar |
| Estouro de timeout | médio | médio | `max_total_timeout_ms` obrigatório; progress reporting |

## Implementation

### Tasks

- [ ] Criar `src/tools/meta-tool.ts` com schema Zod + handler
- [ ] Parser de referências: `$output_alias.field.subfield`
- [ ] Executor sequencial com controle de fluxo (stop/skip/continue)
- [ ] Executor paralelo para steps sem dependência
- [ ] Detector de ciclos
- [ ] Validação contra ToolGovernanceManager (cada step)
- [ ] Template system: salvar/carregar pipelines frequentes
- [ ] Registrar no `buildToolCatalog()` e `setupToolHandlers()`
- [ ] Testes unitários + testes de integração com pipeline real

### Dependências

- ToolGovernanceManager (já existe)
- Todas as tools existentes (invocadas dinamicamente)
- Semantic Cache (cache de pipeline results)

### Timeline

~12 horas de desenvolvimento (a mais complexa das 6)
