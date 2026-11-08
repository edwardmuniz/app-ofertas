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

### Situação por plataforma (pesquisada em 01/11/2026)

| Plataforma                                              | Busca                                            | Link por API                          | Sub-IDs                                   | Relatório                     | Observações                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- | ----------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Shopee**                                              | Sim (Affiliate Open API, GraphQL)                | Sim (`generateShortLink`)             | Sim (até 5)                               | Sim (relatórios de conversão) | **Primeiro conector.** Melhor API do grupo                                                                              |
| **Amazon**                                              | Página de resultados da Amazon (ou Creators API) | Montado com `?tag=` (formato oficial) | Não (uma tag por canal, criada no portal) | Portal                        | **Integrada (Fase 7).** API exige 10 vendas em 30 dias. Proíbe encurtador que esconda a Amazon: post leva o link direto |
| **Mercado Livre**                                       | Não há API de afiliado                           | Só o gerador do portal (`meli.la`)    | Não                                       | Portal                        | Ferramentas de terceiros usam cookies da sessão (sem documentação, risco de bloqueio). Por enquanto: oferta por link    |
| **Magazine Luiza**                                      | Não há API (Parceiro Magalu)                     | Links da loja do parceiro (app/web)   | Não                                       | Portal                        | Página bloqueia leitura. Por enquanto: oferta por link, dados à mão                                                     |
| Outras (AliExpress, Natura, Netshoes via Awin/Lomadee…) | Conforme rede                                    |                                       |                                           |                               | Futuro, via conectores de redes de afiliados                                                                            |

### Shopee: Pix e "De" (02/11/2026)

A página da Shopee mostra preço no Pix (ex.: R$ 197,60 no Pix, ou R$ 208,00 com outros métodos) e parcelas, mas a API de afiliados e o feed não trazem esses campos, e o preço "De" do feed costuma ser inflado (ex.: "De R$ 2.500,00", sem preço riscado na página). A página bloqueia leitura automática.

- **Correção de preços** (`update_offer_prices` / `PATCH /v1/offers/:id/prices`; painel: "Preços" no card da oferta aprovada): preço, "De" (`null` remove o desconto falso e a flag `fake_discount`), Pix e parcelas. O agente com navegador lê a página e corrige antes de divulgar.
- A correção fica marcada (`price_details.manual`) e **vale enquanto o preço da loja não mudar**: a revalidação mantém Pix, parcelas e "De" corrigidos se o preço for o mesmo; se mudar, volta aos dados da loja.

### Mercado Livre (01/11/2026)

O Mercado Livre fechou o acesso de fora: a API de busca (`/sites/MLB/search`) e a de anúncios respondem 403 para apps de terceiros, mesmo com token (só os anúncios da própria loja), e as páginas de busca e de produto não entregam preço nem foto a leitores automáticos (a foto vira a logo da loja, que o sistema descarta). Link de afiliado também não tem API.

- **Fluxo:** o agente do usuário, com navegador e a conta logada, busca no site, gera o `meli.la` (barra de Afiliados na página do produto ou Gerador de links do portal) e chama `import_offer_from_link` com o link, `product_url` (a página do produto) e os dados que viu: título, foto, preço, preço "De", `pix_price` e `installments`.
- **Por que `product_url`:** o `meli.la` abre uma página "social" do afiliado com o produto cifrado (testado em 01/11/2026), sem o id `MLB…`. Sem a página do produto, o mesmo item colado por outro link viraria outra oferta.
- **Preço na lista e na página:** quando aparece "ou R$ X em outros meios" (ou "ou R$ X em Nx"), o valor em destaque é o do Pix e X é o preço normal. Resultados patrocinados (`click1.mercadolivre…`) são pulados.
- **Link:** botão **Compartilhar** da barra de Afiliados no topo da página do produto (logado) → "Gerar link / ID de produto" mostra o `meli.la`, o ID do produto para busca e um texto sugerido. Humanos fazem o mesmo pelo "Colar link".
- `meli.la` é reconhecido como link de afiliado do Mercado Livre.
- O preço **não** é conferido antes do envio (não há como ler): importar perto da hora de publicar.

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

### Amazon (Associados Amazon.com.br)

Conta Amazon em modo **Associado** (`live`), com:

| Campo                                                 | Obrigatório | Para quê                                                          |
| ----------------------------------------------------- | ----------- | ----------------------------------------------------------------- |
| `partner_tag` (tag de associado, ex.: `minhaloja-20`) | Sim         | Link de comissão: `https://www.amazon.com.br/dp/<ASIN>?tag=<tag>` |
| `credential_id` e `credential_secret` (Creators API)  | Não         | Busca e consulta pela API                                         |

- **Só com a tag:** as ofertas entram pela **busca** ou por **Colar link**.
  - **Busca pela página de resultados** (`/s?k=<palavra>`, pedida como o WhatsApp pede a prévia, uma página por busca, cerca de 48 produtos): ASIN, título, foto em alta (sem o sufixo de tamanho), preço, preço "De", parcelas, nota, avaliações e "compras no mês passado" (vira `sold_count`). Cada item já sai com o link da sua tag. Departamento vai como `rh=n:<nó>` e faixa de preço como `rh=p_36:<min>-<max>` em centavos. A Amazon ignora o filtro de desconto e a ordenação nessa página; o sistema filtra e ordena depois. O preço no Pix só aparece na página do produto (lido ao salvar a oferta e antes de cada envio). Captcha vira erro da plataforma.
  - **Colar link:** qualquer link da Amazon (inclusive `amzn.to` ou com a tag de outra pessoa) é remontado com a sua tag. A oferta fica ligada à conta e o **preço é conferido antes de cada envio** lendo a página do produto (título, foto em alta, preço, preço "De:", nota, estoque e categoria).
  - Página 404: produto não existe, a oferta expira.
  - Sem anúncio principal (só "Ver todas as opções de compra") ou "Não disponível": sem estoque, a oferta expira.
  - Captcha ou falha de leitura: erro da plataforma. A oferta **não** expira e o post tenta de novo depois.
- **Com a Creators API** (sucessora da PA-API 5, desligada em 2026; acesso em Associados › Ferramentas › Creators API, depois de 10 vendas qualificadas em 30 dias; perde o acesso após 30 dias sem vendas): token OAuth 2.0 (`client_credentials`, escopo `creatorsapi::default`) em `api.amazon.com/auth/o2/token`, chamadas `POST https://creatorsapi.amazon/catalog/v1/searchItems|getItems` com `x-marketplace: www.amazon.com.br`. Filtros: desconto mínimo (`minSavingPercent`), faixa de preço em centavos, nota mínima, ordenação. Até 10 itens por página e 10 páginas. Limite inicial de 1 requisição/s e 8.640/dia. A comissão por item não vem na API. [VERIFICAR com credenciais reais] o caminho de `searchItems` e a chave da lista em `getItems` (a documentação mostra `itemsResult` e `itemResults`).
- **Link direto, sem encurtador:** a política de Associados proíbe encurtador ou redirecionamento que esconda que o destino é a Amazon. Por isso, nas ofertas da Amazon, o post e o "Gerar link" usam o link de afiliado direto (`share_url`). O link rastreado continua sendo gravado (ligado ao post e à oferta), mas os cliques e vendas dessas ofertas aparecem só no relatório da Amazon.
- **Sub-ids:** a Amazon não tem. Para separar canais, crie tags diferentes no portal (uma conta por tag) ou use o relatório por tag.
- **Simulado:** a conta simulada da Amazon usa ASINs e links da Amazon (`?tag=simulado-20`).

## Cupom da oferta (05/11/2026)

- **Campos:** código, regra curta (`coupon_description`, ex.: "R$ 20 OFF acima de R$ 99") e validade (`coupon_valid_until`, opcional).
- **Como entra:** ao salvar (`save_offer`), no **Colar link** e, a qualquer momento, por `set_offer_coupon` / `PUT /v1/offers/:id/coupon`. `coupon_code: null` tira o cupom. No painel: "Mais opções › Cupom" da oferta aprovada. A validade é escolhida por dia e vale até 23h59 (horário de Brasília).
- **Na mensagem:** linha "🎟️ Cupom: _CODIGO_" e, abaixo, a regra em itálico, montadas pelo sistema (o texto da oferta não leva cupom). O card de preço e o texto da IA também recebem o cupom.
- **Validade:** vencido, o cupom continua salvo, mas some da mensagem, do card e do texto da IA sozinho (`coupon_active: false`). O painel mostra o código riscado com "(vencido)". Validade no passado é recusada.
- A flag `coupon_required` acompanha o cupom: entra quando ele é definido e sai quando é tirado.
- **Origem (`coupon_source`):** `manual` (pessoa ou agente; nunca muda sozinho) ou `store` (lido da loja). O cupom lido da loja entra ao salvar e é atualizado a cada conferência de preço: some quando a página deixa de mostrar. Salvar um cupom à mão passa a valer no lugar.
- **Amazon (lido da página):** "Aplicar cupom de 10%" e "Economize R$ 20 com cupom" (cupom de marcar, sem código) e "com o código PROMO10" (código promocional). Na página do produto, só vale o bloco de preço e promoções do anúncio principal (`promoPriceBlockMessage`, `couponText`, `vpcButton`…), não os carrosséis de outros produtos. Na busca, cada card tem o seu. Sem código, a mensagem leva "🎟️ Cupom de 10%: marque “Aplicar cupom” na página antes de comprar" (`{{cupom_ativar}}`).
- A Shopee (API e feed) e as outras lojas não informam cupom.

## Extensão do Chrome (05/11/2026)

Cadastro de oferta a partir da página aberta, sem copiar dado por dado (`apps/extension`, instalação no README da pasta).

- **Lê da página** (no navegador da pessoa, já logada): título, foto, preço, Pix, preço "De", parcelas, cupom e link de afiliado.
  - Mercado Livre: o valor em destaque com "ou R$ X em outros meios" é o Pix e X é o preço. Cupom "20% OFF com cupom" (sem código, de ativar na página) ou com código. O link `meli.la` vem da barra de Afiliados depois de "Compartilhar", ou da área de transferência (botão Colar).
  - Amazon: mesmos blocos lidos pelo servidor; link curto da barra de Associados, se aberto.
  - Shopee e outras: título e foto da página, preço e Pix pelo texto (conferir no formulário).
- **Confere e envia:** formulário com tudo editável e escolha entre aprovar já e mandar para revisar. Envia para `POST /v1/offers/from-link` com o token de API (`Authorization: Bearer`). Cupom sem código vai em `coupon_description` e vale como cupom de ativar na página.
- **Ligação:** endereço da API e token guardados na extensão. A permissão de acesso é pedida só para o endereço da API.
- **Próximo:** marcar vários produtos na vitrine de um cupom e cadastrar de uma vez; grupo de captura no WhatsApp (link + print lidos por IA).

## Cupom da loja inteira (05/11/2026)

Cupons que não são de um produto (ex.: "R$ 20 OFF acima de R$ 99 na Shopee") viram um post próprio nos grupos.

- **Cadastro:** `upsert_store_coupon` / `POST /v1/coupons` (`PUT /v1/coupons/:id` edita): loja, chamada, código (opcional: sem código, o resgate é pelo link), regras, link da página do cupom, imagem e validade. `list_store_coupons` / `GET /v1/coupons` (`status=active` traz só os que estão na validade) e `delete_store_coupon` / `DELETE /v1/coupons/:id` (cancela os envios agendados). Painel: Ofertas › **Cupons**.
- **Link:** ao salvar, o link vira link de afiliado pela conta da loja (Shopee: link curto com sub-id `cupom`; Amazon: `?tag=`). Sem conta conectada, vai o endereço colado, e o painel avisa. No envio, vira link rastreado (`campaign: cupom`), menos na Amazon, que vai direto.
- **Divulgar:** `schedule_posts(coupon_ids)` (até 20), com as mesmas janelas, intervalos e segmentos das ofertas. Painel: "Publicar nos grupos" no cupom, ou Publicações › "Cupons da loja". O mesmo cupom não se repete no mesmo grupo em 12 horas. Cupom vencido ou apagado não sai (o post fica `skipped`).
- **Mensagem:** "🎟️ _CUPOM SHOPEE_", a chamada em negrito, as regras, "Código: _X_" (ou "👉 Resgate o cupom no link antes de comprar"), "⏰ Válido até 05/11 às 23:59" e o link. Vai a imagem do cupom, se tiver.
- **Ainda não:** conferir na loja se o cupom continua valendo; buscar cupons sozinho (nenhuma loja expõe cupons pela API).

## Painel de ofertas (08/11/2026)

- **Abas com endereço próprio:** `/ofertas/buscar`, `/ofertas/revisar`, `/ofertas/aprovadas`, `/ofertas/cupons`, `/ofertas/rejeitadas`, `/ofertas/buscas-salvas` (o mesmo vale para `/publicacoes/fila`, `/agendar`, `/regras`, `/modelos`). Atualizar a página ou voltar no navegador mantém a aba. Links antigos `/publicacoes?offer=` abrem em Agendar.
- **Seleção de várias:** "Selecionar várias" em Para revisar, Aprovadas e Rejeitadas. A foto vira caixa de marcar, há "Marcar todas", e uma barra fixa embaixo oferece Aprovar, Voltar para revisar e Tirar das aprovadas/Rejeitar (com motivo). Usa `set_offers_status` / `POST /v1/offers/bulk-status` (até 200 por vez; expiradas não são aprovadas; as que já estão na situação são ignoradas).

## Pesquisa de ofertas

- **Filtros de vitrine** (painel e `search_offers`): palavra, categoria (`list_offer_categories` / `GET /v1/offers/categories`; no feed, as categorias principais da Shopee em português, com contagem; na conta da API da Shopee, a lista fixa das mesmas categorias principais, sem contagem, porque a API não lista categorias e aceita o código em `productCatId`)., faixa de preço, desconto mínimo, avaliação mínima e ordenação (relevância, maior desconto, menor/maior preço, mais populares, maior comissão). Paginação por `page`, e `has_more` diz se há mais. Na conta feed, os filtros rodam direto no banco; nas outras, são aplicados depois da busca. A busca com categoria vai só para a loja dona dela (o painel manda `platforms`).
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
- **Limite da Open API:** 8.000 chamadas por hora (documentação oficial da Open API, 11/2026). Passou do limite, a Shopee recusa até a próxima janela; o erro (código `10030`) vira `RATE_LIMIT` com a mensagem "Limite de requisições da Shopee atingido".
- `save_offer` sempre consulta o preço atual antes de salvar; produtos recusados não voltam pela busca automática.
- O conector Shopee declara `conversionsReport: false` até a fase Financeiro implementar `fetchConversions`.
- **Relatório de conversões (para a fase Financeiro), pela visão geral oficial da Open API:**
  - Até 500 registros por página. A partir da segunda página, é obrigatório consultar com o `scrollId` devolvido pela anterior.
  - O `scrollId` vale uma vez só e expira em 30 segundos, então as páginas seguintes precisam vir logo em sequência.
  - Uma nova consulta sem `scrollId` exige 30 segundos de intervalo desde a anterior.
  - Dá para consultar só os últimos 3 meses (o mesmo período do portal); um intervalo maior volta erro.
- **Datas:** a Shopee guarda no horário local da região, mas os campos de data são timestamps (o mesmo instante em qualquer fuso).
- **Teste manual de consultas:** explorer em `https://open-api.affiliate.shopee.com.br/explorer/v2`.
- **Referência da Open API (conferida em 11/2026):**
  - **`productOfferV2`** (busca): `keyword`, `productCatId`, `itemId`, `shopId`, `page`, `limit` (padrão 20). `sortType`: 1 relevância (só com palavra-chave), 2 mais vendidos, 3 maior preço, 4 menor preço, 5 maior comissão. Sem palavra-chave, a plataforma troca relevância por mais vendidos. Também aceita `listType` (1 maior comissão, 2 mais vendidos no momento, 3/4 categoria, 5 loja, 6 coleção, com `matchId`), ainda não usado.
  - Campos por produto: comissão total e por origem (`appNewRate`, `appExistRate`, `webNewRate`, `webExistRate`, `sellerCommissionRate`, `shopeeCommissionRate`), `priceMin`/`priceMax`, `priceDiscountRate` (0–100) e `productCatIds` (níveis 1 a 3, os mesmos códigos globais do feed).
  - **`generateShortLink`** (usado) e **`generateBatchShortLink`** (até 50 links por chamada; ainda não usado, serve para agendar muitos envios de uma vez).
  - **`shopOfferV2`** (lojas com comissão extra) e **`shopeeOfferV2`** (campanhas da Shopee por coleção ou categoria): ainda não usados.
  - **`listItemFeeds` / `getItemFeedData`:** o feed de produtos pela API, em páginas de até 500 linhas, completo (`FULL`) ou só as mudanças do dia (`DELTA`, com `updateType` NEW/UPDATE/DELETE). Alternativa futura ao download do CSV no modo feed.
  - **`conversionReport`** (Financeiro): filtra por data do pedido ou da conclusão, status (`orderStatus`: UNPAID, PENDING, COMPLETED, CANCELLED), loja, produto, categoria e fraude. Cada conversão traz `utmContent` (os nossos sub-ids), `totalCommission`, `netCommission`, `clickTime`, `purchaseTime` e os pedidos com itens (preço, quantidade, comissão por item, status e motivo). Paginação só por `scrollId`. **`validatedReport(validationId)`** traz o relatório já validado de um fechamento.
- Credenciais só entram pelo painel (nunca por agentes) e nunca vão para o log de auditoria.

## Oferta por link

Para quem ainda não tem as chaves da API da loja, ou quer divulgar um produto específico: cola-se o link do produto, de preferência o **link de afiliado** gerado no portal da loja (ex.: `s.shopee.com.br/…`), e a oferta é criada a partir dele.

- **Painel:** Ofertas → **Colar link**. O painel busca os dados, mostra o que achou e o que faltou, e permite conferir e completar antes de salvar (aprovada ou para a curadoria).
- **API:** `POST /v1/offers/from-link/preview` (só lê) e `POST /v1/offers/from-link` (cria ou atualiza; com `dry_run` e idempotência).
- **MCP:** `preview_offer_from_link` e `import_offer_from_link`. O agente deve perguntar ao usuário o que faltar e nunca inventar preço.
- **Como os dados são lidos:** a página é pedida como o WhatsApp pede para montar a prévia de link, seguindo redirecionamentos (links curtos) e bloqueando endereços internos. São lidos JSON-LD (`schema.org/Product`), Open Graph e metatags de preço. Quando a página não traz o título, ele sai do próprio endereço (ex.: `Nome-Do-Produto-i.123.456`).
- **O que cada loja entrega** (testado em 31/10/2026):

  | Loja          | Título           | Foto                      | Preço |
  | ------------- | ---------------- | ------------------------- | ----- |
  | Amazon        | sim              | sim                       | sim   |
  | Mercado Livre | sim              | não (logo, desde 11/2026) | não   |
  | Shopee        | só pelo endereço | não                       | não   |
  | Magalu        | não (bloqueia)   | não                       | não   |

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
