# 02 — Modelo de dados

Visão lógica. Nomes em inglês no código/banco; descrições em português. Toda tabela de negócio tem `id` (UUIDv7), `workspace_id`, `created_at`, `updated_at`. Exclusão lógica (`deleted_at`) onde fizer sentido.

## Identidade e acesso

| Entidade                       | Campos principais                                                                                                                                      | Notas                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `workspace`                    | name, timezone (default `America/Sao_Paulo`), settings (jsonb)                                                                                         | Preferências/playbook lidas por agentes ficam em `settings.preferences` |
| `user`                         | email, name                                                                                                                                            |                                                                         |
| `membership`                   | user_id, workspace_id, role (`owner`/`admin`/`operator`/`viewer`)                                                                                      |                                                                         |
| `api_token`                    | name, token_hash, scopes[], created_by, last_used_at, expires_at, revoked_at                                                                           | Tokens de agentes/CLI                                                   |
| `oauth_client` / `oauth_grant` | client_id, redirect_uris, scopes, user_id                                                                                                              | Fase OAuth do MCP                                                       |
| `policy`                       | action_type, mode (`auto`/`approval`/`blocked`), conditions (jsonb)                                                                                    | Política de aprovação por ação                                          |
| `limit`                        | key (ex.: `posts.per_hour.channel`, `ads.daily_spend`), value, scope                                                                                   | Limites aplicados no servidor                                           |
| `approval`                     | action_type, payload, requested_by (ator), status, decided_by, decided_at                                                                              | Fila de aprovações                                                      |
| `audit_log`                    | actor_type (`user`/`token`/`system`), actor_id, origin (`web`/`rest`/`mcp`/`cli`/`worker`), action, target, params (jsonb), reason, result, created_at | Imutável                                                                |
| `idempotency_key`              | key, actor, request_hash, response, expires_at                                                                                                         | 24h                                                                     |

## Afiliados e ofertas

| Entidade            | Campos principais                                                                                                                                                                                                    | Notas                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `affiliate_account` | platform (`shopee`/`amazon`/`mercadolivre`/`magalu`/…), label, credentials (cifrado), status, capabilities (jsonb)                                                                                                   | `capabilities` diz o que o conector suporta (busca, link, sub-id, comissões) |
| `product`           | platform, external_id, title, brand, category, image_urls[], url, rating, sold_count                                                                                                                                 | Único por (platform, external_id)                                            |
| `price_point`       | product_id, price, original_price, captured_at, source                                                                                                                                                               | Série temporal → histórico de preço                                          |
| `offer`             | product_id, affiliate_account_id, price, original_price, discount_pct, coupon_code, coupon_desc, commission_rate, affiliate_url, valid_until, status (`new`/`approved`/`rejected`/`expired`), score, quality_flags[] | `quality_flags`: ex. `fake_discount`, `low_rating`, `lowest_90d`             |
| `offer_validation`  | offer_id, checked_at, ok, price_now, in_stock, coupon_ok, details                                                                                                                                                    | Histórico de checagens                                                       |

## Canais e publicação

| Entidade              | Campos principais                                                                                                                                                                                                                  | Notas                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `messaging_account`   | provider (`evolution`/`wa_cloud`/…), phone, status, health (jsonb)                                                                                                                                                                 | Número/chip conectado                       |
| `channel`             | type (`wa_group`/`wa_community`/`wa_channel`/`ig_account`/`telegram`), external_id, name, messaging_account_id, member_count, member_limit, status                                                                                 |                                             |
| `segment`             | name, description                                                                                                                                                                                                                  | Nicho                                       |
| `channel_segment`     | channel_id, segment_id                                                                                                                                                                                                             | N:N                                         |
| `invite_link`         | slug, segment_id, strategy (`fill_first`/`round_robin`), active                                                                                                                                                                    | Convite rotativo                            |
| `message_template`    | name, body (com variáveis), channel_type                                                                                                                                                                                           | Ex.: `{{titulo}} por {{preco}} 🔥 {{link}}` |
| `post`                | offer_id, channel_id, creative_id?, body_rendered, scheduled_at, sent_at, status (`draft`/`pending_approval`/`scheduled`/`sending`/`sent`/`failed`/`canceled`/`deleted`), external_message_id, error, rule_id?, experiment_arm_id? |                                             |
| `automation_rule`     | name, active, filters (jsonb: categorias, desconto mín., plataforma, preço), targets (segmentos/canais), schedule (janelas, frequência), template_id, creative_template_id?                                                        | Gera posts                                  |
| `channel_stats_daily` | channel_id, date, members, joins, leaves, messages_sent, clicks                                                                                                                                                                    |                                             |

## Rastreamento

| Entidade       | Campos principais                                                                                                                                            | Notas                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `tracked_link` | slug, destination_url, offer_id?, channel_id?, post_id?, creative_id?, campaign, sub_ids (jsonb), active, fallback_url                                       | Um por (oferta × canal × post) |
| `click`        | tracked_link_id, ts, ip_hash, ua, referrer, country, is_bot                                                                                                  | Particionar por mês            |
| `conversion`   | affiliate_account_id, external_order_id, sub_ids, tracked_link_id?, amount, commission, status (`pending`/`confirmed`/`canceled`), occurred_at, confirmed_at | Importado das plataformas      |

## Criativos

| Entidade               | Campos principais                                                                                                                            | Notas                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `asset`                | storage_key, mime, size, width, height, duration_ms, checksum, source (`upload`/`render`/`import`)                                           | Arquivo bruto                            |
| `brand_kit`            | logo_asset_id, colors, fonts, tone_of_voice, watermark                                                                                       | Um ativo por workspace (pode ter vários) |
| `creative_template`    | kind (`image`/`video`), name, engine (`satori`/`remotion`), params_schema (jsonb), formats[]                                                 |                                          |
| `creative`             | offer_id?, kind, title, template_id?, origin (`template`/`upload`/`agent`), status (`draft`/`ready`/`archived`), tags[], ai_generated (bool) |                                          |
| `creative_variant`     | creative_id, format (`feed_4x5`/`story_9x16`/`square_1x1`/`wa_image`), asset_id, preview_asset_id, validation (jsonb)                        |                                          |
| `creative_stats_daily` | creative_id, date, impressions, clicks, ctr, conversions                                                                                     | Para detectar fadiga                     |

## Anúncios

| Entidade                        | Campos principais                                                       | Notas                                       |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| `ad_account`                    | provider (`meta`), external_id, credentials (cifrado), currency         |                                             |
| `ad_campaign` / `ad_set` / `ad` | espelho do Meta com external_id, status, budget, objective, creative_id | A plataforma é dona do registro; sincroniza |
| `ad_insights_daily`             | ad_id, date, spend, impressions, clicks, landing_views, joins           | `joins` vem do nosso rastreamento           |
| `landing_page`                  | slug, invite_link_id, pixel_id, content (jsonb)                         | Página de entrada no grupo                  |

## Growth

| Entidade          | Campos principais                                                                                                       | Notas                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `recommendation`  | type, title, rationale, evidence (jsonb), suggested_action (jsonb), status (`open`/`applied`/`dismissed`), expires_at   | Gerada por regras                 |
| `experiment`      | name, hypothesis, variable (`time`/`copy`/`creative`/`frequency`), status, metric, started_at, ended_at, result (jsonb) |                                   |
| `experiment_arm`  | experiment_id, name, config (jsonb), allocation                                                                         |                                   |
| `referral_member` | channel_id, member_ref (hash), invite_link_id, joins_count                                                              | Programa de indicação             |
| `season_event`    | name, date_start, date_end, notes                                                                                       | Calendário (Black Friday, 11.11…) |

## Eventos

| Entidade               | Campos principais                                                                                                            | Notas                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `event`                | type (ex.: `offer.price_dropped`, `channel.full`, `post.failed`, `ad.cpa_high`, `conversion.confirmed`), payload, created_at | Outbox; alimenta webhooks e recomendações |
| `webhook_subscription` | url, events[], secret, active                                                                                                | Fase posterior                            |
