---
id: "ADR-0005"
title: "Notify Hook — Async Notifications and Process Watch"
status: proposed
date: "2026-05-03"
classification: minor
project: "GLOBAL"
---

## Context

Operações longas (builds, testes, nixos-rebuild) deixam o usuário esperando sem feedback.
O MCP server pode executar essas operações mas o usuário não tem como ser notificado quando
terminam, a não ser que fique olhando pro terminal.

## Decision

Criar a tool `notify_hook` com dois modos:

1. **Send**: Dispara notificação via webhook (ntfy.sh, Gotify, Discord) ou local (`notify-send`)
2. **Watch**: Monitora um PID e notifica quando o processo terminar

### Schema:

```
notify_hook {
  action: "send" | "watch"
  
  // send
  channel?: string        // "ntfy.sh/topico", "gotify", "discord", "local"
  message: string         // corpo da notificação
  title?: string          // título (default: "MCP Server")
  priority?: "low" | "normal" | "high"
  url?: string            // URL do webhook (se não usar channel pré-configurado)
  
  // watch
  pid?: number            // PID pra monitorar
  notify_on_exit?: boolean // notificar quando o processo terminar
  command?: string        // ou rodar comando e notificar ao terminar
  timeout_ms?: number     // timeout máximo de espera
}
```

### Canais suportados:

| Canal | Transporte | Autenticação |
|---|---|---|
| `ntfy.sh` | HTTP POST | Tópico público/privado |
| `gotify` | HTTP POST | Token |
| `discord` | Webhook | URL com token |
| `local` | `notify-send` (D-Bus) | Nenhuma |

## Rationale

### Drivers

1. **UX de operações longas**: Usuário pode sair pra tomar café e ser notificado
2. **Infraestrutura mínima**: Só precisa de `fetch` (já usado no projeto)
3. **Multi-canal**: Suporta desde notificação local até Discord
4. **Watch mode**: Pode monitorar qualquer PID (inclusive builds iniciados por outras tools)

### Alternativas Consideradas

#### Opção A: Polling no client
- **Pros:** Zero dependência no server
- **Cons:** Ineficiente, o cliente precisaria ficar fazendo polling
- **Por que rejeitada:** Server-side é mais elegante e não ocupa o cliente

### Trade-offs

- **Segredos**: Tokens de webhook precisam ser armazenados. Mitigação: usar env vars + SOPS
- **Firewall**: Webhooks saem pra internet. Mitigação: fallback pra `notify-send` local

## Consequences

### Positive

- Feedback assíncrono pra operações longas
- Integração com sistemas de notificação existentes
- Watch mode permite compor com outras tools

### Negative

- Requer configuração de webhook (ntfy.sh é zero-config)
- Tokens em env vars são outro vetor de segurança

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Token vaza em log | médio | médio | Nunca logar tokens; mascarar em output |
| Webhook falha silenciosamente | baixo | baixo | Timeout + fallback local; logar falha |

## Implementation

### Tasks

- [ ] Criar `src/tools/notify-hook.ts` com schema Zod + handler
- [ ] `send`: HTTP POST para ntfy.sh/Gotify/Discord; spawn `notify-send` pra local
- [ ] `watch`: polling do PID via `process.kill(pid, 0)` ou `/proc/<pid>`
- [ ] Config de canais via env vars: `NTFY_TOPIC`, `GOTIFY_URL`, `DISCORD_WEBHOOK`
- [ ] Registrar no `buildToolCatalog()` e `setupToolHandlers()`
- [ ] Testes unitários com mock de fetch

### Dependências

- `fetch` API (nativa Node 22+)
- `notify-send` (libnotify) — opcional, só pra modo local

### Timeline

~2 horas de desenvolvimento
