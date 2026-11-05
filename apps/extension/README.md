# Extensão do Chrome: cadastrar oferta no OfZap

Na página de um produto (Mercado Livre, Amazon ou Shopee), clique no botão da extensão. Ela lê
título, foto, preço, Pix, parcelas, cupom e o seu link de afiliado. Confira os dados e toque em
**Cadastrar no OfZap**. A oferta entra em Aprovadas (ou em Para revisar, se você escolher).

## Instalar

1. No Chrome, abra `chrome://extensions` e ligue o **Modo do desenvolvedor** (canto superior direito).
2. Clique em **Carregar sem compactação** e escolha esta pasta (`apps/extension`).
3. Fixe a extensão na barra (ícone de quebra-cabeça → alfinete em "OfZap").

## Ligar ao OfZap

1. No painel do OfZap, em **Agentes**, crie um token com permissão de ofertas (ou use o do agente).
2. Clique na extensão → **Configurar**, cole o endereço da API (ex.: `http://localhost:3001` ou o
   da VPS) e o token, e toque em **Salvar e testar**. O Chrome pede permissão para acessar esse
   endereço: aceite.

## Link de afiliado

- **Mercado Livre:** logado na conta de afiliado, clique em **Compartilhar** na barra de Afiliados
  no topo da página e depois em **Ler a página de novo**. A extensão pega o link `meli.la`. Se não
  aparecer, use **Copiar link** na barra do Mercado Livre e toque em **Colar** na extensão.
- **Amazon:** o OfZap coloca a sua tag sozinho. Se a barra de Associados (SiteStripe) estiver com o
  link curto aberto, a extensão usa ele.
- **Shopee:** com a conta da Shopee conectada no OfZap, o link de comissão é gerado sozinho.

## Cupom repetido

- **Usar o último:** depois de cadastrar uma oferta com cupom, o próximo produto mostra o botão
  "Usar o último: CÓDIGO · regra", que preenche o cupom num toque.
- **Repetir este cupom nos próximos produtos:** marcado, o cupom já vem preenchido em todos os
  produtos seguintes (bom para cadastrar a vitrine de um cupom). Desmarque quando acabar.
- **Aprovar já / Mandar para revisar:** a extensão lembra a última escolha.

## Desenvolvimento

- `parse.js`: regras de leitura do texto (preço, Pix, parcelas, cupom, link). Testes em `test/`.
- `extract.js`: lê a página aberta (roda nela, junto com `parse.js`).
- `popup.*`: formulário e envio para `POST /v1/offers/from-link`.
- As classes das páginas das lojas mudam com o tempo: se um campo parar de vir, ajuste o seletor
  em `extract.js`. O formulário sempre deixa corrigir antes de cadastrar.
