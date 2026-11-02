# 12 — Grupos e publicação

## Provedor de WhatsApp  [DECISÃO D3]

Interface `MessagingProvider` (`packages/connectors/messaging`):

```ts
interface MessagingProvider {
  connect(account): Promise<{ qrCode?: string; status }>;
  health(account): Promise<Health>;
  listGroups(account): Promise<GroupInfo[]>;
  createGroup?(account, name, opts): Promise<GroupInfo>;
  getInviteLink(account, groupId): Promise<string>;
  sendText(account, chatId, text, opts?): Promise<SentMessage>;
  sendImage(account, chatId, media, caption): Promise<SentMessage>;
  sendVideo(account, chatId, media, caption): Promise<SentMessage>;
  deleteMessage(account, chatId, messageId): Promise<void>;
  setGroupSettings?(account, groupId, settings): Promise<void>; // só admins enviam etc.
  removeParticipant?(account, groupId, participant): Promise<void>;
  // eventos de entrada (webhook): join, leave, message
}
```

| Opção                                                          | Prós                                            | Contras                                                            |
| -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| **Evolution Go** (self-hosted, Go + whatsmeow) — **escolhido** | Grupos completos, comunidades, grátis, webhooks | Não oficial → risco de banimento do número                         |
| WhatsApp Cloud API (oficial)                                   | Estável, sem risco de ban por uso da API        | Suporte a grupos limitado/restrito [VERIFICAR]; custo por conversa |
| Provedores pagos (Z-API, etc.)                                 | Gerenciado                                      | Mesmo risco do não oficial + custo                                 |

Decisão: **Evolution Go** atrás do adapter (`packages/connectors/messaging/evolution-go`), com mitigações de risco abaixo.

## Mitigação de risco de banimento

- Número dedicado (chip próprio), aquecido antes de escalar.
- **Grupos configurados como "só admins enviam"**.
- Limites padrão: intervalo mínimo entre mensagens por grupo (piso de 1 min; cada regra escolhe o seu, de 1 a 720 min), máximo por hora por grupo, máximo global por número; jitter aleatório.
- Mais de um número: grupos distribuídos entre números; número reserva como admin em todos os grupos.
- Monitor de saúde (`health`) e alerta imediato se o número cair.

## Canais suportados

| Tipo           | Uso                                                                               |
| -------------- | --------------------------------------------------------------------------------- |
| `wa_group`     | Grupo de ofertas (limite ~1024 membros)                                           |
| `wa_community` | Comunidade com grupo de avisos (alcance maior); a Evolution Go cria e liga grupos |
| `wa_channel`   | Canal do WhatsApp (broadcast, sem limite de seguidores); a Evolution Go suporta   |
| `ig_account`   | Ver [13](13-instagram.md)                                                         |
| `telegram`     | Futuro                                                                            |

## Templates de mensagem

Variáveis: `{{titulo}}`, `{{preco}}`, `{{preco_original}}`, `{{desconto}}`, `{{cupom}}`, `{{link}}`, `{{plataforma}}`, `{{loja}}`, `{{selo}}` (ex.: "🔥 MENOR PREÇO 90 DIAS"), `{{preco_pix}}`, `{{parcelas}}` (ex.: "5x de R$ 30,78 sem juros"), `{{linha_preco}}` e, quando a oferta tem texto próprio, `{{chamada}}`, `{{descricao}}` e `{{extra}}`.
Cada template tem variações para evitar mensagens idênticas em massa. Linha com variável vazia some da mensagem.

### Preço no Pix e parcelamento

Lidos da página da Amazon (preço "no Pix" e "Nx de R$ Y sem juros") e guardados na oferta (`price_details`). São atualizados a cada conferência de preço. O Pix só aparece se for menor que o preço normal. As outras lojas ainda não informam.

### Texto próprio da oferta

Formato de mensagem com chamada, descrição, linha de preço e fechamento:

```
*{{chamada}}*

{{descricao}}

{{linha_preco}}          → De ~R$ 449,90~ por *R$ 395,91 no Pix* ou *12x de R$ 37,51 sem juros*
🎟️ Cupom: *{{cupom}}*

{{extra}}

{{link}}
```

- O texto (chamada, descrição, fechamento) fica na oferta (`offers.copy`, com a origem: `ai`, `agent` ou `human`). Com texto e sem modelo escolhido na publicação, o envio usa esse formato; sem texto, o modelo padrão.
- **Preço, Pix, parcelas, cupom e link nunca fazem parte do texto:** o sistema monta essas linhas na hora do envio, com o preço conferido. Texto com preço (`R$ 10`) ou link é recusado.
- **Humanos (painel):** Ofertas › "Escrever texto" abre o editor com **Gerar com IA** (OpenRouter com `OPENROUTER_API_KEY`, modelo em `OPENROUTER_MODEL`, padrão `deepseek/deepseek-v4.1-flash-1017`, saída em JSON pelo schema; ou Gemini com `GOOGLE_API_KEY`/`GEMINI_MODEL`. Com as duas chaves, usa o OpenRouter). A IA recebe o título, a loja, a categoria, os preços (só como contexto), o tom de voz das Preferências e um pedido opcional. A sugestão vem em `dry_run` (não salva) para revisar e editar antes de salvar. `POST /v1/offers/:id/copy/generate` só aceita usuários.
- **Gerar ao aprovar** (Preferências › Texto das ofertas, `auto_copy`, desligado por padrão): o worker procura a cada 30 s as ofertas aprovadas sem texto e gera com a IA (até 10 por rodada, ator `sistema:auto-copy` no log de auditoria). Vale para aprovação no painel, ofertas que já entram aprovadas e regras automáticas. Nunca substitui texto de pessoa ou agente (grava só se a oferta continuar sem texto). Falha numa oferta: tenta de novo em 15 min; sem créditos ou chave errada: pausa 15 min. Enquanto não há texto, vale o modelo padrão.
- **Agentes (MCP):** não usam a IA da plataforma; escrevem o próprio texto com `set_offer_copy` (ou `PUT /v1/offers/:id/copy`). `copy: null` volta ao modelo padrão.

### Imagem dos envios

Preferências › **Imagem dos envios** (`creative_cards`): "Card com preço" (padrão) ou "Só a foto do produto". Desligado, todo envio com imagem vai com a foto da loja, mesmo em regras e publicações que pediram card; a escolha da regra fica guardada para quando religar.

## Fila de publicação

- `schedule_posts` cria `post`s; worker `publish` executa no horário.
- Antes de enviar: revalida oferta (ver [10](10-afiliados-e-ofertas.md)) → cria `tracked_link` → renderiza mensagem → envia texto ou mídia+legenda → grava `external_message_id`.
- **Deduplicação**: mesma oferta (produto) não vai ao mesmo canal em < N dias (padrão 7) — erro `DUPLICATE_POST` ou pula, conforme modo.
- **Janelas de horário** por canal/segmento (ex.: 8h–23h) e "horário de silêncio".
- Retentativas com backoff; falha definitiva → `failed` + evento.
- Ações: cancelar post agendado, apagar mensagem enviada.
- **Filtro por período** (`list_posts` / `GET /v1/posts` com `from` e `to` em ISO): usa a data do envio ou, se ainda não saiu, a agendada. No painel, a Fila tem o seletor de período com atalhos (Hoje, Ontem, Últimos 7/30 dias, Este mês, Mês passado, Este ano, Ano passado) e dois meses lado a lado.

## Regras de automação

`automation_rule` gera posts sozinha a partir das ofertas coletadas/aprovadas:

```yaml
nome: Tech noturno
filtros:
  { categorias: [eletronicos, informatica], desconto_min: 40, score_min: 70, plataformas: [shopee] }
destino: { segmentos: [tech] }
agenda: { janelas: ["20:00-23:00"], max_por_dia: 12, intervalo_min: 15m }
template: oferta_padrao
criativo: { template: card_preco, formato: wa_image } # opcional
aprovacao: auto | revisar_antes
```

Regras podem ser criadas/editadas por agente (`upsert_automation_rule`) e respeitam limites.

## Gestão de grupos

A plataforma deve cobrir **tudo o que a Evolution Go faz com grupos**, pelo painel, pela API e pelo MCP. Levantamento feito no código-fonte da Evolution Go (`pkg/routes`, `pkg/group`, `pkg/community`) e da whatsmeow em 31/10/2026. Toda ação que altera o grupo passa por `runMutation` (escopo `channels:write`, `dry_run`, idempotência, auditoria) e respeita os limites anti-banimento.

### Já entregue

- **Importação com escolha:** o número costuma estar em grupos pessoais, então nada entra sozinho. `POST /whatsapp/accounts/:id/sync-groups?dry_run=true` (MCP `sync_whatsapp_groups` com `dry_run`) lista todos os grupos do número, marcando os já importados, se o número é admin (`number_is_admin`) e os grupos que ele deixou (`left`). A importação recebe `group_jids` (os escolhidos) e `segment_ids` opcionais, que são somados aos segmentos que o grupo já tem. Sem `group_jids`, só atualiza os já importados (nome, membros, admin).
- **Admin:** a Evolution Go devolve os participantes de cada grupo; comparamos com o JID do número (vindo do webhook de conexão). Em grupo "só admins" em que o número não é admin a publicação falha, e o painel avisa. Se o número não aparece na lista (só LID), `number_is_admin` fica `null`.
- **Remover grupo = arquivar** (`status: "archived"` em `update_channel`/`PATCH /channels/:id`): o grupo continua no WhatsApp, some das listas (`list_channels` só mostra arquivados com `include_archived`), as publicações agendadas para ele são canceladas e o histórico fica. Reimportar sem escolher não traz de volta; escolher de novo na importação, ou "Restaurar", traz.
- **Segmentos:** renomear por `upsert_segment`; apagar por `delete_segment`/`DELETE /segments/:id`, recusado (`CONFLICT`) enquanto alguma regra automática ou link de convite usa o segmento. Os grupos só perdem a etiqueta.
- **Link de convite** (gerado na importação) e **"só admins enviam"** (`set_group_admin_only`).
- **Contagem de membros** por webhook (`GroupInfo` Join/Leave → `channel_stats_daily`).

- **Sem cadastro manual de canais** (removido em 31/10/2026): grupo só entra pela importação, pela criação de grupo ou por "Entrar por link", que trazem membros atualizados e publicam. `update_channel`/`PATCH /channels/:id` editam só status, limite de membros e segmentos. Canais manuais antigos continuam e servem só para convites.

### Gestão completa (Fase 3.1)

| Recurso                             | Evolution Go                                                                                                                                                                                                                                                  | Tool MCP / API                                                                                                                                                              | Regras                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Criar grupo**                     | `POST /group/create` `{ groupName, participants[] }` → `{ jid, name, owner, added[], failed[] }`                                                                                                                                                              | `create_group` / `POST /whatsapp/accounts/:id/groups` `{ name, participants[], description?, photo_url?, segment_ids?, admin_only? = true, locked? = true, member_limit? }` | Nome até **25 caracteres** (o WhatsApp recusa acima). Exige **ao menos 1 participante** além do número (ex.: o telefone pessoal do dono ou o número reserva). Depois de criado, a plataforma aplica em sequência: descrição, foto, "só admins enviam", "só admins editam dados", gera o link de convite e cria o canal no segmento escolhido. Falha num passo posterior não desfaz o grupo: o resultado lista o que ficou pendente.                                                                                                                                                           |
| **Editar nome**                     | `POST /group/name` `{ groupJid, name }`                                                                                                                                                                                                                       | `update_group` `{ channel_id, name?, description?, photo_url? }` / `PATCH /channels/:id/group`                                                                              | Mesmo limite de 25 caracteres. Atualiza o `name` do canal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Editar descrição**                | `POST /group/description` `{ groupJid, description }` (vazio limpa)                                                                                                                                                                                           | `update_group`                                                                                                                                                              | Texto fixo (regras do grupo, link da política de privacidade), sem variáveis de modelo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Trocar foto**                     | `POST /group/photo` `{ groupJid, image }` (URL http(s) ou data URL JPEG/PNG) → id da foto                                                                                                                                                                     | `update_group` com `photo_url`                                                                                                                                              | O WhatsApp só aceita **JPEG** ("the given data is not a valid image" com PNG): a plataforma baixa a imagem (fetcher seguro), recorta em quadrado de 640 px, converte para JPEG e envia como data URL. Aceita JPEG, PNG, GIF e WebP. Remover foto não é exposto.                                                                                                                                                                                                                                                                                                                               |
| **Configurações**                   | `POST /group/settings` `{ groupJid, action }`: `announcement`/`not_announcement` (só admins enviam), `locked`/`unlocked` (só admins editam dados), `approval_on`/`approval_off` (aprovação para entrar), `admin_add`/`all_member_add` (quem adiciona membros) | `update_group_settings` `{ channel_id, admin_only?, locked?, approval_required?, admins_add_members? }` (`set_group_admin_only` vira atalho)                                | Guardar os 4 estados no canal (`admin_only`, `locked`, `approval_required`, `admins_add_members`). Padrão recomendado para grupo de ofertas: só admins enviam, só admins editam, aprovação desligada, só admins adicionam.                                                                                                                                                                                                                                                                                                                                                                    |
| **Novo link de convite**            | `POST /group/invitelink` `{ groupJid, reset: true }`                                                                                                                                                                                                          | `reset_group_invite` `{ channel_id }`                                                                                                                                       | Revoga o link antigo (quem tem o link velho não entra mais). Atualiza `invite_url` do canal; os links de convite inteligentes passam a usar o novo na hora. Útil quando o link vaza para grupos de spam.                                                                                                                                                                                                                                                                                                                                                                                      |
| **Participantes**                   | `POST /group/participant` `{ groupJid, participants[], action }`: `add`, `remove`, `promote`, `demote`                                                                                                                                                        | `manage_group_participants` `{ channel_id, action, phones[] }`                                                                                                              | **`promote`/`demote`**: uso principal é tornar o **número reserva** admin em todos os grupos (mitigação de banimento). **`remove`**: tirar spammer. **`add`**: só para números da equipe (reserva, dono, moderadores), **nunca** para adicionar clientes sem consentimento (spam → banimento, e LGPD); limite padrão de 5 por chamada e 20 por dia por número. A resposta da Evolution Go não diz quem falhou: a plataforma relê os participantes (`POST /group/info`) para confirmar. Telefones de membros não são guardados (ver LGPD); os da equipe ficam numa lista própria do workspace. |
| **Ver detalhes do grupo**           | `POST /group/info` `{ groupJid }` → `GroupInfo` (nome, descrição, dono, configurações, participantes com admin)                                                                                                                                               | `get_group` `{ channel_id }`                                                                                                                                                | Leitura. Devolve configurações e **quem são os admins** (telefones mascarados, exceto os da equipe); não devolve a lista de membros. Também atualiza o canal.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Entrar por link**                 | `POST /group/join` `{ code }` (aceita a URL inteira)                                                                                                                                                                                                          | `join_group` `{ account_id, invite_url, segment_ids? }`                                                                                                                     | Coloca o número num grupo existente (ex.: grupo de um parceiro) e importa o grupo como canal. Se o grupo exige aprovação, a entrada fica pendente e a Evolution Go não avisa: a plataforma confere na próxima importação.                                                                                                                                                                                                                                                                                                                                                                     |
| **Sair do grupo**                   | `POST /group/leave` `{ groupJid }`                                                                                                                                                                                                                            | `leave_group` `{ channel_id }`                                                                                                                                              | Arquiva o canal e cancela os agendamentos. Irreversível pelo número (precisa de novo convite): só humano, com confirmação. Se o número for o único admin, avisar antes (o grupo fica sem quem publique).                                                                                                                                                                                                                                                                                                                                                                                      |
| **Comunidades**                     | `POST /community/create` `{ communityName }`; `POST /community/add` e `/remove` `{ communityJid, groupJid[] }` (ligar/desligar grupos)                                                                                                                        | `create_community`, `link_groups_to_community`, `unlink_groups_from_community`                                                                                              | Canal tipo `wa_community`. O grupo de avisos da comunidade alcança os membros de todos os grupos ligados (útil para ofertas relâmpago). **Bugs conhecidos na Evolution Go:** a lista de sucesso de `/community/add` e `/remove` vem errada, e a validação do corpo espera `communityId` em vez de `communityJid` [VERIFICAR com a instância real]. A plataforma confere o resultado relendo o grupo.                                                                                                                                                                                          |
| **Canais do WhatsApp** (newsletter) | `POST /newsletter/create`, `/info`, `/link`, `/subscribe`, `/messages`; `GET /newsletter/list`                                                                                                                                                                | `create_wa_channel`, importação junto com os grupos                                                                                                                         | Canal tipo `wa_channel` (broadcast sem limite de seguidores). Publicação pelo mesmo `/send/*` com o JID do canal [VERIFICAR]. Entra como fase própria se o uso justificar.                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Webhooks de grupo

- `GroupInfo` (assinatura `GROUP`) traz as mudanças: `Join`, `Leave`, `Promote`, `Demote`, `Name`, `Topic` (descrição), `Announce`, `Locked`, `MembershipApprovalMode`, `NewInviteLink`, `Delete`, `Link`/`Unlink` (comunidade), `Suspended`/`Unsuspended`. A plataforma deve tratar todos:
  - nome, descrição, configurações e link novo alterados pelo celular → atualizam o canal;
  - `Demote` do próprio número → `number_is_admin = false` + alerta (o grupo para de receber publicações);
  - `Delete` ou `Suspended` → canal pausado + alerta; `Unsuspended` → alerta de volta.
- `JoinedGroup` (o número entrou ou criou um grupo) → aparece na próxima importação como "novo"; não vira canal sozinho.
- Casing exato das chaves de `GroupInfo` [VERIFICAR com a instância real]; hoje lemos `Join`/`Leave` com tolerância.

### Fora do alcance da Evolution Go (não prometer no painel)

- **Aprovar ou recusar pedidos de entrada:** a whatsmeow suporta e o serviço da Evolution Go tem o código, mas **nenhuma rota HTTP expõe**. Com aprovação ligada, os pedidos só podem ser aprovados no celular.
- **Ver dados de um grupo pelo link sem entrar** (`GetGroupInfoFromLink`): não exposto.
- **Mensagens temporárias** do grupo e **remover a foto**: não expostos.
- Quando a Evolution Go passar a expor algum desses, entra aqui.

### Permissões

| Ação                                                                         | Humano | Agente (token)                                                 |
| ---------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| Ver detalhes, importar, editar nome/descrição/foto, configurações, segmentos | sim    | sim (MCP `get_group`, `update_group`, `update_group_settings`) |
| Criar grupo, entrar por link, comunidades                                    | sim    | ainda não                                                      |
| Participantes (`add`/`promote`/`demote`/`remove`), novo link de convite      | sim    | ainda não                                                      |
| Sair do grupo, números da equipe                                             | sim    | não (equipe: só leitura, `list_team_contacts`)                 |

As ações marcadas "ainda não" vão para agentes **com aprovação** quando o fluxo de aprovações existir (hoje falta listar e decidir pendências). Até lá ficam só no painel e na API com sessão de usuário; por isso não há tool MCP para elas.

### Painel

- **Grupos:** botão "Criar grupo" (nome, participante obrigatório, segmento, foto, descrição e configurações já marcadas no padrão recomendado). Cada grupo ganha uma página de detalhes com abas: Dados (nome, descrição, foto), Configurações (4 interruptores), Admins (lista, promover o número reserva, rebaixar), Convite (link atual, gerar novo), Comunidade e "Sair do grupo".
- **WhatsApp:** "Entrar em grupo por link" ao lado de "Importar grupos".

### Métricas e alertas

- Métricas diárias: membros, entradas, saídas (via webhooks de participante), mensagens, cliques.
- Alertas: grupo perto do limite, saída anormal após envio (ex.: > 2% em 1h), número desconectado, **número perdeu admin**, **grupo apagado ou suspenso**.

### Implementação (Fase 3.1)

- **Core:** `packages/core/src/groups.ts`. Toda ação passa por `runMutation`; criar, entrar, sair, participantes, novo convite, comunidades e equipe exigem humano (`requireHuman`).
- **API:** `GET/PATCH /channels/:id/group`, `POST /channels/:id/group/settings`, `/group/invite-reset`, `/group/participants`, `/group/leave`, `POST /channels/:id/community/groups`, `POST /whatsapp/accounts/:id/groups` (criar), `/join`, `/communities`, `GET/POST/DELETE /team-contacts`.
- **Números da equipe** (`team_contacts`): únicos telefones aceitos em `add` e como participantes ao criar grupo. Limite `groups.add_per_day` (20 por número, sobrescrevível em `limits`) e no máximo 5 por chamada.
- **Canal ganhou** `description`, `locked`, `approval_required`, `admins_add_members`, `provider_state` (`ok`/`deleted`/`suspended`) e `community_jid`.
- **Telefone → JID real:** antes de criar grupo ou mexer em participantes, os telefones passam por `POST /user/check` (`formatJid: false`, número como `+dígitos`), que devolve o JID real; muitos celulares brasileiros têm JID sem o 9º dígito, e mandar o telefone cru faz a criação travar. Número sem WhatsApp é recusado antes. Comparações de telefone ignoram o 9º dígito. (Aprendido na integração do viachat, que já cria grupos na mesma Evolution Go.)
- **`/group/participant` com `text/plain`:** a validação da rota recusa a lista de participantes quando o corpo vem como `application/json`; o handler lê JSON de qualquer jeito, então o mesmo JSON vai como `text/plain`.
- **Confirmação relendo o grupo:** participantes e comunidades conferem o resultado com `POST /group/info`, porque a resposta da Evolution Go não diz quem falhou.
- **Entrar por link:** a Evolution Go não devolve o grupo; a plataforma compara a lista de grupos antes e depois. Sem grupo novo, o resultado é `pending` (aguarda aprovação ou o número já estava nele).
- **Webhook `GroupInfo`:** nome, descrição, configurações e link novo atualizam o canal; `Demote`/`Promote` do próprio número ajustam `number_is_admin`; `Delete`/`Suspended` pausam o canal. Alertas `group_admin_lost` (grupo "só admins" em que o número perdeu admin) e `group_unavailable` (apagado ou suspenso) abrem e resolvem sozinhos.
- **Publicar no grupo de avisos da comunidade** não entrou: o JID da comunidade não é o do grupo de avisos [VERIFICAR com a instância real].

## Moderação (fase posterior)

- Mensagem de boas-vindas (privada ou no grupo) com regras.
- Se grupo não for "só admins": apagar links de terceiros, remover spammers após N avisos.

## LGPD

- Armazenar identificadores de membros apenas como **hash** (para métricas/indicação), salvo necessidade explícita.
- Política de privacidade e termos no link de entrada.
- Retenção de eventos de participantes: 12 meses (configurável).

## Implementação (Fase 3)

- **Evolution Go:** header `apikey`; chave global só para criar/apagar instâncias, token da instância (cifrado no banco) para o resto. Eventos assinados: `GROUP`, `CONNECTION`, `QRCODE`. Respostas lidas de forma tolerante (a documentação e os exemplos divergem).
- **Remover número:** `DELETE /whatsapp/accounts/:id` (só humano, como conectar/desconectar; por isso não há tool MCP). Desloga, apaga a instância na Evolution Go (se ela já não existir, segue) e o registro. Os grupos ficam como canais sem número ligado e as publicações agendadas para eles são canceladas. Aceita `dry_run`, que mostra quantos grupos ficam e quantos agendamentos caem.
- **Webhook:** `POST /webhooks/whatsapp/evolution_go`. Validado pelo `instanceToken` do corpo (comparação em tempo constante). Configure `MESSAGING_WEBHOOK_URL` com a URL pública base (a plataforma acrescenta `/evolution_go` ao registrar a instância).
- **Fila:** tabela `posts`; o worker reivindica a cada 5 s com `FOR UPDATE SKIP LOCKED` (vários workers não enviam em dobro) e recupera envios travados após 5 min. Pausa de 2 s entre envios da mesma rodada.
- **Limites padrão** (tabela `limits` sobrescreve): intervalo de 1 min no mesmo grupo (piso; o ritmo de cada regra vai de 1 a 720 min), 60 mensagens/hora por número, até 45 s de atraso aleatório.
- **Sem mensagem dobrada:** `send_started_at` é gravado logo antes de chamar o provedor. Se o processo cair com ele preenchido, ou se o provedor estourar o tempo (`TIMEOUT`), o post vira `failed` ("pode ter saído") em vez de reenviar. Erros antes do envio continuam com retentativa, reaproveitando o mesmo link rastreado do post.
- **Envio de oferta:** revalida preço/estoque; se inválida, o post vira `skipped`. Gera link rastreado por post (`source=wa`, canal, post) e envia a foto do produto com a legenda (ou texto, se `with_image=false`).
- **Regras:** a cada minuto, dentro das janelas, agendam no máximo 1 oferta pendente por grupo, respeitando `max_per_day` e `min_interval_minutes`.
- **LGPD:** só contagens de entradas/saídas são guardadas (`channel_stats_daily`), nunca os números dos membros.

## Critérios de aceite (fase WhatsApp)

- Conectar número via QR, listar/importar grupos, ver saúde.
- Agendar posts com `dry_run`, deduplicação, limites e janelas.
- Enviar texto e imagem com link rastreado; apagar mensagem enviada.
- Regra de automação simples gerando posts de ofertas Shopee.
- Provider `fake` para testes.
