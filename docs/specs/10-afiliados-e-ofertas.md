# 10 — Afiliados e ofertas

## Conectores de afiliado

Interface comum (`packages/connectors/affiliate`):

```ts
interface AffiliateConnector {
  platform: Platform;
  capabilities: {
    search: boolean; // busca de produtos/ofertas por API
    productLookup: boolean; // detalhe por URL/id
    linkGeneration: boolean; // gerar link de afiliado por API
    subIds: number; // quantos sub-ids suporta (0 = nenhum)
    conversionsReport: boolean;
  };
  search(q: SearchQuery): Promise<ProductOffer[]>;
  lookup(urlOrId: string): Promise<ProductOffer | null>;
  generateLink(productUrl: string, subIds: string[]): Promise<string>;
  fetchConversions?(from: Date, to: Date): Promise<Conversion[]>;
}
```

A UI e o MCP leem `capabilities` para esconder/explicar o que não é possível em cada plataforma.

### Situação esperada por plataforma  [VERIFICAR antes de cada fase]

| Plataforma                                              | Busca                             | Link por API                    | Sub-IDs                             | Relatório                                       | Observações                                                                                               |
| ------------------------------------------------------- | --------------------------------- | ------------------------------- | ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Shopee**                                              | Sim (Affiliate Open API, GraphQL) | Sim (`generateShortLink`)       | Sim (até 5)                         | Sim (relatórios de conversão)                   | **Primeiro conector.** Melhor API do grupo                                                                |
| **Amazon**                                              | Sim (PA-API 5)                    | Link montado com `tag`          | Via tracking IDs (vários por conta) | Relatório pelo portal (sem API pública robusta) | Acesso à PA-API exige vendas qualificadas recentes; termos rígidos sobre exibição de preço e encurtadores |
| **Mercado Livre**                                       | Limitada/sem API de afiliado      | Gerador no portal               | [VERIFICAR]                         | Portal                                          | Provável: lookup por API pública de itens + link gerado manual/semiautomático                             |
| **Magazine Luiza**                                      | [VERIFICAR] (Parceiro Magalu)     | Link com id da loja do parceiro | [VERIFICAR]                         | Portal                                          |                                                                                                           |
| Outras (AliExpress, Natura, Netshoes via Awin/Lomadee…) | Conforme rede                     |                                 |                                     |                                                 | Futuro, via conectores de redes de afiliados                                                              |

Quando não há API de link: a plataforma aceita **link de afiliado colado** (humano ou agente) e trata como oferta manual; o rastreamento próprio (redirect) continua funcionando.

## Pesquisa de ofertas

- `search_offers(query, category?, min_discount?, price_min?, price_max?, platforms?, sort?)` consulta conectores em paralelo, normaliza e grava `product` + `price_point`.
- **Score** (0–100) calculado pelo `core`, configurável por workspace:
  - desconto real (vs. histórico, não vs. "preço de" do anúncio),
  - comissão estimada (preço × taxa),
  - avaliação e volume de vendas,
  - aderência aos nichos dos segmentos,
  - penalidade se já publicada nos últimos N dias.
- **Coleta contínua** (worker `offer-harvest`): buscas salvas rodam a cada X min, alimentam a fila de curadoria e o histórico de preço.

## Qualidade e validação

Flags calculadas em `offer.quality_flags`:

| Flag                        | Regra                                                          |
| --------------------------- | -------------------------------------------------------------- |
| `fake_discount`             | `original_price` acima da mediana dos últimos 30–90 dias + 15% |
| `lowest_30d` / `lowest_90d` | Preço atual é o menor da janela                                |
| `low_rating`                | Avaliação < 4.0 ou poucas avaliações                           |
| `low_stock`                 | Estoque baixo informado                                        |
| `coupon_required`           | Preço só vale com cupom                                        |

**Validação** (`validate_offer` e worker antes de cada envio): consulta preço, estoque e cupom atuais. Se o preço subiu > tolerância (padrão 5%) ou sem estoque → post não sai, oferta vai para `expired`, evento `offer.expired` e, se configurado, substituição automática por similar.

## Histórico de preço

- `price_point` gravado a cada coleta/validação.
- Endpoint/tool `get_offer` retorna mínimo, mediana e máximo em 30/90 dias + série resumida.
- Alertas: produtos "observados" (watchlist) geram `offer.price_dropped` quando caem abaixo de um alvo.

## Implementação (Fase 2)

- **Nota:** desconto real 40 pts (comparado à mediana de 30 dias quando há 3+ observações; senão o desconto informado), comissão 20 (escala log, R$ 50 = máximo), avaliação 15, vendas 10 (log, 10 mil = máximo), nicho do workspace 10 (sem nichos definidos: 5), menor preço 90d +5 / 30d +3, desconto suspeito −15, avaliação baixa −10, sem estoque = 0. Pesos em `packages/core/src/scoring.ts` (configuráveis por workspace numa fase futura).
- **Desconto suspeito** exige 3+ observações em 3+ dias; **menor preço 30d** exige 7+ dias de histórico e **90d**, 30+ dias. Sem histórico, nenhum desses sinais aparece.
- O preço só é gravado de novo se mudou ou se passou 1 h desde o último registro do produto.
- A Shopee não devolve o preço "de": ele é derivado de `priceDiscountRate`.
- `save_offer` sempre consulta o preço atual antes de salvar; produtos recusados não voltam pela busca automática.
- Credenciais só entram pelo painel (nunca por agentes) e nunca vão para o log de auditoria.

## Critérios de aceite (fase Shopee)

- Conectar conta Shopee com credenciais da Open API; credenciais cifradas.
- Buscar por termo/categoria e salvar ofertas com score e flags.
- Gerar link de afiliado com sub-ids `[canal, post, criativo]`.
- Validar oferta antes do envio e bloquear oferta expirada.
- Adapter `fake` para testes e sandbox.
