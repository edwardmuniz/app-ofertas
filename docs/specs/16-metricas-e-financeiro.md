# 16 — Métricas e financeiro

## Funil

```
Alcance (IG/anúncio) → Visita (bio/landing/DM) → Entrada no grupo → Retenção (7d/30d)
     → Clique em oferta → Pedido → Comissão confirmada
```

`get_funnel(period, segment?, source?)` retorna volume e conversão de cada etapa, comparação com período anterior e a **etapa gargalo** (maior queda relativa vs. benchmark interno).

## Painéis

| Painel      | Conteúdo                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Visão geral | Membros totais, entradas/saídas, posts, cliques, comissão (pendente/confirmada), gasto, lucro                      |
| Ofertas     | Top por cliques/comissão, categorias, plataformas, faixa de preço, % expiradas antes do envio                      |
| Canais      | Por grupo: membros, crescimento, saídas pós-envio, cliques por mensagem, CTR                                       |
| Horários    | Heatmap dia × hora de cliques por envio                                                                            |
| Criativos   | CTR, uso, fadiga                                                                                                   |
| Anúncios    | Custo por membro, ROAS                                                                                             |
| Financeiro  | Receita por plataforma, comissão pendente vs confirmada vs cancelada, gastos (anúncios, chips, ferramentas), lucro |

Tudo disponível via API/MCP de forma **resumida** (`get_performance_summary`) e detalhada (endpoints REST).

## Comissões

- Import periódico por conector (`fetchConversions`) quando há API; senão **upload de CSV** do relatório do portal (parser por plataforma).
- Estados: `pending` → `confirmed` | `canceled`. Taxa histórica de cancelamento por plataforma para projetar receita.
- Atribuição pelos sub-ids (ver [11](11-links-e-rastreamento.md)).

## Gastos

Lançamento manual ou importado: anúncios (automático via Meta), chips/números, servidor, ferramentas, IA. Categorias e recorrência.

## Agregação

Worker `metrics-rollup` consolida diariamente (`channel_stats_daily`, `creative_stats_daily`, `ad_insights_daily`) e de hora em hora para o dia corrente. Consultas do painel e do MCP leem agregados.

## Critérios de aceite

- MVP: visão geral + cliques por canal/oferta/horário.
- Fase financeiro: import Shopee + CSV de outras, estados de comissão, lucro por período, ROAS por anúncio.
