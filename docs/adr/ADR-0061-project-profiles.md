---
id: "ADR-0061"
title: "Project Profiles — contexto e governança per-repository"
status: proposed
date: "2026-07-19"
classification: normal
project: "GLOBAL"
---

## Context

O securellm-mcp atende múltiplos projetos (15-16 cidadãos do ecossistema
VoidNxSEC), mas toda sessão MCP enxerga o mesmo servidor: mesmas tools,
nenhum contexto do repo ativo. O Claude Code lança o server com
`cwd = raiz do projeto da sessão` — informação que hoje é descartada.

A governança de tools já existe (`ToolGovernanceManager`) e já é
configurável por env (`TOOL_ALLOWLIST`, `TOOL_DISABLED_LIST`). O que falta
é a ponta declarativa: *qual* allowlist e *qual* contexto valem para *este*
repo.

## Decision

Introduzir **profiles per-repository**, resolvidos pelo cwd da sessão:

1. `src/config/profiles.ts` — carrega `profiles.json`
   (`$SECURELLM_PROFILES_FILE` → `$XDG_CONFIG_HOME/securellm/profiles.json`),
   valida com zod, resolve o profile por **longest path-prefix match** do
   cwd (fallback: `defaultProfile`). Schema:

   ```json
   {
     "profiles": {
       "voidnxsec": {
         "path": "/etc/nixos",
         "context": "# VoidNxSEC\n...",
         "toolAllowlist": ["..."],
         "toolDisabled": ["..."]
       }
     },
     "defaultProfile": "voidnxsec"
   }
   ```

2. `applyActiveProfile()` roda no construtor do server **antes** do
   `ToolGovernanceManager` nascer e injeta as listas do profile no contrato
   de env existente. **Env explícito sempre vence** (hierarquia de
   instruções). Profiles configuram a governança; nunca a contornam.

3. Tool nova `get_project_context` (read-only, cheap): expõe profile ativo,
   path que casou, contexto markdown e listas aplicadas.

4. O `profiles.json` é **declarado no NixOS** (`kernelcore.packages.claude`
   em /etc/nixos, módulo claude-code.nix) — reprodutível, versionado, sem
   estado imperativo.

## Consequences

- Sem `profiles.json`, ou com arquivo inválido: comportamento idêntico ao
  atual (feature dormente, degradação silenciosa com log de warn).
- Um único server binário atende N projetos com superfícies de tool
  distintas — sem N instâncias nem N configs de MCP client.
- A resolução é por sessão (startup); mudar de repo = nova sessão MCP, que
  é exatamente o ciclo de vida do Claude Code.

## Verification

- `npm run build` limpo.
- Smoke: `SECURELLM_PROFILES_FILE=<fixture> node build/src/index.js` a
  partir de um cwd coberto → `tools/list` reflete a allowlist do profile;
  `get_project_context` devolve nome/contexto; sem fixture → superfície
  completa e `active: false`.
