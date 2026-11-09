# Extensão do Chrome do OfZap

Faz duas coisas: **cadastra ofertas** a partir da página de um produto e ajuda a **publicar posts
nos grupos do Facebook** (de forma semiautomática — ver no fim).

## Cadastrar oferta

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

## Posts nos grupos do Facebook (semiautomático)

A extensão também ajuda a publicar as ofertas agendadas no OfZap em grupos do Facebook de que você
participa e que aceitam divulgação. **Ela não publica sozinha: você revisa e clica em Publicar.**
Ela não lê cookies, não captura tokens e não usa nada interno do Facebook — só a tela normal.

### Preparar

1. Na extensão → **Configurar**, além da API e do token, preencha o **id do seu perfil do
   Facebook** (abra `facebook.com/me` logado e copie o número que aparece no endereço). O token
   precisa do escopo `facebook:execute` (preset **Extensão do Chrome** em Agentes).
2. Deixe uma aba do **Facebook aberta e logada** no Chrome. A extensão avisa o OfZap que está
   online e busca o próximo post agendado para um dos seus grupos, uma vez por minuto.

### Publicar

Quando há um post para um grupo, abra esse grupo no Facebook. Um painel do OfZap aparece no canto:

1. **Preencher no Facebook** põe o texto no campo "Escreva algo…" (ou use **Copiar texto**).
2. **Copiar imagem** coloca a imagem na área de transferência — cole no post com Ctrl+V (ou
   **Baixar imagem** e anexe).
3. Revise e **publique no Facebook**.
4. Copie o link do post (menu "…" do post → **Copiar link**) e cole no painel → **Confirmar
   publicado**. O OfZap registra a publicação. Se o grupo não deixar postar, use **Não deu certo →
   Grupo não deixa postar**: o OfZap pausa esse grupo.

O OfZap controla os intervalos (3 a 8 min entre posts, 1 por grupo por dia) e pausa tudo por 24 h
se o Facebook sinalizar bloqueio.

### Este grupo aceita divulgação?

Na página de um grupo, o painel tem **Analisar este grupo**. Deixe as regras e alguns posts à
vista (role um pouco) e clique: a extensão lê o texto visível (regras, descrição e últimos posts) e
o OfZap diz se o grupo **aceita divulgação**, aceita com aprovação/condição, ou **não aceita**.
Grupos que não aceitam (ou ainda não analisados) **não recebem post**. É só um palpite — você pode
corrigir no painel, e a sua correção manual não é desfeita por uma análise depois.

### Desenvolvimento (Facebook)

- `fb-core.js`: regras puras (casar grupo da aba com o trabalho, escolher variação de texto,
  validar/limpar o link do post). Testes em `test/fb-core.test.js`.
- `fb-bridge.js`: service worker (MV3). Fala só com a API do OfZap: heartbeat, pega trabalho, baixa
  a imagem, registra o resultado. Não fala com o Facebook.
- `fb-group.js`: content script na página do grupo. Monta o painel, preenche/copia e confirma pelo
  link do post. Toda ação de publicar é um clique da pessoa.
