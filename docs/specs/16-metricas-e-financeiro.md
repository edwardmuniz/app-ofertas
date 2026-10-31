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

## Implementação (Fase 5)

- **Cliques:** `click_stats_hourly` (hora UTC × canal × oferta × post × link/convite, humanos e robôs) recalculado pelo worker a cada 5 min para as últimas horas. Painel e MCP leem daí; a resposta traz `data_freshness`.
- **Entradas/saídas e envios:** `channel_stats_daily`, atualizado em tempo real pelo webhook e pelo publicador.
- **Mapa de horários:** cliques atribuídos ao horário local em que o post foi enviado (não ao horário do clique), para escolher quando enviar.
- **Funil parcial:** a taxa de "cliques em ofertas" é cliques por membro por dia. Referências iniciais: entrada/clique no convite 40%, retenção 70%, 0,03 clique/membro/dia. Amostras pequenas não viram gargalo.
- **Alertas:** tabela `alerts` (um aberto por tipo e objeto). O worker roda as verificações a cada minuto; notificação opcional por `alert_webhook_url` (preferências). Worker parado é detectado no painel e por `/v1/status` (503), já que o próprio worker não consegue avisar.

## Critérios de aceite

- MVP: visão geral + cliques por canal/oferta/horário.
- Fase financeiro: import Shopee + CSV de outras, estados de comissão, lucro por período, ROAS por anúncio.
