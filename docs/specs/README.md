# Specs — Plataforma de Ofertas (Grupos + Instagram)

Plataforma para operar um negócio de ofertas de afiliados (grupos de WhatsApp + Instagram), feita para **humanos operarem pelo painel** e para **agentes de IA operarem via MCP/API** com a mesma capacidade.

## Índice

| #   | Documento                                                  | Conteúdo                                                                  |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| 00  | [Visão e princípios](00-visao-e-principios.md)             | Objetivo, escopo, princípios de produto, glossário                        |
| 01  | [Arquitetura](01-arquitetura.md)                           | Stack, componentes, deploy, segurança                                     |
| 02  | [Modelo de dados](02-modelo-de-dados.md)                   | Entidades e relacionamentos                                               |
| 03  | [API, MCP e interface para agentes](03-api-mcp-agentes.md) | Auth, escopos, dry-run, idempotência, erros, auditoria, catálogo de tools |
| 10  | [Afiliados e ofertas](10-afiliados-e-ofertas.md)           | Conectores, busca, validação, histórico de preço                          |
| 11  | [Links e rastreamento](11-links-e-rastreamento.md)         | Encurtador, sub-IDs, cliques, atribuição                                  |
| 12  | [Grupos e publicação](12-grupos-e-publicacao.md)           | WhatsApp, fila, regras, rotação de grupos, moderação                      |
| 13  | [Instagram](13-instagram.md)                               | Publicação, DM por comentário, link na bio                                |
| 14  | [Criativos](14-criativos.md)                               | Templates, geração, upload, prévia, brand kit                             |
| 15  | [Anúncios](15-anuncios.md)                                 | Meta Ads, landing de entrada, CAPI                                        |
| 16  | [Métricas e financeiro](16-metricas-e-financeiro.md)       | Funil, comissões, ROI                                                     |
| 17  | [Growth](17-growth.md)                                     | Recomendações, experimentos, indicação, calendário                        |
| 90  | [Roadmap](90-roadmap.md)                                   | Fases, entregáveis e critérios de aceite                                  |
| 91  | [Riscos e decisões em aberto](91-riscos-e-decisoes.md)     | O que precisa ser validado/decidido                                       |

## Como usar estas specs

- Implementamos **uma fase do roadmap por vez**. Cada fase referencia as seções das specs que cobre.
- Spec é documento vivo: ao implementar, se a realidade divergir (ex.: limite de API), **atualize a spec no mesmo PR**.
- Itens marcados **[DECISÃO]** estão em aberto e listados em [91](91-riscos-e-decisoes.md).
- Itens marcados **[VERIFICAR]** dependem de confirmação externa (API, termos de uso).
