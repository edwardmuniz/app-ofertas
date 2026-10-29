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

## Critérios de aceite (fase Shopee)

- Conectar conta Shopee com credenciais da Open API; credenciais cifradas.
- Buscar por termo/categoria e salvar ofertas com score e flags.
- Gerar link de afiliado com sub-ids `[canal, post, criativo]`.
- Validar oferta antes do envio e bloquear oferta expirada.
- Adapter `fake` para testes e sandbox.
