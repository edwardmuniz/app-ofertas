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

## WhatsApp (Evolution Go)

Configure no `.env`: `EVOLUTION_GO_URL`, `EVOLUTION_GO_API_KEY` e `MESSAGING_WEBHOOK_URL` (URL pública que chega na API, ex.: `https://seu-ip:porta/webhooks/whatsapp`; a plataforma acrescenta `/evolution_go`). Depois, em **WhatsApp** no painel: conectar número → QR ou código → importar grupos.

Teste rápido do adaptador contra a sua Evolution Go (cria e apaga uma instância temporária, não envia mensagens):

```bash
pnpm --filter @ofertas/connectors exec tsx --env-file=../../.env scripts/evolution-smoke.ts
```

## CLI

```bash
pnpm ofertas login --url http://localhost:3001 --token ofk_...
pnpm ofertas offers search "air fryer" --min-discount 30
pnpm ofertas creatives generate <offer_id> --format wa_image,story_9x16
pnpm ofertas upload card.png --offer <offer_id>
```

Use `--json` para saída legível por scripts e agentes.

## Produção

Deploy em VPS com Docker, HTTPS automático e backup diário: veja [docs/deploy.md](docs/deploy.md).

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
apps/worker     Tarefas contínuas (buscas salvas, publicação, regras, expiração)
apps/cli        CLI `ofertas`
packages/core   Regras de negócio (escopos, dry-run, idempotência, auditoria, limites)
packages/connectors  Integrações externas (Shopee, Evolution Go; versões simuladas)
packages/render  Templates de criativo (Satori)
packages/db     Schema Drizzle e migrations
packages/contracts  Schemas Zod compartilhados
infra           docker-compose
```
