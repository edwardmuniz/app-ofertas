# Extensão do Chrome do OfZap

**Cadastra ofertas** a partir da página de um produto e ajuda a **descobrir grupos do Facebook,
participar dos selecionados e publicar convites pontuais** com imagem e texto.

## Studio de grupos

Clique em **Abrir Studio** no popup. O Studio abre em uma aba, com três áreas:

1. **Encontrar grupos:** deixe uma aba do Facebook aberta, informe o nicho e clique em **Buscar grupos**.
   A extensão consulta pela sessão dessa aba e mostra os resultados no Studio, sem criar outra aba.
   Na primeira vez, faça uma busca normal de grupos no Facebook para calibrar o formato da consulta.
   Os grupos são classificados por
   termos do nicho no nome, membros e atividade informados pelo Facebook. Avalie regras e
   participação, selecione até 10 e clique
   em **Participar dos selecionados**.
   Se você já participa de grupos, clique em **Carregar meus grupos** e escolha quais adicionar ao
   OfZap. Abra cada grupo cadastrado e use **Analisar este grupo** antes de publicar. A lista do
   Postador mostra os grupos aptos, os que aguardam análise e os indisponíveis. Apenas grupos com
   política de postagem analisada e permitida podem ser selecionados. Depois da análise, clique em
   **Atualizar grupos** no Postador. Ao cadastrar os
   escolhidos, o Studio registra primeiro o perfil do Facebook na API do OfZap. Se a consulta
   demorar mais de um minuto, atualize a aba do Facebook e tente novamente; os grupos já retornados
   podem ser cadastrados mesmo quando a paginação é interrompida.
2. **Biblioteca:** cadastre textos de convite e envie imagens. Eles ficam na API do OfZap, para uso
   posterior. Os textos são modelos marcados com `FB: `; as imagens são criativos marcados para convites.
3. **Postador:** em **Publicação única**, escreva um texto e escolha uma imagem. Em **Usar biblioteca**,
   selecione vários textos e imagens. A prévia mostra todas as combinações em ordem: texto 1 com
   imagem 1, texto 1 com imagem 2, depois texto 2 com imagem 1 etc. Cada grupo selecionado recebe
   um post da sequência. Use o convite direto do WhatsApp ou um link rastreado
   `https://go.ofzap.com.br/entrar/...`; ele é incluído automaticamente.

O token do preset **Extensão do Chrome** agora inclui `posts:read` e `creatives:read`. Gere um novo
token no painel se o Studio informar falta de escopo. A publicação automática continua exigindo a
calibração manual de um post com imagem no perfil do Facebook.

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

Se **Participar dos selecionados** ou **Agendar convite** mostrar erro de conexão, confira o
endereço em **Configurar** e se a API está rodando. Na instalação local, inicie `pnpm infra:up`,
`pnpm db:migrate` e `pnpm dev`; depois use **Salvar e testar** na extensão. A montagem das buscas
continua funcionando sem API, mas participar e agendar exigem a conexão.

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

## Posts nos grupos do Facebook

A extensão ajuda a publicar convites nos grupos do Facebook de que você participa e que aceitam
divulgação. Ofertas e cupons não são agendados para esses grupos. Para o convite pontual criado na
extensão, ela usa uma calibração feita com uma publicação manual no próprio perfil do Facebook.
O modelo fica no armazenamento local da extensão; tokens de sessão não são guardados.

### Preparar

1. Na extensão → **Configurar**, além da API e do token, preencha o **id do seu perfil do
   Facebook** (abra `facebook.com/me` logado e copie o número que aparece no endereço). O token
   precisa do escopo `facebook:execute` (preset **Extensão do Chrome** em Agentes).
2. Deixe uma aba do **Facebook aberta e logada** no Chrome. A extensão avisa o OfZap que está
   online e busca o próximo post agendado para um dos seus grupos, uma vez por minuto.

### Publicar

Para ativar a publicação automática de convites, abra um grupo onde você pode fazer um teste,
clique em **Calibrar publicação** no painel do OfZap e, em até 10 minutos, publique manualmente um
post com uma foto e um texto de teste com pelo menos 12 caracteres (ex.: "Teste OfZap 4821"). O
painel avisa quando vê a imagem e quando a calibração foi salva, ou explica por que recusou (texto
curto, publicação sem foto, formato não reconhecido, perfil logado diferente do configurado ou prazo
expirado). Recarregar a aba durante a calibração não a cancela. Faça isso uma vez por perfil e
repita se o Facebook mudar o fluxo. Use uma publicação de teste real e confira o resultado no grupo.

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

Na página de um grupo, o painel tem **Analisar este grupo**. Role o feed para carregar alguns
posts e clique: a extensão lê o texto visível dos posts (com os domínios dos links) e os cartões de
regras/Sobre, e o OfZap diz se o grupo **aceita divulgação**, aceita com aprovação/condição, ou
**não aceita**. A resposta mostra quantos posts foram lidos e se as regras apareceram. Se faltar
regra, abra a aba **Sobre** do grupo e analise de novo: a extensão junta o que leu nas duas páginas.
Grupos que não aceitam (ou ainda não analisados) **não recebem post**. É só um palpite — você pode
corrigir no painel, e a sua correção manual não é desfeita por uma análise depois.

### Descobrir grupos do nicho

No Studio, use **Encontrar grupos**. A busca consulta até 100 resultados pela sessão do Facebook
e destaca os mais relacionados ao nicho. Selecione até 10 por rodada. A extensão
tenta entrar em um grupo a cada 5 minutos; perguntas, aceite de regras e política de divulgação
precisam ser conferidos no Facebook. Grupos com entrada confirmada são cadastrados no OfZap.

### Convite pontual com imagem

No Studio, use **Postador**. Uma publicação única usa um texto e uma imagem. O modo biblioteca
combina todos os textos e imagens selecionados e distribui uma combinação por grupo apto. O
intervalo entre grupos pode ser ajustado. A extensão só registra a conclusão quando o Facebook
devolve um identificador do post; erro ou resposta ambígua exigem conferência humana. Ofertas não
são enviadas a grupos do Facebook.

O token precisa do preset **Extensão do Chrome** atualizado (escopos `facebook:execute`,
`posts:read`, `posts:write`, `creatives:read` e `creatives:write`). Se você criou um token antes
desta versão, gere outro no painel.

### Desenvolvimento (Facebook)

- `fb-core.js`: regras puras (casar grupo da aba com o trabalho, escolher variação de texto,
  validar/limpar o link do post). Testes em `test/fb-core.test.js`.
- `fb-bridge.js`: service worker (MV3). Coordena a fila, baixa a imagem, guarda a calibração local
  por perfil e registra o resultado pela API do OfZap.
- `fb-group.js`: painel no grupo, calibração, fluxo assistido e acompanhamento do convite.
- `fb-replay-core.js` e `fb-main.js`: captura do formato de um post manual e publicação do convite
  na sessão ativa do mesmo perfil. Testes em `test/fb-replay.test.js`.
- `studio.*`: interface em aba para encontrar grupos, manter a biblioteca e agendar publicações.
