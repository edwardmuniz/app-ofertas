# 19 — Grupos do Facebook

**Objetivo principal: captação de membros.** Divulgar os grupos de WhatsApp do negócio em grupos do Facebook do nicho de que o usuário participa e que aceitam divulgação — um post pontual (imagem + texto) com o **link de convite do grupo de WhatsApp** informado na extensão.

Para **convites pontuais**, a extensão calibra o formato de uma publicação manual com imagem e texto na sessão do próprio usuário. Depois usa esse formato para enviar os convites escolhidos na extensão. Esse mecanismo usa endpoints internos do Facebook e exige validação real após mudanças no site. Ofertas e cupons não são agendados para grupos do Facebook. A fila, política do grupo e limites são do OfZap.

## Princípios

- **Convite pontual automático, criado pela pessoa.** A pessoa informa na extensão o link do seu grupo de WhatsApp, uma ou mais imagens, textos e grupos de destino. A extensão tenta publicar cada convite usando o modelo calibrado. Se não receber confirmação do post, deixa o trabalho para revisão.
- **Calibração local.** A pessoa publica manualmente uma imagem de teste em um grupo permitido. O script da página observa o formato do upload e da publicação; guarda apenas o modelo necessário no armazenamento local da extensão, por perfil. Tokens de sessão não são persistidos. Na hora do convite, lê os valores da sessão ativa e usa os endpoints internos observados. Não tenta contornar bloqueios ou CAPTCHA. A entrada em grupos continua usando controles visíveis.
- **O servidor decide, a extensão prepara.** Fila, regras, limites, deduplicação, link rastreado, texto e imagem ficam no `core`, como no WhatsApp. A extensão busca o próximo trabalho, prepara o post e devolve o resultado (link do post ou erro).
- **Só grupos que aceitam divulgação.** O usuário importa e mantém apenas grupos que permitem divulgar. Um grupo marcado como "não deixa postar" é pausado e não recebe mais posts (ver [Política do grupo](#política-do-grupo)).
- **Parar ao primeiro sinal de bloqueio.** Se o Facebook avisa bloqueio, o perfil é pausado por 24 h e só uma pessoa religa.

## Como a extensão prepara o post

Fluxo assistido para trabalhos antigos e automático para convites pontuais calibrados:

1. **Pega o trabalho.** O service worker (MV3) consulta a fila do OfZap a cada minuto e, quando há um post para um perfil, baixa a imagem pela API do OfZap (com o token) e guarda o trabalho. Um de cada vez.
2. **Prepara na página do grupo.** Na aba do grupo (`facebook.com/groups/<id>`), um painel do OfZap mostra o texto pronto e a imagem. A pessoa clica em **Preencher no Facebook** (o texto vai para o campo "Escreva algo…") e **Copiar imagem** (a imagem vai para a área de transferência; cola com Ctrl+V) — ou usa os botões de copiar/baixar como alternativa.
3. **Publica.** Para trabalhos assistidos, a pessoa revisa e clica em **Publicar**. Para convites pontuais com `auto_publish`, o script da página envia a imagem e o texto pelo modelo calibrado na sessão ativa do mesmo perfil.
4. **Confirma.** No fluxo assistido, a pessoa cola o link do post. No convite automático, a extensão só registra conclusão ao receber um identificador de post na resposta. Se a resposta for ambígua, deixa para conferência humana e não repete automaticamente.

Tipo de post automático nesta etapa: convite pontual com texto livre, link do grupo de WhatsApp e imagem escolhida na extensão.

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

O grupo entra pela extensão ao preparar/registrar (`POST /v1/facebook/groups`). Na descoberta, a pessoa escolhe os candidatos; a extensão tenta entrar nos selecionados e registra apenas entradas confirmadas. A leitura automática de "Seus grupos" ainda não foi feita.

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

O post de divulgação é um post comum com **texto livre + imagem**, agendado nos grupos `fb_group` aptos. A pessoa cola o link do grupo de WhatsApp na extensão e escolhe as imagens e textos. A extensão distribui variações pelos grupos escolhidos e agenda um convite por grupo. A fila e os limites são os existentes. Buscar o `invite_url` cadastrado e criar um link rastreado automaticamente ficam para outra entrega.

### Experiência da extensão

O popup tem navegação com nomes (**Oferta**, **Descobrir grupos**, **Convite**) e abre a descoberta quando a aba atual é uma busca ou grupo do Facebook. A descoberta mostra a busca, a leitura da aba e a seleção como passos; guarda os resultados e os grupos selecionados localmente para a pessoa avaliar grupos em abas diferentes sem perder a lista. A montagem das buscas funciona localmente se a API estiver indisponível, mas a entrada e o cadastro continuam exigindo a API. O convite guarda link, textos e grupos selecionados como rascunho, mostra a prévia com contagem de imagens, versões e grupos, e informa se o perfil já foi calibrado. A imagem precisa ser escolhida novamente após fechar o popup.

## Etapas

1. **Publicar em 1 grupo (semiautomático) ✅** — extensão (service worker + painel no grupo), `browser_jobs`, heartbeat, fila, limites, bloqueio, confirmação pelo link do post. Aceite: post com texto e imagem preparado num grupo, publicado pelo usuário, com o link voltando para a Fila.
2. **Política do grupo ✅** — "Analisar este grupo" na extensão, classificação por regras/descrição/últimos posts, correção por pessoa ou agente, e a trava que impede postar em grupo que não aceita (ou não analisado).
3. **Campanha de convite** — atalho que pega o `invite_url` do grupo de WhatsApp + a arte e agenda o convite nos grupos aptos; convite rastreado para medir entradas.
4. **Descobrir grupos do nicho 🟨** — a extensão monta buscas por nicho e localidade e lê até 40 links visíveis na aba, sob comando da pessoa. Ela escolhe até 10 grupos por vez; o `core` autoriza e audita cada tentativa com `prepare_facebook_join` / `POST /v1/facebook/joins/prepare` (limite de 10 por perfil em 24 h), e a extensão tenta entrar pela interface visível, um a cada 5 min. Pedidos pendentes, perguntas de entrada e aceite de regras exigem a pessoa na aba. Grupos com entrada confirmada são cadastrados pela API `POST /v1/facebook/groups`; antes de publicar, a política precisa estar allowed/approval/restricted. API `GET /v1/facebook/discover` e tool MCP `discover_facebook_groups` geram as buscas. Sem varredura invisível nem coleta de membros. Validar no Facebook real.

5. **Convite pontual 🟨** — a extensão recebe link do grupo de WhatsApp, uma ou mais imagens e variações de texto separadas por `---`; alterna imagens/textos pelos grupos selecionados e agenda um post por grupo a cada 10 min via `schedule_posts` (`auto_publish: true`, somente texto livre + imagem). Usa os uploads de criativos e a fila existente. O token da extensão precisa `posts:write` e `creatives:write`. A publicação automática exige uma calibração manual por perfil. Convites não estão rastreados automaticamente nesta etapa. Validar o upload e a resposta de publicação no Facebook real.
