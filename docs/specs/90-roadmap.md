# 90 — Roadmap

Uma fase por vez. Cada fase entrega **API + MCP + painel mínimo + testes** do que cobre. Marco: **Black Friday 2026 = sexta 27/11**. As fases 0–5 formam o MVP mirando operar a BF.

Legenda de status: ⬜ não iniciado · 🟨 em andamento · ✅ concluído

---

## Fase 0 — Fundação ✅

**Specs:** [01](01-arquitetura.md), [02 §Identidade](02-modelo-de-dados.md), [03](03-api-mcp-agentes.md)

- Monorepo (pnpm + Turborepo), TypeScript, lint, testes (Vitest), CI.
- Docker Compose local: Postgres, Redis, MinIO.
- `packages/db` com Drizzle e migrations; `packages/contracts`; `packages/core` esqueleto.
- `apps/api`: Fastify, `/v1/health`, OpenAPI, erros padronizados, auditoria, idempotência, limites.
- Auth do painel (login) + workspace + tokens de API com escopos.
- `/mcp` com tools `get_workspace_overview` e `get_audit_log` (token Bearer).
- `apps/web`: login, tela de tokens ("Conectar agente"), log de auditoria.

**Aceite:** conectar Claude Code/Codex ao `/mcp` local com token, listar tools e chamar `get_workspace_overview`; ação registrada no audit log.

**Entregue (28/10/2026):** tudo acima, mais tools `get_preferences`/`update_preferences`, resource `workspace://preferences` e tela de preferências. Desvios: CI ainda não configurado (repo sem git/remote); MinIO removido do compose (imagem saiu do Docker Hub) — storage será escolhido na Fase 4; `apps/web` usa client fetch simples em vez de client gerado do OpenAPI.

## Fase 1 — Links e rastreamento ⬜

**Specs:** [11](11-links-e-rastreamento.md)

- Redirecionador com cache, cliques assíncronos, filtro de bots, troca de destino, fallback.
- Convite rotativo (com canais cadastrados manualmente nesta fase).
- Tools: `create_tracked_link`, `get_link_stats`, `create_invite_link`.

**Aceite:** p95 < 50 ms local; cliques humanos vs bot separados; convite rotativo alternando entre 2 grupos.

## Fase 2 — Shopee e ofertas ⬜

**Specs:** [10](10-afiliados-e-ofertas.md)

- Conector Shopee (+ fake), contas de afiliado cifradas.
- Busca, score, flags de qualidade, histórico de preço, validação, buscas salvas (coleta contínua).
- Tools: `search_offers`, `get_offer`, `validate_offer`, `save_offer`, `reject_offer`, `list_offers`, `find_similar_offers`.
- Painel: curadoria (lista com score/flags, aprovar/rejeitar).

**Aceite:** buscar, salvar e validar ofertas reais da Shopee; link de afiliado com sub-ids.

## Fase 3 — WhatsApp e publicação ⬜

**Specs:** [12](12-grupos-e-publicacao.md)

- Evolution Go no compose; adapter + fake; conexão por QR; importar grupos; saúde.
- Segmentos, templates de mensagem, fila de publicação (dedupe, janelas, limites, jitter, retentativas).
- Regras de automação. Apagar mensagem enviada.
- Webhooks de entrada/saída de participantes → `channel_stats_daily`.
- Tools: canais, segmentos, `preview_post`, `schedule_posts`, `list_posts`, `cancel_post`, `delete_sent_post`, regras.

**Aceite:** regra "Shopee ≥ 40% → segmento X às 20–23h" publicando sozinha em grupo de teste com link rastreado; `dry_run` mostra prévia exata.

## Fase 4 — Criativos de imagem ⬜

**Specs:** [14](14-criativos.md)

- Brand kit; templates `card_preco` e `cupom_destaque` (Satori).
- Upload por URL pré-assinada, import por URL, prévia, validação, biblioteca.
- Post de WhatsApp com imagem + legenda.
- CLI `ofertas` mínima (`login`, `upload`, `offers search`).

**Aceite:** agente gera criativo, vê a prévia, ajusta e agenda post com a imagem; agente sobe imagem própria via `request_upload` + `curl`.

## Fase 5 — Métricas MVP + pronto para BF ⬜

**Specs:** [16](16-metricas-e-financeiro.md), [17 §Calendário](17-growth.md)

- Rollups diários/horários; painel visão geral, canais, ofertas, horários.
- Tools: `get_performance_summary`, `get_funnel` (parcial: entradas → cliques).
- Calendário sazonal + prompt MCP `planejar_campanha_sazonal`.
- Hardening: alertas (número caiu, fila parada), backups, deploy em VPS.

**Aceite:** operação diária real rodando por 3 dias sem intervenção manual além de curadoria/aprovações.

---

## Fase 6 — Instagram ⬜  ([13](13-instagram.md))

Publicação feed/reels/story, DM por comentário, página de bio dinâmica.

## Fase 7 — Outros afiliados ⬜  ([10](10-afiliados-e-ofertas.md))

Amazon, Mercado Livre, Magalu (conforme APIs verificadas); oferta manual por link colado.

## Fase 8 — Criativos de vídeo ⬜  ([14](14-criativos.md))

Remotion, templates de vídeo, render assíncrono, contact sheet, transcode de upload.

## Fase 9 — Financeiro ⬜  ([16](16-metricas-e-financeiro.md))

Import de comissões (API/CSV), estados, gastos, lucro, atribuição por sub-id.

## Fase 10 — Anúncios ⬜  ([15](15-anuncios.md))

Landing + Pixel + CAPI, rascunhos com aprovação, sync de insights, custo por membro, ROAS.

## Fase 11 — Growth ⬜  ([17](17-growth.md))

Diagnóstico, motor de recomendações, experimentos, playbooks (indicação primeiro).

## Fase 12 — Agentes avançado ⬜  ([03](03-api-mcp-agentes.md))

OAuth 2.1 no MCP, aprovação via WhatsApp/Telegram, webhooks de saída, resources/prompts completos, sandbox dedicado.
