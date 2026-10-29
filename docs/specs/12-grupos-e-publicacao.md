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
- Limites padrão: intervalo mínimo entre mensagens por grupo (ex.: 3 min), máximo por hora por grupo, máximo global por número; jitter aleatório.
- Mais de um número: grupos distribuídos entre números; número reserva como admin em todos os grupos.
- Monitor de saúde (`health`) e alerta imediato se o número cair.

## Canais suportados

| Tipo           | Uso                                                                            |
| -------------- | ------------------------------------------------------------------------------ |
| `wa_group`     | Grupo de ofertas (limite ~1024 membros)                                        |
| `wa_community` | Comunidade com grupo de avisos (alcance maior) [VERIFICAR suporte no provedor] |
| `wa_channel`   | Canal do WhatsApp (broadcast, sem limite de seguidores) [VERIFICAR suporte]    |
| `ig_account`   | Ver [13](13-instagram.md)                                                      |
| `telegram`     | Futuro                                                                         |

## Templates de mensagem

Variáveis: `{{titulo}}`, `{{preco}}`, `{{preco_original}}`, `{{desconto}}`, `{{cupom}}`, `{{link}}`, `{{plataforma}}`, `{{selo}}` (ex.: "🔥 MENOR PREÇO 90 DIAS"), `{{parcelamento}}`.
Cada template tem variações para evitar mensagens idênticas em massa. Copy pode ser gerada por IA (serviço no servidor, opcional) ou enviada pronta pelo agente.

## Fila de publicação

- `schedule_posts` cria `post`s; worker `publish` executa no horário.
- Antes de enviar: revalida oferta (ver [10](10-afiliados-e-ofertas.md)) → cria `tracked_link` → renderiza mensagem → envia texto ou mídia+legenda → grava `external_message_id`.
- **Deduplicação**: mesma oferta (produto) não vai ao mesmo canal em < N dias (padrão 7) — erro `DUPLICATE_POST` ou pula, conforme modo.
- **Janelas de horário** por canal/segmento (ex.: 8h–23h) e "horário de silêncio".
- Retentativas com backoff; falha definitiva → `failed` + evento.
- Ações: cancelar post agendado, apagar mensagem enviada.

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

- Importar grupos existentes do número; criar grupo (se provedor permitir); definir segmento, limite, descrição, regras fixadas.
- Métricas diárias: membros, entradas, saídas (via webhooks de participante), mensagens, cliques.
- Alertas: grupo perto do limite, saída anormal após envio (ex.: > 2% em 1h), número desconectado.

## Moderação (fase posterior)

- Mensagem de boas-vindas (privada ou no grupo) com regras.
- Se grupo não for "só admins": apagar links de terceiros, remover spammers após N avisos.

## LGPD

- Armazenar identificadores de membros apenas como **hash** (para métricas/indicação), salvo necessidade explícita.
- Política de privacidade e termos no link de entrada.
- Retenção de eventos de participantes: 12 meses (configurável).

## Critérios de aceite (fase WhatsApp)

- Conectar número via QR, listar/importar grupos, ver saúde.
- Agendar posts com `dry_run`, deduplicação, limites e janelas.
- Enviar texto e imagem com link rastreado; apagar mensagem enviada.
- Regra de automação simples gerando posts de ofertas Shopee.
- Provider `fake` para testes.
