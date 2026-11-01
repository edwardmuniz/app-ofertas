# 90 — Roadmap

Uma fase por vez. Cada fase entrega **API + MCP + painel mínimo + testes** do que cobre. As fases 0–5 formam o MVP (sem data fixa de lançamento).

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

## Fase 1 — Links e rastreamento ✅

**Specs:** [11](11-links-e-rastreamento.md)

- Redirecionador com cache, cliques assíncronos, filtro de bots, troca de destino, fallback.
- Convite rotativo (com canais cadastrados manualmente nesta fase).
- Tools: `create_tracked_link`, `get_link_stats`, `create_invite_link`.

**Aceite:** p95 < 50 ms local; cliques humanos vs bot separados; convite rotativo alternando entre 2 grupos.

**Entregue (28/10/2026):** serviço `apps/redirect` (porta 3002) com cache Redis e cliques gravados em lote; p95 medido de 0,9 ms com Redis real. Canais e segmentos com cadastro manual (`upsert_channel`, `upsert_segment`; o cadastro manual de canais saiu em 31/10/2026, ver Fase 3.1), links (`create/update/list_tracked_link(s)`), convites (`create/update/list_invite_link(s)`) e `get_link_stats` com quebra por dia, link, convite, canal e origem. Painel: Grupos, Links e Convites. Eventos `segment.full`, `link.created` e `link.destination_changed` gravados na tabela `events`.
Desvios: cliques ficam em buffer de memória por até 1 s antes de gravar (queda do processo perde esse intervalo; trocar por fila no Redis se virar problema). Contagem de membros é manual até a Fase 3.

## Fase 2 — Shopee e ofertas 🟨

**Specs:** [10](10-afiliados-e-ofertas.md)

- Conector Shopee (+ fake), contas de afiliado cifradas.
- Busca, score, flags de qualidade, histórico de preço, validação, buscas salvas (coleta contínua).
- Tools: `search_offers`, `get_offer`, `validate_offer`, `save_offer`, `reject_offer`, `list_offers`, `find_similar_offers`.
- Painel: curadoria (lista com score/flags, aprovar/rejeitar).

**Aceite:** buscar, salvar e validar ofertas reais da Shopee; link de afiliado com sub-ids.

**Entregue (30/10/2026), falta só a Shopee real:** pacote `packages/connectors` com interface de afiliados, Shopee simulada (catálogo de ~240 produtos, controles de preço/estoque/falha) e conector real da Shopee (assinatura SHA256, busca, consulta por item, link curto com 5 sub-ids) testado contra respostas simuladas. Contas de afiliado com credenciais cifradas (AES-256-GCM, `ENCRYPTION_KEY`), conectadas só por humanos. Busca com nota 0–100 e sinais (`fake_discount`, `lowest_30d/90d`, `low_rating`, `unavailable`, `coupon_required`), histórico de preço, curadoria (new/approved/rejected/expired), validação com tolerância de 5%, similares e `create_offer_link` (link de afiliado com sub-ids `[origem, slug do link, campanha]` dentro de link rastreado). Buscas salvas rodadas pelo novo `apps/worker` (a cada 60 s, com trava no Redis), que também expira ofertas vencidas. 13 tools MCP novas; telas Ofertas e Afiliados.
**Entregue (31/10/2026), ofertas reais sem a API:** conta Shopee em modo **feed de produtos** (CSV oficial importado todo dia pelo worker, só itens com 10%+ de desconto e avaliação 4+, em `feed_items`). Busca, buscas salvas, regras e validação usam o catálogo. Links de comissão montados com o ID de afiliado (`an_redir` com 5 sub-ids), inclusive para link comum colado. **Oferta por link** (`preview/import_offer_from_link`): cola o link, o painel lê título, foto e preço da página e completa-se o que faltar.
**Pendente:** testar o conector real com as credenciais da Shopee (pedidas em 30/10) e ajustar campos/códigos marcados [VERIFICAR] em `shopee.ts`.

## Fase 3 — WhatsApp e publicação ✅

**Specs:** [12](12-grupos-e-publicacao.md)

- Evolution Go no compose; adapter + fake; conexão por QR; importar grupos; saúde.
- Segmentos, templates de mensagem, fila de publicação (dedupe, janelas, limites, jitter, retentativas).
- Regras de automação. Apagar mensagem enviada.
- Webhooks de entrada/saída de participantes → `channel_stats_daily`.
- Tools: canais, segmentos, `preview_post`, `schedule_posts`, `list_posts`, `cancel_post`, `delete_sent_post`, regras.

**Aceite:** regra "Shopee ≥ 40% → segmento X às 20–23h" publicando sozinha em grupo de teste com link rastreado; `dry_run` mostra prévia exata.

**Entregue (30/10/2026):** adaptador Evolution Go (testado contra a instância real: criar, conectar, status, QR, apagar) e WhatsApp simulado. Conexão do número por QR ou código de pareamento (só humanos). Importação de grupos com link de convite, "só admins enviam", contagem de membros por webhook (`GroupInfo` Join/Leave, autenticado pelo token da instância). Modelos de mensagem com variações e remoção de linhas vazias. Fila de publicação no Postgres (`FOR UPDATE SKIP LOCKED`, sem BullMQ): janelas de envio, intervalo mínimo por grupo, teto por hora por número, atraso aleatório, sem repetir produto no grupo por 7 dias, revalidação da oferta e link rastreado gerado na hora do envio, retentativas, cancelar e apagar mensagem enviada. Regras automáticas (1 oferta por grupo por vez, filtros de nota/desconto/palavra-chave). 12 tools MCP novas; telas WhatsApp e Publicações.
**Pendente:** conectar o número real e apontar o redirecionamento de portas para `MESSAGING_WEBHOOK_URL/evolution_go`; conferir o formato real dos eventos `GroupInfo` e do id da mensagem enviada.

## Fase 3.1 — Gestão completa de grupos ✅

**Specs:** [12 §Gestão de grupos](12-grupos-e-publicacao.md#gestão-de-grupos)

- Tudo o que a Evolution Go faz com grupos: criar grupo, editar nome/descrição/foto, as 4 configurações, novo link de convite, participantes (promover o número reserva, remover spammer, adicionar equipe), detalhes do grupo, entrar por link, sair.
- Comunidades: criar e ligar/desligar grupos.
- Webhooks `GroupInfo` completos (nome, configurações, admin perdido, grupo apagado/suspenso) e `JoinedGroup`.
- API para todas as ações; tools MCP para as que agentes podem fazer sem aprovação (`get_group`, `update_group`, `update_group_settings`, `list_team_contacts`).
- Painel: "Criar grupo", página de detalhes do grupo, "Entrar em grupo por link".

**Aceite:** criar um grupo real pelo painel já com "só admins", foto, descrição, link de convite e segmento; promover o número reserva a admin; mudar o nome pelo celular e ver o canal atualizado pelo webhook.

**Fora (limite do provedor):** aprovar pedidos de entrada, prévia de grupo pelo link, mensagens temporárias.

**Entregue (31/10/2026):** criar grupo (já com descrição, foto, "só admins enviam", "só admins editam", "só admins adicionam", link de convite e segmentos), editar nome/descrição/foto, as 4 configurações, novo link de convite, participantes (adicionar só números da equipe, remover, promover, rebaixar, com confirmação relendo o grupo e limite diário), detalhes do grupo com admins mascarados, entrar por link (importa o grupo), sair (arquiva e cancela agendados), comunidades (criar, ligar e desligar grupos). Números da equipe. Webhook `GroupInfo` completo e alertas `group_admin_lost`/`group_unavailable`. Tools MCP: `get_group`, `update_group`, `update_group_settings`, `list_team_contacts`; as demais ações ficam só para humanos até existir o fluxo de aprovações. Painel: "Criar grupo"/"Criar comunidade", página de detalhes do grupo com abas, "Entrar por link" e "Números da equipe".
**Pendente:** testar contra a instância real (formato de `/group/create`, `/group/info`, comunidades e chaves do webhook `GroupInfo`, marcados [VERIFICAR]); publicar no grupo de avisos da comunidade.

## Fase 4 — Criativos de imagem ✅

**Specs:** [14](14-criativos.md)

- Brand kit; templates `card_preco` e `cupom_destaque` (Satori).
- Upload por URL pré-assinada, import por URL, prévia, validação, biblioteca.
- Post de WhatsApp com imagem + legenda.
- CLI `ofertas` mínima (`login`, `upload`, `offers search`).

**Aceite:** agente gera criativo, vê a prévia, ajusta e agenda post com a imagem; agente sobe imagem própria via `request_upload` + `curl`.

**Entregue (30/10/2026):** `packages/render` com templates `card_preco` e `cupom_destaque` (Satori + resvg, fonte Inter embutida) nos formatos 1:1, 4:5 e 9:16, com prévia de 480 px. Brand kit (nome, cores, chamada). Upload em duas etapas (`request_upload` → PUT na URL assinada → `complete_upload`), importação por URL com bloqueio de endereços internos, validação por formato e biblioteca. Imagens servidas por URL assinada (HMAC) em `/media/:id`. Publicações e regras aceitam `creative_template`: o card é gerado na hora do envio (preço sempre atualizado); criativo pronto com preço antigo é refeito. CLI `ofertas` (login, whoami, offers search/list, creatives generate, upload). 10 tools MCP novas; tela Criativos.
Desvios: armazenamento local em disco (`MEDIA_DIR`) atrás da interface `ObjectStorage` (trocar por S3/R2 no deploy); renderização síncrona (~1 s por formato), sem fila.

## Fase 5 — Métricas MVP + pronto para operar 🟨

**Specs:** [16](16-metricas-e-financeiro.md), [17 §Calendário](17-growth.md)

- Rollups diários/horários; painel visão geral, canais, ofertas, horários.
- Tools: `get_performance_summary`, `get_funnel` (parcial: entradas → cliques).
- Calendário sazonal + prompt MCP `planejar_campanha_sazonal`.
- Hardening: alertas (número caiu, fila parada), backups, deploy em VPS.

**Aceite:** operação diária real rodando por 3 dias sem intervenção manual além de curadoria/aprovações.

**Entregue (30/10/2026):** consolidação horária de cliques (`click_stats_hourly`, worker a cada 5 min, recálculo idempotente) + `channel_stats_daily` em tempo real. `get_performance_summary` (com comparação ao período anterior, top grupos/ofertas, melhores horários e insights), `get_funnel` (convite → entradas → ficaram → cliques; pedidos no Financeiro) com etapa gargalo, `get_metrics_breakdown` (grupos, ofertas, mapa dia × hora de cliques por envio). Alertas `messaging_down`, `queue_stalled`, `posts_failing` (abrem e resolvem sozinhos; aviso por webhook: ntfy/Discord/Slack); worker confere o status dos números no provedor a cada 5 min; `/v1/status` público para monitor externo. Calendário sazonal + prompt MCP `planejar_campanha_sazonal`. Painel: Visão geral com KPIs, funil e insights; tela Métricas. Deploy: `Dockerfile`, `infra/prod` (compose + Caddy com HTTPS + backup diário), [docs/deploy.md](../deploy.md); stack testada localmente.
Desvios: calendário calculado em código (sem tabela `season_event`); taxas de referência do funil são iniciais (ajustar com dados reais).
Pendente para ✅: deploy na VPS e 3 dias de operação real.

---

## Fase 6 — Instagram ⬜  ([13](13-instagram.md))

Publicação feed/reels/story, DM por comentário, página de bio dinâmica.

## Fase 7 — Outros afiliados 🟨  ([10](10-afiliados-e-ofertas.md))

Amazon, Mercado Livre, Magalu (conforme APIs verificadas); oferta manual por link colado.

**Pesquisa (01/11/2026):** nenhuma das três tem API aberta como a da Shopee. Amazon: a PA-API 5 foi desligada e a Creators API exige 10 vendas em 30 dias. Mercado Livre e Magalu: sem API de afiliado (links só pelo portal/app).
**Entregue (01/11/2026), Amazon:** conta em modo Associado com a tag (Creators API opcional). Link colado vira link com a sua tag; preço, estoque e foto lidos da página antes de cada envio; com a Creators API, busca e consulta pela API. Posts da Amazon levam o link direto (a Amazon proíbe encurtador). Conta simulada da Amazon. Painel: Amazon em Afiliados.
**Entregue (01/11/2026), busca na Amazon sem a Creators API:** `search_offers` (e buscas salvas) lê a página de resultados da Amazon e devolve os produtos com preço, "De", parcelas, nota e compras no mês, já com a sua tag.
**Entregue (01/11/2026), Mercado Livre por agente:** `meli.la` reconhecido; `import_offer_from_link` aceita Pix e parcelas; roteiro no MCP para o agente com navegador buscar, gerar o link no portal e importar (a loja fechou API e páginas).
**Pendente:** testar a Creators API com credenciais reais ([VERIFICAR] em `amazon.ts`); Mercado Livre e Magalu (por enquanto só oferta por link).

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
