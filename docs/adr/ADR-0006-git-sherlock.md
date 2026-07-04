---
id: "ADR-0006"
title: "Git Sherlock — Forensics, Heatmaps, and Smart Commit Suggestions"
status: proposed
date: "2026-05-03"
classification: major
project: "GLOBAL"
---

## Context

O projeto tem 481 arquivos dirty no git. Isso é normal em desenvolvimento ativo, mas:
- Não sabemos **por que** certos arquivos mudam mais que outros
- Commits são manuais e inconsistentes
- Não tem visibilidade de churn (quais áreas do código são mais instáveis)
- `git log` cru não ajuda a entender o panorama

## Decision

Criar a tool `git_sherlock` com capacidades de forensics:

### Schema:

```
git_sherlock {
  action: "blame_heatmap" | "what_changed" | "review_uncommitted" | "churn" | "authors" | "file_history"
  
  // blame_heatmap
  path?: string           // arquivo específico (opcional, default: todo o repo)
  
  // what_changed
  since?: string          // "3 days ago", "1 week ago", etc
  until?: string          // opcional
  group_by?: "file" | "author" | "day"
  format?: "summary" | "detailed"
  
  // review_uncommitted
  suggest_commits?: boolean  // gerar sugestões de mensagens de commit
  group_by_feature?: boolean // agrupar mudanças relacionadas
  
  // churn
  top_n?: number          // default: 10
  since?: string          // período de análise
  
  // authors
  (sem parâmetros — estatísticas de contribuição)
  
  // file_history
  path: string            // arquivo específico
  max_commits?: number    // default: 20
}
```

## Rationale

### Drivers

1. **481 arquivos dirty**: Precisamos de tooling pra entender e gerenciar isso
2. **Qualidade de commits**: Mensagens geradas automaticamente reduzem inconsistência
3. **Code health**: Heatmap de churn revela áreas problemáticas
4. **Onboarding**: Novos contribuidores (lembra do site na China?) precisam entender o código

### Alternativas Consideradas

#### Opção A: Usar ferramentas externas (git-truck, git-quick-stats)
- **Pros:** Prontas, testadas
- **Cons:** Dependências externas, output não estruturado
- **Por que rejeitada:** Queremos output JSON estruturado pra consumo pelo agente

### Trade-offs

- **Performance**: `blame_heatmap` em repo grande pode ser lento. Mitigação: cache + limite de arquivos
- **Sugestões de commit**: Podem ser ruins. Mitigação: sempre mostrar diff + sugestão, usuário decide

## Consequences

### Positive

- Visibilidade total do estado do git
- Sugestões de commit reduzem fricção
- Heatmap revela hotspots de manutenção
- Prepara o projeto pra contribuidores externos

### Negative

- Heatmap pode ser pesado em repos grandes
- Sugestão automática de commit pode não capturar intenção

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Heatmap lento em repo grande | médio | baixo | Limitar a 100 arquivos; flag `path` pra escopo reduzido |
| Sugestão de commit errada | médio | baixo | Só sugerir, nunca commitar automaticamente |

## Implementation

### Tasks

- [ ] Criar `src/tools/git-sherlock.ts` com schema Zod + handler
- [ ] `blame_heatmap`: `git blame --line-porcelain` + agregação por linha
- [ ] `what_changed`: `git log --since` + `--stat` + agrupamento
- [ ] `review_uncommitted`: `git diff --stat` + `git diff` + heurística de agrupamento
- [ ] `churn`: `git log --format=format: --name-only` + count por arquivo
- [ ] `authors`: `git shortlog -sne`
- [ ] `file_history`: `git log --follow --format=oneliner <path>`
- [ ] Registrar no `buildToolCatalog()` e `setupToolHandlers()`
- [ ] Testes unitários

### Dependências

- Git CLI (já presente)
- `execAsync` (já usado)

### Timeline

~5 horas de desenvolvimento
