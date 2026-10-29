# AGENTS.md

Instruções para qualquer agente de IA (Claude, Codex, Gemini, Cursor…) que for **desenvolver** este projeto.

## O que é

Plataforma de ofertas de afiliados (grupos de WhatsApp + Instagram), operável por humanos (painel) e por agentes de IA (MCP/API). Leia `docs/specs/README.md` antes de qualquer tarefa.

## Comandos

- `pnpm infra:up` → `pnpm db:migrate` → `pnpm dev` (ver README).
- Antes de concluir qualquer tarefa: `pnpm lint`, `pnpm typecheck` e `pnpm test`.
- Mudou o schema? `pnpm db:generate` e commit da migration gerada.
- Nova ação que altera algo: implemente no `core` usando `runMutation` (garante escopo, dry_run, idempotência, política e auditoria).

## Como trabalhamos

- O trabalho segue o roadmap em `docs/specs/90-roadmap.md`, **uma fase por vez**.
- Antes de implementar, leia as specs referenciadas pela fase.
- Se a implementação divergir da spec (limite de API, decisão técnica), **atualize a spec junto**.
- Ao concluir uma fase, atualize o status no roadmap.

## Regras de arquitetura

- `packages/core` contém a lógica de negócio e não importa frameworks web.
- REST (`apps/api`) e MCP (`/mcp`) são camadas finas sobre `core`, com schemas em `packages/contracts`.
- Toda operação mutável suporta `dry_run`, idempotência, checagem de escopo, limites e grava `audit_log`.
- Toda feature nova existe na API **e** no MCP.
- Integrações externas sempre atrás de adapter em `packages/connectors`, com implementação `fake` para testes.
- Credenciais de terceiros sempre cifradas em repouso.

## Convenções

- Código, nomes de tabelas, rotas e tools em **inglês**; textos de UI, mensagens de erro para o usuário e specs em **português**.
- Tools MCP: `snake_case`; descrições em português, objetivas.
- Erros: `{ error: { code, message, hint, details } }` com `code` estável.
- Testes com Vitest; todo caso de uso do `core` tem teste; adapters testados contra o fake.
- Fuso padrão `America/Sao_Paulo`; armazenar datas em UTC.
