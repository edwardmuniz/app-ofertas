# Análise da extensão "Pulso Social"

Levantamento do que a extensão **Pulso Social: Engajador Automático para Facebook** faz, a partir
da leitura do código instalado (Chrome Web Store, id `kpfpoabonomkcpjpepljhllcpgbppofg`, versão
**5.241.5**). É análise estática (leitura do código, que é minificado): o comportamento geral é
claro, mas alguns detalhes finos são **inferência** e estão marcados como tal.

> Serve de referência para o OfZap. **Importante:** boa parte do que ela faz é automação que passa
> por cima das proteções do Facebook (ver [Riscos](#riscos-e-por-que-o-ofzap-não-copia-tudo)). O
> O OfZap usa a interface visível do Facebook: ofertas ficam no modo assistido; convites pontuais
> criados na extensão podem ser publicados automaticamente. Não reproduz chamadas internas.

---

## 1. Identidade

| Campo            | Valor                                                  |
| ---------------- | ------------------------------------------------------ |
| Nome             | Pulso Social: Engajador Automático para Facebook       |
| Descrição        | "Like e comentários automáticos em grupos do Facebook" |
| Autor            | Assnet Developer                                       |
| Versão analisada | 5.241.5                                                |
| Manifest         | V3                                                     |
| Distribuição     | Chrome Web Store (`update_url` = clients2.google.com)  |

## 2. Permissões e alcance

```
permissions:        unlimitedStorage, alarms, tabs, storage, scripting, activeTab, cookies
host_permissions:   https://*.facebook.com/*, https://*.pulsosocial.app/*, https://*.pulsosocial.top/*
optional_host_permissions: <all_urls>
externally_connectable:    https://studio.pulsosocial.app/*
```

Pontos a destacar:

- **`cookies`** + host do Facebook: a extensão pode ler os cookies do Facebook (sessão). É uma das
  permissões mais sensíveis.
- **`tabs`, `scripting`, `activeTab`**: controla abas e injeta/roda scripts.
- **`unlimitedStorage`**: guarda muita coisa local (calibração, filas, configurações, cache).
- **`alarms`**: agenda execuções periódicas (o motor de automação).
- **`externally_connectable`** com `studio.pulsosocial.app`: o **painel web deles** fala direto com
  a extensão pelo navegador.

## 3. Arquitetura (arquivos e onde rodam)

Total de ~1,6 MB de JavaScript minificado. Os content scripts são injetados no Facebook em
diferentes momentos e **mundos** (`world`):

| Arquivo                           | Onde roda                                 | `world`  | Papel (inferido)                                                               |
| --------------------------------- | ----------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `background.js` (~275 KB)         | service worker                            | —        | Motor de fundo: fila de trabalhos, `alarms`, fala com a API deles              |
| `splash.js` (~9 KB)               | facebook.com (`document_start`)           | isolado  | Carregamento/estado inicial na página                                          |
| `inject.js` (~71 KB)              | facebook.com (`document_start`)           | **MAIN** | Entra no contexto da página para observar/emitir chamadas internas do Facebook |
| `facebook-functions.js` (~226 KB) | facebook.com (`document_end`)             | **MAIN** | Monta e dispara as chamadas GraphQL do Facebook (postar, comentar, reagir)     |
| `index.js` (~760 KB)              | facebook.com (`document_end`)             | isolado  | UI injetada, i18n (pt/en), orquestração do fluxo                               |
| `studio-bridge.js` (~185 KB)      | facebook.com (`document_idle`)            | isolado  | Ponte entre a página do Facebook e o "estúdio" (painel)                        |
| `site-bridge.js` (~3 KB)          | studio.pulsosocial.app (`document_start`) | isolado  | Ponte do painel web → extensão                                                 |
| `permissao.html/js`               | página própria                            | —        | Tela para pedir permissões adicionais                                          |

O ponto-chave: `inject.js` e `facebook-functions.js` rodam no **`world: "MAIN"`**, ou seja, **dentro
do contexto JavaScript da própria página do Facebook**. É isso que permite capturar e refazer as
chamadas internas do site (um content script normal, "isolado", não conseguiria).

## 4. Como conversa com os servidores dela

- **Painel do operador:** `studio.pulsosocial.app` (e `app.pulsosocial.app`). É onde o usuário monta
  campanhas e configura. Fala com a extensão via `externally_connectable` + `site-bridge.js`.
- **API/backend:** `api.pulsosocial.app` — vi chamadas a `/session/refresh`, `/user`. Trata
  login/sessão e, muito provavelmente, a fila de trabalhos e os limites [inferência].
- **Config remota:** `privacidade.pulsosocial.app/embed/embed-video-config.json`.

Ou seja: o **servidor deles decide** as campanhas; a extensão **executa** dentro do Facebook do
usuário. (A mesma divisão que o OfZap usa — a diferença é como a extensão executa.)

## 5. Mecanismo central: "calibração" + repetição de chamadas internas

É o coração da ferramenta e a parte que a torna poderosa (e problemática).

1. **Calibração.** Quando o usuário faz uma ação real (ex.: publica um post), os scripts no `world:
   MAIN` observam as chamadas que o Facebook faz para `/api/graphql/` e **guardam o formato** da
   operação: o `doc_id` (id da query persistida), o nome da operação, e onde ficam o texto, o id do
   grupo e a foto. Há eventos internos `composerCalibrated` / `photoCalibrated` e um cache de
   "probe" (`postProbeStats`, `rulesVersion`, `docId`).
2. **Repetição.** Para cada trabalho da fila, a extensão **remonta a mesma chamada GraphQL**,
   trocando o grupo, o texto e a imagem, e assinando com os tokens da sessão que estão na página:
   `fb_dtsg`, `lsd`, `jazoest`, `__user`, `av`. Lê a resposta (id do post, post pendente, ou erro).
3. **Recalibração.** Quando o Facebook muda o formato (novo `doc_id`), a chamada falha; a extensão
   detecta e pede uma nova calibração.

Em resumo: ela **imita o navegador fazendo a ação**, sem o usuário clicar, reutilizando os tokens da
sessão. É exatamente o que o Facebook tenta impedir com a sua detecção anti-automação.

## 6. Funcionalidades

Reconhecidas pelos nomes de operação GraphQL e pelas strings de interface no código:

### Publicação automática em grupos ("Postador PRO" / autopost)

- Publica uma mídia (imagem/vídeo) + texto em **vários grupos automaticamente**, com intervalos e
  limites configuráveis. Operação de criação de post calibrada (`fb.composer.create.v1`, tipos
  texto/foto/vídeo). É o caso de uso que mais se parece com o que você quer (divulgar o grupo).

### Curtir e comentar automaticamente

- Reações/likes: `CometUFIFeedbackReactMutation`.
- Comentários: `CometUFICreateCommentMutation`.
- É o "engajador" do nome: curte e comenta em posts automaticamente.

### Varredura de feed e coleta

- Lê o feed dos grupos paginando (`GroupsCometFeedRegular`, `CometGroupDiscussion`, cursores
  `after`), para varrer posts.
- Coleta **membros e admins** dos grupos: `CometGroupMembersAdminsRootQuery`,
  `CometMembersRootQuery`, `CometMembersInTheSameCityRootQuery`,
  `CometMembersWithThingsInCommonRootQuery`, `CometGroupMembersFriendsRootQuery`.

### Busca de grupos

- Busca grupos por termo (`groups_search` / `groupsSearchCallsite`) — para achar grupos do nicho.

### Entrar em grupos e "aquecer" (warmer)

- Fluxo de entrada em grupos respondendo **perguntas de entrada** (membership questions:
  `CometMembershipQuestionsPreloadedDialogQuery`) e lidando com aceite de regras
  (`rules_agreement_status`). As strings `warmer_gr_*` descrevem um "aquecimento" de grupos; numa
  nota do próprio código, a versão atual **pula grupos pendentes e não aceita regras
  automaticamente** [conforme string no código].

### Pedidos de amizade

- `CometFriendRequestSendMutation` — envia solicitações de amizade automaticamente [inferência de
  uso].

### Vários perfis

- Troca de perfil/página sem logout: `CometProfileSwitchMutation`,
  `CometProfileSwitcherListQuery`.

## 7. Controles de ritmo (para parecer humano)

- **Intervalos configuráveis** entre ações: `delayMin`/`delayMax` (a UI deixa escolher; há padrões).
- **Execução em lote** (`batch`): roda um bloco de ações, **pausa e retoma sozinha em horário
  aleatório** ("After each batch, it pauses and resumes on its own at a random time").
- **Jitter** (atraso aleatório) somado às ações.

Esses controles existem justamente para **não parecer um robô** — isto é, para reduzir a chance de o
Facebook detectar a automação.

## 8. Dados que guarda

- Calibração das chamadas (`docId`, `rulesVersion`, `postProbeStats`).
- Configurações de campanha, filas, estado de login, cache — em `unlimitedStorage`/`chrome.storage`.
- i18n em **português e inglês**.

## 9. Riscos (e por que o OfZap não copia tudo)

O que torna a Pulso Social eficaz é também o que a torna arriscada e contrária aos termos do
Facebook:

1. **Reproduz chamadas internas com os tokens da sessão** (`fb_dtsg`, `doc_id`, …): é automação não
   autorizada do Facebook. O Facebook detecta esse padrão e pode **bloquear ou derrubar a conta**.
2. **Ritmo aleatório para "parecer humano"**: é evasão de detecção por desenho.
3. **Lê cookies e coleta membros/admins** de grupos: dados sensíveis e questões de LGPD.
4. **Posta em massa** (inclusive em grupos de terceiros): facilmente visto como spam — posts
   removidos, banimento dos grupos, denúncias contra a conta.

## 10. Comparação com a abordagem do OfZap

| Aspecto                   | Pulso Social                                         | OfZap (spec 19)                                                              |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Quem publica              | A extensão, sozinha (reproduz a chamada do Facebook) | A extensão tenta publicar convites pontuais; ofertas não vão para o Facebook |
| Tokens/chamadas internas  | Captura e repete (`fb_dtsg`, `doc_id`)               | **Não** usa; só a interface visível                                          |
| Cookies de sessão         | Lê                                                   | **Não** lê                                                                   |
| "Parecer humano" / evasão | Sim (lotes + horário aleatório)                      | Não; há limites e intervalos na fila                                         |
| Grupos onde posta         | Em massa, inclusive onde não é permitido             | Só grupos que **aceitam divulgação** (política detectada)                    |
| Coleta de membros         | Sim                                                  | Não                                                                          |
| Risco para a conta        | Alto                                                 | Existe risco nos convites automáticos; validar em grupo de teste             |

**Conclusão atualizada:** o OfZap pode buscar grupos visíveis, tentar entrar nos escolhidos e
publicar um convite pontual com imagem e texto definidos na extensão. A execução usa os controles
visíveis da página e depende de validação no Facebook real; o código não lê cookies nem reproduz
as chamadas internas usadas pela Pulso Social.

---

_Documento gerado a partir de análise estática do código da extensão (v5.241.5) em 08/11/2026.
Itens marcados como "inferência" não foram confirmados em execução._
