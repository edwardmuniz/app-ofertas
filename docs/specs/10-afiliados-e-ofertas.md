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

### Shopee: modos da conta

A conta Shopee tem três modos:

| Modo                 | De onde vêm os produtos                                               | Link de comissão                        | Precisa de                    |
| -------------------- | --------------------------------------------------------------------- | --------------------------------------- | ----------------------------- |
| **Feed de produtos** | Catálogo local importado do CSV oficial (Criativo › Feed de Produtos) | `an_redir` montado com o ID de afiliado | ID de afiliado + links do CSV |
| **Real (API)**       | Affiliate Open API (GraphQL)                                          | `generateShortLink` da API              | App ID e senha                |
| **Simulado**         | Catálogo de teste                                                     | Falso                                   | Nada                          |

#### Feed de produtos

- **Arquivo:** a Shopee gera, todo dia, CSVs com até 100 mil produtos cada (~200 MB). O link `affiliate.shopee.com.br/api/v1/datafeed/download?id=…` baixa sem login (redireciona para um endereço assinado). Cada feed tem colunas diferentes, então as colunas são lidas pelo nome: `itemid`, `title`, `price` (preço "de"), `sale_price` (preço atual), `discount_percentage`, `item_rating`, `image_link…`, `global_category1..3` / `global_catid1..3`, `shop_name`, `like`, `product_link`, `product_short link`. Não há vendas nem comissão no feed.
- **Importação (worker):** a cada minuto, o worker vê se alguma conta em modo feed nunca importou, pediu atualização ou está há mais de 20 h sem importar. Lê os CSVs em fluxo (sem carregar o arquivo inteiro), guarda em `feed_items` **só produtos com 10% de desconto ou mais e avaliação 4+** (ou sem avaliação) e, ao final, apaga o que não veio. Se um download falhar no meio, o catálogo antigo fica intacto e há nova tentativa em ~1 h. A trava no Redis impede duas importações ao mesmo tempo. Tempo medido: ~35 s para 10 mil produtos (quase tudo download).
- **Busca e validação:** o conector da conta feed consulta `feed_items` (palavras no título, categoria, ordenação). `lookup` também usa o catálogo: **produto que saiu do feed ou perdeu o desconto é tratado como indisponível**, e a oferta expira na validação antes do envio.
- **Link de comissão** (guia "Short-link Implementation Guideline" da Shopee): `https://s.shopee.com.br/an_redir?origin_link=<página codificada>&affiliate_id=<id>&sub_id=<v1>-<v2>-…`, com até 5 sub-ids alfanuméricos, que voltam no relatório como `utm_content`. Os links rastreados usam `origem-slug-campanha`.
- **Painel:** Afiliados → modo "Feed de produtos" (ID de afiliado + links, um por linha). A conexão confere o ID e se cada link devolve um CSV com `itemid`. A lista mostra quantos produtos em desconto há no catálogo, a última atualização e o botão **Atualizar agora**.
- **Andamento:** durante a importação, a conta grava a cada ~2 s o arquivo atual (n de N), os bytes lidos e o tamanho do arquivo, além de quantos produtos foram lidos e guardados. O painel mostra uma barra de progresso e atualiza a cada 3 s.
- **API/MCP:** `POST /v1/affiliate-accounts/:id/feed-sync` e `refresh_affiliate_feed` pedem nova importação; `list_affiliate_accounts` mostra o estado e o andamento do feed. Conectar, editar e remover contas continua só pelo painel.

#### Editar e remover contas

- **Editar** (`PUT /v1/affiliate-accounts/:id`): nome e credenciais. Campo em branco mantém o valor atual, e as credenciais salvas nunca são mostradas. As novas são testadas antes de salvar. Mudar os links do feed pede nova importação.
- **Remover** (`DELETE /v1/affiliate-accounts/:id`): ofertas e publicações ficam. As ofertas da conta passam a "por link" e mantêm o link de afiliado salvo. O catálogo do feed é apagado. O painel pede confirmação na própria tela.
- **Oferta por link com conta feed:** produto do catálogo vem com os dados do feed. Link comum da loja colado vira link de comissão, e cada link curto ganha seus sub-ids.

## Pesquisa de ofertas

- **Filtros de vitrine** (painel e `search_offers`): palavra, categoria (`list_offer_categories` / `GET /v1/offers/categories`; no feed, as categorias principais da Shopee em português, com contagem), faixa de preço, desconto mínimo, avaliação mínima e ordenação (relevância, maior desconto, menor/maior preço, mais populares, maior comissão). Paginação por `page`, e `has_more` diz se há mais. Na conta feed, os filtros rodam direto no banco; nas outras, são aplicados depois da busca.
- **Card do produto:** foto grande com selo de desconto e nota, loja, avaliação, preço "de/por" e link **Ver na loja** (página do produto, sem afiliação).

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
- O conector Shopee declara `conversionsReport: false` até a fase Financeiro implementar `fetchConversions`.
- Credenciais só entram pelo painel (nunca por agentes) e nunca vão para o log de auditoria.

## Oferta por link

Para quem ainda não tem as chaves da API da loja, ou quer divulgar um produto específico: cola-se o link do produto, de preferência o **link de afiliado** gerado no portal da loja (ex.: `s.shopee.com.br/…`), e a oferta é criada a partir dele.

- **Painel:** Ofertas → **Colar link**. O painel busca os dados, mostra o que achou e o que faltou, e permite conferir e completar antes de salvar (aprovada ou para a curadoria).
- **API:** `POST /v1/offers/from-link/preview` (só lê) e `POST /v1/offers/from-link` (cria ou atualiza; com `dry_run` e idempotência).
- **MCP:** `preview_offer_from_link` e `import_offer_from_link`. O agente deve perguntar ao usuário o que faltar e nunca inventar preço.
- **Como os dados são lidos:** a página é pedida como o WhatsApp pede para montar a prévia de link, seguindo redirecionamentos (links curtos) e bloqueando endereços internos. São lidos JSON-LD (`schema.org/Product`), Open Graph e metatags de preço. Quando a página não traz o título, ele sai do próprio endereço (ex.: `Nome-Do-Produto-i.123.456`).
- **O que cada loja entrega** (testado em 31/10/2026):

  | Loja          | Título           | Foto | Preço |
  | ------------- | ---------------- | ---- | ----- |
  | Amazon        | sim              | sim  | sim   |
  | Mercado Livre | sim              | sim  | não   |
  | Shopee        | só pelo endereço | não  | não   |
  | Magalu        | não (bloqueia)   | não  | não   |

  O que faltar é preenchido no formulário. Na Shopee, o painel explica como copiar o preço e o endereço da foto.
- **Com conta real ou feed da loja conectada**, os dados vêm dela (API ou catálogo do feed), e a oferta fica ligada à conta: o preço é conferido antes de cada envio, como nas ofertas da busca. Se o produto não está no catálogo do feed, a oferta fica como "por link", mas o link comum colado vira link de comissão com o seu ID.
- **Sem conta real**, a oferta fica sem conta de afiliado (`origin: "link"`): o link colado é o destino dos links curtos, e **o preço não é conferido antes do envio**. A oferta só expira pelo prazo. Para atualizar o preço, cola-se o link de novo: o mesmo produto atualiza a oferta aberta, sem duplicar.
- **Aviso de link sem comissão:** se o link colado parece ser a página comum da loja (sem marcação de afiliado), o painel avisa para gerar o link de afiliado no portal.
- Lojas aceitas: Shopee, Mercado Livre, Amazon (`.com.br`) e Magalu. Outros sites são recusados.

## Critérios de aceite (fase Shopee)

- Conectar conta Shopee com credenciais da Open API; credenciais cifradas.
- Buscar por termo/categoria e salvar ofertas com score e flags.
- Gerar link de afiliado com sub-ids `[canal, post, criativo]`.
- Validar oferta antes do envio e bloquear oferta expirada.
- Adapter `fake` para testes e sandbox.
