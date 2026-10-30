# Ofertas

Plataforma de ofertas de afiliados (grupos de WhatsApp + Instagram), operável pelo painel e por agentes de IA via MCP. Specs em [docs/specs](docs/specs/README.md).

## Rodar localmente

Requisitos: Node 22+, pnpm 9, Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up        # Postgres (5433) e Redis (6380)
pnpm db:migrate
pnpm dev             # API :3001, painel :3000, redirecionador :3002 e worker
```

Abra http://localhost:3000, crie a conta (o primeiro cadastro vira dono do workspace) e vá em **Conectar agente** para gerar um token. A tela mostra o comando pronto para Claude Code, Codex e Gemini CLI.

Exemplo com Claude Code:

```bash
claude mcp add --transport http ofertas http://localhost:3001/mcp --header "Authorization: Bearer ofk_..."
```

## Comandos

| Comando            | O que faz                                              |
| ------------------ | ------------------------------------------------------ |
| `pnpm dev`         | Sobe API e painel em modo watch                        |
| `pnpm test`        | Testes (usam o banco `ofertas_test`)                   |
| `pnpm typecheck`   | Checagem de tipos em todos os pacotes                  |
| `pnpm lint`        | Lint e formatação (Biome); `pnpm format` corrige       |
| `pnpm db:generate` | Gera migration a partir de `packages/db/src/schema.ts` |
| `pnpm db:migrate`  | Aplica migrations                                      |

## Estrutura

```
apps/api        REST /v1 (OpenAPI em /v1/openapi.json) + MCP em /mcp
apps/redirect   Links curtos (/<slug>) e convites rotativos (/entrar/<slug>)
apps/web        Painel Next.js (chama a API via proxy /api)
apps/worker     Tarefas contínuas (buscas salvas, expiração de ofertas)
packages/core   Regras de negócio (escopos, dry-run, idempotência, auditoria, limites)
packages/connectors  Integrações externas (Shopee real e simulada)
packages/db     Schema Drizzle e migrations
packages/contracts  Schemas Zod compartilhados
infra           docker-compose
```
