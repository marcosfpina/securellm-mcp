---
id: "ADR-0002"
title: "Neovim Context Bridge — Live Editor Integration for MCP"
status: proposed
date: "2026-05-03"
classification: major
project: "GLOBAL"
---

## Context

O MCP server opera completamente cego em relação ao que o usuário está fazendo no editor.
Isso força o usuário a descrever manualmente onde está no código, qual arquivo está editando,
quais erros de LSP estão aparecendo, etc. Essa fricção é desnecessária quando o Neovim já
expõe uma API rica via msgpack-RPC.

## Decision

Criar a tool `nvim_context` que se comunica com o Neovim via socket UNIX
(`/tmp/nvim-$USER` ou `$NVIM_LISTEN_ADDRESS`) usando o protocolo msgpack-RPC.

### Ações suportadas:

| Ação | Descrição |
|---|---|
| `get_buffer` | Arquivo atual, cursor (linha/col), encoding, tipo de arquivo |
| `get_selection` | Texto selecionado visualmente com range (start/end) |
| `get_diagnostics` | Erros e warnings do LSP no buffer atual |
| `get_visible_range` | Linhas visíveis na tela (viewport) |
| `get_git_blame` | git blame da linha atual |
| `list_buffers` | Todos os buffers abertos |
| `execute_vim` | Executar comando vim arbitrário (restrito a comandos seguros) |

## Rationale

### Drivers

1. **Reduzir fricção**: Usuário não precisa digitar "estou no arquivo X, linha Y"
2. **Contexto rico**: LSP diagnostics, git blame, selection — tudo disponível sem sair do fluxo
3. **Baixo acoplamento**: Conexão via socket UNIX é padrão Neovim, zero dependências novas
4. **Segurança**: Socket UNIX é local-only, mesma proteção do filesystem

### Alternativas Consideradas

#### Opção A: Language Server Protocol direto
- **Pros:** Padronizado, multi-editor
- **Cons:** Muito mais complexo, precisaria implementar um LSP client inteiro
- **Por que rejeitada:** Overkill. msgpack-RPC direto é mais simples e já cobre 100% dos casos

#### Opção B: File watcher no diretório do projeto
- **Pros:** Funciona com qualquer editor
- **Cons:** Não sabe cursor, selection, diagnostics. Alta latência. Falso-positivos.
- **Por que rejeitada:** Não entrega o valor principal (contexto de editing ao vivo)

### Trade-offs

- **Acoplamento Neovim**: Funciona só com Neovim (mas o autor usa Neovim; extensível depois)
- **Segurança de comandos**: `execute_vim` precisa de sandbox branco de comandos permitidos
- **Conexão efêmera**: Socket pode não existir se Neovim não estiver rodando — fallback gracefully

## Consequences

### Positive

- Agente sabe exatamente onde o usuário está no código
- LSP diagnostics alimentam o agente sem o usuário precisar copiar/colar erros
- Seleção visual → agente opera no trecho exato que o usuário quer

### Negative

- Só funciona com Neovim (por enquanto)
- Precisa de parser msgpack (Node.js tem `msgpack-lite` ou implementação nativa)
- Timeout de conexão se Neovim não estiver ouvindo

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Socket inexistente | médio | baixo | Fallback graceful, retorna erro descritivo |
| Comando vim inseguro | baixo | alto | Whitelist estrita de comandos permitidos |
| msgpack parsing falha | baixo | médio | Try/catch com fallback para erro legível |

## Implementation

### Tasks

- [ ] Instalar dependência msgpack (ou usar implementação nativa Node)
- [ ] Criar `src/tools/nvim-context.ts` com schema Zod + handler
- [ ] Implementar conexão socket UNIX + handshake msgpack-RPC
- [ ] Whitelist de comandos vim seguros
- [ ] Registrar no `buildToolCatalog()` e `setupToolHandlers()`
- [ ] Testes unitários com mock de socket

### Dependências

- Nenhuma externa (msgpack puro ou `@msgpack/msgpack`)

### Timeline

~4 horas de desenvolvimento
