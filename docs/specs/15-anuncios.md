# 15 — Anúncios (Meta Ads)

## Objetivo dos anúncios

A venda acontece no marketplace (fora do alcance do Pixel), então o anúncio **otimiza para entrada no grupo / seguidor**, não para compra. O ROI é fechado pela plataforma: gasto do anúncio × comissões atribuídas aos membros/cliques vindos dele.

## Landing page de entrada

- `go.<dominio>/l/<slug>`: página leve (promessa do grupo, prova social, botão "Entrar no grupo") → convite rotativo.
- **Meta Pixel** + **Conversions API (CAPI)** server-side: eventos `PageView`, `Lead`/`CompleteRegistration` ao clicar em entrar (dedupe por `event_id`).
- UTMs/`ad_id` preservados até o clique de entrada (`?ad=`), para atribuir `joins` por anúncio.

## Gestão

Via Meta Marketing API, com a plataforma como fonte da verdade dos rascunhos:

- Criar **rascunho** de campanha/conjunto/anúncio a partir de criativos da biblioteca (`create_ad_draft`).
- **Publicação no Meta sempre passa pela política de aprovação** (padrão: `approval`).
- Pausar/retomar, ajustar orçamento (limitado por `ads.daily_spend`).
- Sincronização periódica de status e insights (`ad_insights_daily`).

## Métricas

| Métrica                              | Fonte                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Gasto, impressões, cliques, CPM, CTR | Meta Insights                                                                                                     |
| Visitas à landing                    | Nosso redirect/landing                                                                                            |
| Entradas no grupo (estimadas)        | Clique em "entrar" na landing; confirmação por crescimento do grupo no período                                    |
| **Custo por membro**                 | gasto / entradas                                                                                                  |
| Comissão atribuída                   | Conversões via sub-ids (`sub1=ads`, `sub2=campanha`) e cliques de membros vindos do anúncio (janela configurável) |
| **ROAS / LTV do membro**             | comissão atribuída / gasto                                                                                        |

## Regras de alerta (alimentam growth)

- Custo por membro > 2× a média dos últimos 7 dias → `ad.cpa_high` → recomendação de pausa.
- Frequência alta + CTR em queda → fadiga do criativo.

## Critérios de aceite

- Conectar conta de anúncios Meta.
- Landing com Pixel + CAPI funcionando (eventos de teste no Events Manager).
- Criar rascunho, aprovar no painel, publicar, pausar.
- Painel/tool com custo por membro e ROAS por anúncio.
