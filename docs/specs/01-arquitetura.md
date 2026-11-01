# 01 — Arquitetura

## Visão geral

```
 Máquina do usuário                          Servidor
┌──────────────────────┐                ┌────────────────────────────────────────┐
│ Agente (Claude,      │  MCP (HTTP)    │  api  ── REST /v1  (OpenAPI)           │
│ Codex, Gemini...)    ├───────────────►│       ── MCP  /mcp (Streamable HTTP)   │
│ CLI `ofertas`        ├──── REST ─────►│       ── OAuth / tokens                │
└──────────────────────┘                │                                        │
┌──────────────────────┐                │  web  ── painel (Next.js) → usa a API  │
│ Navegador            ├───────────────►│                                        │
└──────────────────────┘                │  redirect ── go.<dominio>/<slug>       │
                                        │                                        │
 Membros / público ──── clique ────────►│  worker ── filas (BullMQ):             │
                                        │    publicação, validação de oferta,    │
                                        │    coleta de preço, render de          │
                                        │    criativos, import de comissões,     │
                                        │    sync de anúncios, métricas          │
                                        │                                        │
                                        │  Postgres · Redis · Object storage     │
                                        └───────────┬────────────────────────────┘
                                                    │ adapters
                       Shopee · ML · Amazon · Magalu · WhatsApp · Instagram · Meta Ads
```

## Stack (D1 — decidido)

| Camada              | Escolha                                                                   | Motivo                                                                  |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Linguagem           | **TypeScript** (Node 22 LTS) em tudo                                      | Um idioma só; SDK MCP oficial maduro; Remotion (vídeo) é TS             |
| Monorepo            | **pnpm workspaces + Turborepo**                                           | Compartilhar domínio entre api, worker, web                             |
| API                 | **Fastify** + **Zod** (`fastify-type-provider-zod`)                       | Rápido, schema → validação + OpenAPI gerado                             |
| MCP                 | `@modelcontextprotocol/sdk` (Streamable HTTP) montado dentro do `api`     | Reusa os mesmos serviços de domínio                                     |
| Painel              | **Next.js** (App Router) + Tailwind + shadcn/ui                           | Produtividade; consome a API via client gerado do OpenAPI               |
| Banco               | **PostgreSQL 16** + **Drizzle ORM**                                       | Relacional, migrations simples, SQL explícito                           |
| Filas / agendamento | **Redis** + **BullMQ**                                                    | Jobs atrasados, repetíveis, rate-limit por fila                         |
| Storage             | Disco local ou **AWS S3** (opcional, por variáveis `AWS_*`)               | Com S3, a Evolution Go baixa as imagens por link pré-assinado do bucket |
| Render imagem       | **Satori + resvg** (JSX → SVG → PNG)                                      | Rápido, sem browser                                                     |
| Render vídeo        | **Remotion** (+ FFmpeg)                                                   | Templates de vídeo em React                                             |
| Auth usuários       | Sessão (cookie) no painel; implementação própria (D2)                     | —                                                                       |
| Auth agentes        | Tokens de API com escopo (fase 0) → **OAuth 2.1** p/ MCP (fase posterior) | Ver [03](03-api-mcp-agentes.md)                                         |
| WhatsApp            | Adapter; **Evolution Go** self-hosted (D3)                                | API oficial não cobre bem grupos; ver riscos                            |
| Observabilidade     | Pino (logs JSON) + Sentry + métricas básicas                              | —                                                                       |
| Infra               | Docker Compose (local e VPS inicial) [DECISÃO D4]                         | Simples para começar; migrar se crescer                                 |

## Estrutura do repositório

```
apps/
  api/        Fastify: REST /v1, /mcp, auth, webhooks de entrada
  worker/     Processadores BullMQ (um arquivo por fila)
  web/        Painel Next.js
  redirect/   Serviço mínimo de redirecionamento (latência baixa) — pode começar dentro do api
  cli/        CLI `ofertas` (fino, chama a REST)
packages/
  core/       Serviços de domínio (casos de uso). NUNCA importa Fastify/Next.
  db/         Schema Drizzle, migrations, repositórios
  connectors/ Adapters: affiliate/{shopee,amazon,mercadolivre,magalu}, messaging/{whatsapp-evolution}, instagram, meta-ads
  render/     Templates de imagem (Satori) e vídeo (Remotion)
  contracts/  Schemas Zod compartilhados (entrada/saída de API e tools MCP)
  config/     eslint, tsconfig, env
docs/specs/   Estas specs
infra/        docker-compose, Dockerfiles
```

**Regra de dependência:** `apps/*` → `packages/core` → `packages/db` + `packages/connectors`. A REST e o MCP são **camadas finas** sobre `core`: validam entrada (Zod de `contracts`), checam escopo, chamam um caso de uso, formatam saída.

## Fluxo de uma ação (exemplo: publicar oferta)

1. Entrada (painel, REST ou MCP) → valida com schema de `contracts`.
2. Autorização: usuário/token tem escopo `posts:write`?
3. Caso de uso `core.posts.schedule()`:
   - verifica limites (mensagens/hora por canal, duplicidade de oferta),
   - verifica política de aprovação → status `scheduled` ou `pending_approval`,
   - se `dry_run`: retorna prévia e **não persiste**,
   - grava `audit_log` (ator, origem, motivo).
4. Enfileira job atrasado na fila `publish`.
5. Worker no horário: revalida oferta → gera link rastreado → envia via adapter → atualiza status → emite evento.

## Ambientes

- `local`: docker compose (postgres, redis, minio, evolution-go) + `pnpm dev`.
- `staging` / **sandbox**: dados e grupos de teste; adapters podem rodar em modo `fake`.
- `prod`.

Todo adapter tem uma implementação **fake** (determinística) para testes e para o modo sandbox.

## Segurança

- Credenciais de afiliados/Meta/WhatsApp **criptografadas em repouso** (AES-256-GCM, chave via env/KMS).
- Tokens de API armazenados como hash; exibidos uma única vez.
- Rate limit por token e por IP na API e no redirect.
- Webhooks de entrada verificados por assinatura (Meta, Evolution).
- LGPD: telefone de membros só quando necessário, minimização e política de retenção (ver [12](12-grupos-e-publicacao.md)).
