# 19 — Grupos do Facebook

**Objetivo principal: captação de membros.** Divulgar os grupos de WhatsApp do negócio em grupos do Facebook do nicho de que o usuário participa e que aceitam divulgação — um post (imagem + texto) com o **link de convite do grupo de WhatsApp** (o `invite_url` já cadastrado no OfZap), para atrair gente para os grupos. (A mesma estrutura também publica ofertas, se o usuário quiser.)

O Facebook não tem API para postar em grupos (a API de grupos foi encerrada em 2024), então a publicação é **semiautomática**: a **extensão do Chrome** prepara cada post na interface normal do Facebook e **o usuário confirma e publica**. Usa a mesma fila, regras e limites dos grupos de WhatsApp.

## Princípios

- **Semiautomático: a pessoa publica.** A extensão preenche o texto, oferece a imagem e abre o grupo; a ação de postar é um clique do usuário no botão **Publicar** do próprio Facebook. A extensão não publica sozinha.
- **Sem burlar o Facebook.** A extensão não lê nem envia cookies de sessão, não captura nem repete tokens (`fb_dtsg`, `lsd`, `doc_id`), não chama endpoints internos e não tenta driblar bloqueios, CAPTCHA ou detecção. Usa só a interface visível e o que a pessoa faz.
- **O servidor decide, a extensão prepara.** Fila, regras, limites, deduplicação, link rastreado, texto e imagem ficam no `core`, como no WhatsApp. A extensão busca o próximo trabalho, prepara o post e devolve o resultado (link do post ou erro).
- **Só grupos que aceitam divulgação.** O usuário importa e mantém apenas grupos que permitem divulgar. Um grupo marcado como "não deixa postar" é pausado e não recebe mais posts (ver [Política do grupo](#política-do-grupo)).
- **Parar ao primeiro sinal de bloqueio.** Se o Facebook avisa bloqueio, o perfil é pausado por 24 h e só uma pessoa religa.

## Como a extensão prepara o post

Fluxo semiautomático, sem automação de clique nem leitura interna do Facebook:

1. **Pega o trabalho.** O service worker (MV3) consulta a fila do OfZap a cada minuto e, quando há um post para um perfil, baixa a imagem pela API do OfZap (com o token) e guarda o trabalho. Um de cada vez.
2. **Prepara na página do grupo.** Na aba do grupo (`facebook.com/groups/<id>`), um painel do OfZap mostra o texto pronto e a imagem. A pessoa clica em **Preencher no Facebook** (o texto vai para o campo "Escreva algo…") e **Copiar imagem** (a imagem vai para a área de transferência; cola com Ctrl+V) — ou usa os botões de copiar/baixar como alternativa.
3. **Publica.** A pessoa revisa e clica em **Publicar** no Facebook.
4. **Confirma.** A pessoa copia o link do post (menu "…" do post → Copiar link) e cola no painel. A extensão valida o link e registra a publicação no OfZap (ou marca o erro, ex.: "grupo não deixa postar").

Tipos de post: texto, e texto + imagem (card da oferta ou foto do produto, montados pelo servidor).

## Peças

| Peça                 | Onde                             | O que faz                                                                                                                                      |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Perfil do Facebook   | `facebook_accounts`              | Id e nome do perfil (sem credenciais), último contato da extensão, pausa. A sessão fica no Chrome.                                             |
| Grupo                | `channel` com `type: "fb_group"` | `external_id` (id do grupo no Facebook), nome, membros, perfil ligado (`facebook_account_id`)                                                  |
| Trabalho da extensão | `browser_jobs`                   | `type` (`post`), payload (grupo, texto, imagem), `post_id`, `status` (`queued`/`claimed`/`done`/`failed`/`canceled`), `lease_until`, resultado |
| Fila                 | `post` (o mesmo do WhatsApp)     | No horário, o worker não envia: cria um `browser_job` `post` e o post fica `sending` até a extensão responder                                  |
| Link do post         | `posts.external_url`             | URL do post publicado, para abrir e conferir                                                                                                   |

### API para a extensão

- `POST /v1/facebook/heartbeat` `{ fb_user_id, name? }`: registra o perfil (na primeira vez) e marca a extensão como online. Devolve a pausa, se houver.
- `POST /v1/facebook/groups` `{ fb_user_id, group_id, name, ... }`: adiciona (ou atualiza) um grupo do Facebook como canal `fb_group`.
- `POST /v1/facebook/jobs/claim` `{ fb_user_id }` → próximo trabalho, com prazo de 5 min (`lease_until`). Sem trabalho ou perfil pausado: `204`.
- `GET /v1/facebook/jobs/:id/image`: baixa a imagem do trabalho (a extensão nunca busca direto na loja).
- `POST /v1/facebook/jobs/:id/result` `{ ok, post_url?, pending?, error_kind?, error? }`: grava o resultado e atualiza o post.
- `GET /v1/facebook/accounts` e `POST /v1/facebook/accounts/:id/resume`: painel e religar perfil pausado (só humano).

Token com escopo novo `facebook:execute`, no preset **Extensão do Chrome** (criado em Agentes, como o da extensão de ofertas).

## Limites (padrão, em `limits`)

- Intervalo entre posts do perfil: aleatório entre 3 e 8 min (`facebook.min_gap_minutes`/`max_gap_minutes`), fixo por post.
- Máximo por perfil: 15 por hora (`facebook.per_hour`) e 60 por dia (`facebook.per_day`).
- Por grupo: 1 post a cada 24 h (`facebook.group_interval_hours`) e sem repetir o produto por 7 dias (dedupe do WhatsApp).
- Janela de horário da regra, como no WhatsApp.
- Bloqueio do Facebook (`error_kind: "blocked"`): pausa o perfil por 24 h, cancela os trabalhos na fila (os posts voltam para depois da pausa) e abre o alerta `facebook_blocked`. Só pessoa religa.
- Extensão sem contato há 10 min com posts na fila: alerta `facebook_offline` (o Chrome precisa estar aberto com o Facebook).
- Trabalho pego e sem resposta no prazo: o post pode ter saído, então vira falha (não repete). Trabalho que ninguém pega em 2 h é cancelado.

## Importar grupos

Nesta primeira etapa, o grupo entra pela extensão ao preparar/registrar (`POST /v1/facebook/groups`). A leitura automática de "Seus grupos" fica para a etapa 2, sempre com escolha do usuário (nada entra sozinho), como no WhatsApp.

## Política do grupo

Cada grupo `fb_group` tem uma política de divulgação (`posting_policy`): `allowed` (aceita), `approval` (aceita, admin aprova cada post), `restricted` (aceita com condição; ver `policy_notes`), `forbidden` (não aceita) ou `unknown` (ainda não analisado). **Só `allowed`/`approval`/`restricted` recebem post** — `forbidden` e `unknown` são recusados no agendamento e no envio.

**Detecção.** Na página de um grupo, a pessoa clica em **Analisar este grupo**: a extensão coleta o texto **visível** (regras, descrição e últimos posts) e o servidor classifica (`analyze_facebook_group`). A regra: proibição explícita nas regras ("proibida a divulgação", "sem links", "será removido") vence; senão, vários posts de membros com link de loja indicam que o grupo aceita; senão, condição explícita vira `restricted`, liberação explícita vira `allowed`; sem sinais, `unknown`. Guarda a evidência (os trechos). Nenhuma leitura de API interna do Facebook — só o texto da tela.

**Correção.** Pessoa (`human`) ou agente (`agent`) ajusta com `set_group_posting_policy`; a correção **humana não é trocada** por uma análise posterior. Marcar "grupo não deixa postar" ao confirmar um trabalho pausa o canal.

## MCP

| Tool                                                                     | O que faz                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `list_facebook_accounts`                                                 | Perfis do Facebook: online, pausa, grupos, posts hoje e na fila                                 |
| `set_group_posting_policy`                                               | Corrige se um grupo aceita divulgação (`allowed`/`approval`/`restricted`/`forbidden`/`unknown`) |
| `list_channels` (`type: fb_group`), `schedule_posts`, regras automáticas | Os grupos do Facebook usam as mesmas ferramentas de publicação do WhatsApp                      |

A análise do grupo (`analyze_facebook_group`) é feita pela extensão na página (coleta o texto visível). O agente monta o texto, define a política quando sabe, e agenda; a extensão prepara e o usuário publica.

## Campanha de convite

O post de divulgação é um post comum com **texto livre + imagem**, agendado nos grupos `fb_group` aptos: o texto traz o **link de convite do grupo de WhatsApp** (o `invite_url` do canal `wa_group`, de preferência um convite rastreado para medir quantos entraram) e a imagem é uma arte de convite (upload próprio ou criativo). A fila, os limites e a confirmação são os mesmos. Um atalho de "campanha de convite" (escolher o grupo de WhatsApp e a arte, e disparar nos grupos aptos de uma vez) é a próxima entrega.

## Etapas

1. **Publicar em 1 grupo (semiautomático) ✅** — extensão (service worker + painel no grupo), `browser_jobs`, heartbeat, fila, limites, bloqueio, confirmação pelo link do post. Aceite: post com texto e imagem preparado num grupo, publicado pelo usuário, com o link voltando para a Fila.
2. **Política do grupo ✅** — "Analisar este grupo" na extensão, classificação por regras/descrição/últimos posts, correção por pessoa ou agente, e a trava que impede postar em grupo que não aceita (ou não analisado).
3. **Campanha de convite** — atalho que pega o `invite_url` do grupo de WhatsApp + a arte e agenda o convite nos grupos aptos; convite rastreado para medir entradas.
4. **Descobrir grupos do nicho** — sugerir grupos para o usuário avaliar e entrar (sem adicionar ninguém sem consentimento).
