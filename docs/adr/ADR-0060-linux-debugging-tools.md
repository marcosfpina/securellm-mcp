---
id: "ADR-0060"
title: "Linux Debugging & Observability Tools — Closing the Dev-to-Debug Loop"
status: proposed
date: "2026-05-03"
classification: major
project: "GLOBAL"
---

## Context

O workflow de desenvolvimento no ecossistema VoidNxSEC envolve tarefas repetitivas de debugging:

1. **NixOS rebuild falha** → `journalctl -u nix-daemon | grep error` → `nix store verify` → `nix store gc --dry-run`
2. **Serviço não sobe** → `systemctl status X` → `journalctl -u X --since "5 min ago"` → `ss -tlnp | grep PORT`
3. **Processo pesado** → `htop` → `ps aux --sort=-%mem | head` → `iotop`
4. **Rede estranha** → `ip a` → `ss -tlnp` → `resolvectl status` → `ping`

Toda vez que isso acontece, o agente precisa pedir pro usuário rodar comandos ou usar
o terminal. Ferramentas de debugging automatizam isso, devolvendo output estruturado.

Além disso, o `session_bridge` (ADR-0003) pode usar essas tools como **sensores** — 
capturando estado do sistema no momento do snapshot pra recall contextual rico.

## Decision

Criar um conjunto de tools de Linux debugging e observabilidade:

### 1. `journal_analyze` — Journalctl com inteligência

```
journal_analyze {
  unit?: string           // filtrar por unit (nix-daemon, sshd, etc.)
  since?: string          // "5 min ago", "1 hour ago"
  until?: string
  pattern?: string        // regex: "error|fail|timeout|killed"
  priority?: "emerg" | "alert" | "crit" | "err" | "warning" | "notice" | "info" | "debug"
  lines?: number          // default: 100
  format?: "raw" | "summary" | "timeline"
}
```

**Exemplo de output (format: "summary"):**
```
nix-daemon (últimos 5 min):
  ERROR x3: "hash mismatch in fixed-output derivation"
  WARNING x12: "substitute: updating cache"
  NOTICE x1: "building path '/nix/store/...'"
  
Top patterns: "hash mismatch" (3x), "substitute" (12x), "building" (1x)
```

### 2. `process_inspect` — Raio-X de processos

```
process_inspect {
  pid?: number            // processo específico
  name?: string           // ou filtrar por nome (ex: "llama-server")
  action: "tree" | "resources" | "cgroup" | "files" | "sockets" | "all"
}
```

### 3. `systemd_delta` — O que mudou entre estados

```
systemd_delta {
  action: "failed" | "changed" | "diff_boot" | "list_units"
  state?: string          // "running", "failed", "inactive"
  pattern?: string        // filtrar por nome
}
```

### 4. `network_diag` — Diagnóstico de rede completo

```
network_diag {
  action: "summary" | "dns" | "connections" | "interfaces" | "routes"
  port?: number           // checar porta específica
}
```

### 5. `disk_analyze` — Análise de disco e I/O

```
disk_analyze {
  action: "usage" | "nix_store" | "largest_files" | "io_stats"
  path?: string           // "/nix/store", "/home"
  top_n?: number          // default: 10
}
```

### 6. `security_scan` — Verificações rápidas de segurança

```
security_scan {
  action: "failed_logins" | "open_ports" | "suid_files" | "recent_changes" | "all"
  since?: string          // "24 hours ago"
}
```

## Rationale

### Drivers

1. **Automatizar debugging repetitivo**: O agente não deve pedir pro usuário rodar `journalctl`
2. **Output estruturado**: JSON em vez de texto cru → agente pode raciocinar sobre os dados
3. **Session context rico**: `session_bridge.snapshot()` pode incluir estado do sistema
4. **Integração com Nix ecosystem**: `disk_analyze.nix_store` complementa `nix_daemon`
5. **Segurança passiva**: `security_scan` detecta anomalias sem ferramentas externas

### Alternativas Consideradas

#### Opção A: Deixar o agente usar o terminal
- **Pros:** Zero implementação
- **Cons:** Output não estruturado; agente precisa parsear texto; lento; repetitivo
- **Por que rejeitada:** É exatamente o que queremos eliminar

#### Opção B: Ferramenta externa (Netdata, Grafana Agent)
- **Pros:** Muito completo
- **Cons:** Dependência pesada; foco em métricas de longo prazo, não debugging pontual
- **Por que rejeitada:** Overkill. Precisamos de ferramentas leves e focadas.

### Trade-offs

- **Permissões**: `journalctl` e `ss` podem precisar de grupos especiais (systemd-journal, sudo)
- **Segurança**: `security_scan.suid_files` vasculha filesystem — pode ser pesado
- **Portabilidade**: Tools assumem systemd + NixOS — ok, é a plataforma alvo

## Consequences

### Positive

- Debugging automatizado, output estruturado
- Session snapshots ricos (estado do sistema incluso)
- Complementa `nix_daemon` (ADR-0004) com visão de runtime
- Previne problemas de segurança (failed_logins, open_ports)
- Workflow de dev inteiro coberto: editor → código → build → debug → commit

### Negative

- Mais tools pra manter
- Algumas precisam de permissões elevadas
- Output de comandos pode ser grande (mitigação: `lines` limit, `summary` format)

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| journalctl sem permissão | médio | baixo | Documentar: `usermod -aG systemd-journal $USER` |
| Comando pesado trava o server | baixo | médio | Timeout em todos os subprocessos |
| Informação sensível no output | baixo | médio | Sanitização de secrets no output |

## Implementation

### Tasks

- [ ] Criar `src/tools/linux-debugging.ts` com todos os schemas Zod
- [ ] `journal_analyze`: spawn `journalctl` + parse + summarize
- [ ] `process_inspect`: `/proc/<pid>/` + `ps` + `cgroup` + `lsof`
- [ ] `systemd_delta`: `systemctl list-units` + `systemd-analyze`
- [ ] `network_diag`: `ss` + `ip` + `resolvectl`
- [ ] `disk_analyze`: `df` + `du` + `nix store info` + `nix path-info`
- [ ] `security_scan`: `lastb` + `ss` + `find / -perm /4000` + `find /etc -mtime`
- [ ] Integrar com `session_bridge.snapshot()` — incluir estado do sistema
- [ ] Registrar no `buildToolCatalog()` e `setupToolHandlers()`
- [ ] Testes unitários com mock de execAsync

### Dependências

- `execAsync` (já usado no projeto)
- Grupos: `systemd-journal`, `sudo` para alguns comandos
- `session_bridge` (ADR-0003) — consumer do output

### Timeline

~6 horas de desenvolvimento (6 tools)
