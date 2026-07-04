---
id: "ADR-0004"
title: "Nix Daemon Tools — Store Health, GC, and Generation Management"
status: proposed
date: "2026-05-03"
classification: major
project: "GLOBAL"
---

## Context

As ferramentas Nix atuais focam em package debugging (diagnose, download, configure).
Falta capacidade de gerenciar a saúde da Nix store, fazer garbage collection inteligente,
comparar gerações do sistema, e auditar o que cada rebuild mudou.

## Decision

Criar a tool `nix_daemon` com ações de gerenciamento da store:

### Schema:

```
nix_daemon {
  action: "gc" | "store_health" | "diff_generation" | "list_generations" | "optimise" | "verify"
  
  // gc
  dry_run?: boolean       // default: true (segurança!)
  older_than?: string     // "7d", "30d" — só remove paths mais velhos que isso
  
  // diff_generation
  from?: number           // número da geração (ex: 142)
  to?: number             // número da geração (ex: 147)
  
  // store_health
  (sem parâmetros adicionais)
  
  // optimise
  (sem parâmetros — roda nix-store --optimise)
  
  // verify
  check_signatures?: boolean   // verificar assinaturas também
  repair?: boolean             // tentar reparar paths quebrados
}
```

## Rationale

### Drivers

1. **NixOS é a plataforma**: O servidor roda em NixOS, faz sentido ter tooling de administração
2. **Segurança primeiro**: `dry_run: true` por padrão em operações destrutivas
3. **Diagnóstico rico**: `store_health` e `diff_generation` são o que usuário NixOS mais precisa
4. **Complementa package tools**: Diagnose + download + configure + agora GC + health

### Alternativas Consideradas

#### Opção A: Wrappers diretos dos comandos nix
- **Pros:** Simples
- **Cons:** Output bruto, difícil de parsear, sem contexto de segurança
- **Por que rejeitada:** Já temos o padrão de parsear + estruturar output no projeto

### Trade-offs

- **Operações destrutivas**: GC e repair podem ser perigosos. Mitigação: dry_run default + confirmação explícita
- **Permissões**: Algumas operações precisam de sudo (nix-store --optimise, verify --repair)

## Consequences

### Positive

- Gestão completa da Nix store dentro do MCP
- GC inteligente com preview
- Diff de gerações ajuda a debugar regressões de rebuild
- Complementa o ecossistema Nix do projeto

### Negative

- GC mal configurado pode quebrar builds ativos
- Depende da Nix CLI estar funcional

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| GC remove paths em uso | baixo | alto | dry_run default; aviso explícito; flag `older_than` |
| Reparo corrompe paths | baixo | alto | `verify` sem `repair` primeiro, só repara com confirmação |

## Implementation

### Tasks

- [ ] Criar `src/tools/nix-daemon.ts` com schema Zod + handler
- [ ] `store_health`: `nix-store --verify --check-contents` + `nix store info`
- [ ] `gc`: `nix store gc` com flags condicionais
- [ ] `diff_generation`: `nix store diff-closures` entre duas gerações
- [ ] `list_generations`: parse de `/nix/var/nix/profiles/system-*-link`
- [ ] `optimise`: `nix-store --optimise`
- [ ] `verify`: `nix-store --verify` com opção de repair
- [ ] Registrar no `buildToolCatalog()` e `setupToolHandlers()`
- [ ] Testes com mock de execAsync

### Dependências

- Nix CLI (já presente no sistema)
- `execAsync` (já usado no projeto)

### Timeline

~3 horas de desenvolvimento
