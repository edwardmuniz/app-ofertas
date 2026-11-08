# 03 — API, MCP e interface para agentes

O agente roda na **máquina do usuário** e conecta remotamente. Ele é tratado como mais um cliente da API, com as mesmas regras do painel e algumas garantias extras.

## Portas de entrada

| Porta             | Público                                     | Detalhes                                                            |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| **REST** `/v1`    | Painel, integrações, CLI                    | JSON, OpenAPI 3.1 gerado dos schemas Zod em `/v1/openapi.json`      |
| **MCP** `/mcp`    | Claude, Codex, Gemini CLI, Cursor, ChatGPT… | Streamable HTTP; tools mapeiam 1:1 para casos de uso do `core`      |
| **CLI** `ofertas` | Agentes de código, scripts                  | Wrapper fino da REST; saída `--json`; ótimo para upload de arquivos |

## Autenticação

- **Fase 0–N:** token de API (`Authorization: Bearer ofk_...`) criado no painel em _Configurações → Conectar agente_. Funciona no MCP (clientes que aceitam header) e na CLI.
- **Fase OAuth:** OAuth 2.1 + PKCE + Dynamic Client Registration conforme spec de autorização do MCP. Usuário cola a URL `/mcp` no cliente → navegador abre → login → escolhe escopos → pronto.
- Toda conexão é listada no painel com último uso e botão **Revogar**.

## Escopos

`offers:read` `offers:write` `channels:read` `channels:write` `posts:read` `posts:write` `links:read` `links:write` `creatives:read` `creatives:write` `ads:read` `ads:write` `metrics:read` `growth:read` `growth:write` `settings:read` `settings:write` `approvals:decide` (nunca concedido a tokens por padrão).

Presets na UI: **Somente leitura**, **Operação** (ofertas, posts, links, criativos), **Completo sem gasto**, **Completo**.

## Garantias para ações com efeito externo

Aplicam-se a REST e MCP igualmente.

1. **`dry_run`** — parâmetro em toda operação mutável. Retorna exatamente o que seria feito (prévia de mensagem renderizada, canais, horários, custo estimado, avisos) sem persistir nem enviar.
2. **Idempotência** — header `Idempotency-Key` (REST) / argumento `idempotency_key` (MCP). Repetição com mesma chave retorna a mesma resposta por 24h.
3. **Limites no servidor** — tabela `limit`. Exceder retorna erro `LIMIT_EXCEEDED` com o limite e quando libera.
4. **Política de aprovação** — tabela `policy`. Se a ação exige aprovação, ela é criada com status `pending_approval` e o retorno informa `approval_id`. Humano aprova no painel (e, fase posterior, via WhatsApp/Telegram). Padrões:
   - publicar em canal: `auto`
   - criar/editar anúncio, aumentar orçamento: `approval`
   - apagar canal, desconectar conta: `approval`
   - qualquer coisa acima de `ads.daily_spend`: `blocked`
5. **Auditoria** — toda mutação grava `audit_log` com ator, origem (`mcp`/`rest`/`web`/`cli`), parâmetros e `reason` (argumento opcional; o MCP recomenda ao agente preencher).
6. **Desfazer** — onde possível: `cancel_post`, `delete_sent_post` (apaga a mensagem no WhatsApp), `pause_ad`, `deactivate_link`.

## Formato de erro

```json
{
  "error": {
    "code": "OFFER_EXPIRED",
    "message": "A oferta 01J... não está mais disponível pelo preço informado.",
    "hint": "Rode validate_offer para atualizar ou find_similar_offers para buscar substituta.",
    "details": { "price_was": 199.9, "price_now": 289.9 }
  }
}
```

Códigos estáveis e documentados (`VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN_SCOPE`, `LIMIT_EXCEEDED`, `APPROVAL_REQUIRED`, `OFFER_EXPIRED`, `DUPLICATE_POST`, `CHANNEL_DISCONNECTED`, `CREATIVE_INVALID`, `PROVIDER_ERROR`…). No MCP, erros vão como resultado de tool com `isError: true` e o mesmo JSON.

## Respostas enxutas

- Listagens paginadas por cursor, `limit` padrão 20, campos resumidos; `get_*` traz o detalhe.
- Ferramentas de resumo retornam texto + números agregados, não dumps.
- Imagens/vídeos: retornar **URL de prévia** (miniatura PNG, e para vídeo um contact sheet de frames) para que agentes multimodais vejam o resultado.

## Instruções embutidas

O servidor MCP expõe:
- `instructions` do servidor: o que é a plataforma, fluxos comuns, boas práticas (sempre `dry_run` antes de publicar em massa, preencher `reason`, respeitar preferências do workspace).
- **Resources**: `workspace://preferences` (tom de voz, nichos, horários, proibições), `workspace://brand-kit`, `workspace://limits`, `docs://workflows`.
- **Prompts** (atalhos): `curadoria_do_dia`, `relatorio_semanal`, `planejar_campanha_sazonal`, `diagnostico_growth`.

## Catálogo de tools MCP (alvo)

Nomes em inglês snake_case (melhor compatibilidade entre clientes); descrições em português.

### Contexto

| Tool                                     | Descrição                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `get_workspace_overview`                 | Resumo: canais, membros, posts hoje, cliques, comissões, aprovações pendentes, alertas |
| `get_preferences` / `update_preferences` | Preferências/playbook do workspace                                                     |

### Ofertas

| Tool                          | Descrição                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `search_offers`               | Busca nos conectores (termo, categoria, desconto mín., preço, plataforma, ordenação)               |
| `get_offer`                   | Detalhe + histórico de preço + flags de qualidade                                                  |
| `validate_offer`              | Revalida preço/estoque/cupom agora                                                                 |
| `set_offer_coupon`            | Define, troca ou tira o cupom da oferta (código, regra e validade)                                 |
| `list_store_coupons`          | Cupons da loja inteira (os que estão na validade, por padrão)                                      |
| `upsert_store_coupon`         | Cadastra ou edita cupom da loja inteira; divulga com `schedule_posts(coupon_ids)`                  |
| `delete_store_coupon`         | Apaga o cupom da loja e cancela os envios agendados dele                                           |
| `find_similar_offers`         | Substitutas para uma oferta expirada                                                               |
| `save_offer` / `reject_offer` | Curadoria                                                                                          |
| `set_offers_status`           | Aprova, rejeita ou devolve para revisar até 200 ofertas de uma vez (`POST /v1/offers/bulk-status`) |
| `list_offers`                 | Ofertas salvas por status                                                                          |

### Canais

| Tool                                       | Descrição                         |
| ------------------------------------------ | --------------------------------- |
| `list_channels` / `get_channel`            | Canais com membros, limite, saúde |
| `list_segments` / `upsert_segment`         | Nichos                            |
| `create_invite_link` / `list_invite_links` | Convite rotativo                  |

### Publicação

| Tool                                                                          | Descrição                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `preview_post`                                                                | Renderiza mensagem para um canal (sempre sem efeito)       |
| `schedule_posts`                                                              | Agenda 1..N ofertas × canais/segmentos (suporta `dry_run`) |
| `list_posts` / `cancel_post` / `delete_sent_post`                             | Fila e histórico                                           |
| `list_automation_rules` / `upsert_automation_rule` / `toggle_automation_rule` | Regras                                                     |

### Links

| Tool                  | Descrição                               |
| --------------------- | --------------------------------------- |
| `create_tracked_link` | Link rastreado avulso (ex.: bio, story) |
| `get_link_stats`      | Cliques por período/canal               |

### Criativos

| Tool                              | Descrição                                                     |
| --------------------------------- | ------------------------------------------------------------- |
| `list_creative_templates`         | Templates e parâmetros aceitos                                |
| `generate_creative`               | Gera por template para uma oferta (formatos, nº de variações) |
| `request_upload`                  | Retorna URL pré-assinada de upload + `upload_id`              |
| `complete_upload`                 | Confirma upload, associa à oferta, valida, gera prévia        |
| `import_media_from_url`           | Importa mídia de uma URL                                      |
| `get_creative` / `list_creatives` | Com URLs de prévia                                            |
| `validate_creative`               | Valida contra specs do destino                                |
| `get_brand_kit`                   | Cores, fontes, logo, tom                                      |

### Anúncios

| Tool                              | Descrição                                              |
| --------------------------------- | ------------------------------------------------------ |
| `list_ads` / `get_ad_performance` | Desempenho com custo por membro                        |
| `create_ad_draft`                 | Cria rascunho (sempre passa por política de aprovação) |
| `pause_ad` / `update_ad_budget`   |                                                        |

### Métricas e growth

| Tool                                                                       | Descrição                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `get_funnel`                                                               | Funil por período/segmento                           |
| `get_performance_summary`                                                  | Top ofertas, categorias, horários, canais, criativos |
| `get_growth_diagnosis`                                                     | Gargalo do funil + recomendações abertas             |
| `list_recommendations` / `apply_recommendation` / `dismiss_recommendation` |                                                      |
| `create_experiment` / `get_experiment_result` / `stop_experiment`          |                                                      |
| `get_seasonal_calendar`                                                    | Próximas datas e sugestões                           |

### Governança

| Tool                     | Descrição                                |
| ------------------------ | ---------------------------------------- |
| `list_pending_approvals` | O agente vê o que está aguardando humano |
| `get_audit_log`          | Últimas ações (filtrável)                |

## Fluxo de upload pelo agente

```
request_upload(filename, mime, size_bytes)          → { upload_id, put_url, expires_at, headers }
PUT put_url  (curl -T arquivo.mp4 ... / CLI)
complete_upload(upload_id, offer_id?, tags?, title?) → { creative_id, variants[], preview_url, validation }
```

Fallbacks: `import_media_from_url` e `ofertas upload <arquivo>` (CLI). Base64 inline aceito só até ~2 MB (imagens).

## Critérios gerais de aceite

- Toda tool tem schema Zod em `packages/contracts`, teste de contrato, e aparece no OpenAPI ou no `tools/list`.
- Teste e2e com cliente MCP real (SDK) no CI cobrindo: listar tools, `dry_run`, erro de escopo, idempotência.
