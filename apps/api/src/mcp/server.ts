import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AuditQuery,
  CompleteUploadInput,
  CreateInviteLinkInput,
  CreateOfferLinkInput,
  CreateTrackedLinkInput,
  FindSimilarInput,
  GenerateCreativeInput,
  ImportMediaInput,
  ImportOfferFromLinkInput,
  LinkStatsQuery,
  ListAlertsQuery,
  ListChannelsQuery,
  ListCreativesQuery,
  ListOffersQuery,
  ListPostsQuery,
  ListTrackedLinksQuery,
  MetricsBreakdownQuery,
  MetricsPeriodQuery,
  MutationOptions,
  OfferFromLinkInput,
  Preferences,
  PreviewPostInput,
  RequestUploadInput,
  SaveOfferInput,
  SchedulePostsInput,
  SearchOffersInput,
  SeasonalCalendarQuery,
  SetOfferCopyInput,
  SyncGroupsInput,
  UpdateBrandKitInput,
  UpdateChannelInput,
  UpdateGroupInput,
  UpdateGroupSettingsInput,
  UpdateInviteLinkInput,
  UpdateOfferStatusInput,
  UpdateTrackedLinkInput,
  UpsertAutomationRuleInput,
  UpsertMessageTemplateInput,
  UpsertSavedSearchInput,
  UpsertSegmentInput,
  ValidateCreativeInput,
} from "@ofertas/contracts";
import {
  type MutationOptions as CoreMutationOptions,
  type Ctx,
  cancelPost,
  completeUpload,
  createInviteLink,
  createOfferLink,
  createTrackedLink,
  deleteCreative,
  deleteSegment,
  deleteSentPost,
  findSimilarOffers,
  generateCreative,
  getBrandKit,
  getCreative,
  getFunnel,
  getGroup,
  getLinkStats,
  getMetricsBreakdown,
  getOffer,
  getOverview,
  getPerformanceSummary,
  getPreferences,
  getSeasonalCalendar,
  getSystemStatus,
  importMediaFromUrl,
  importOfferFromLink,
  isAppError,
  listAffiliateAccounts,
  listAlerts,
  listAudit,
  listAutomationRules,
  listChannels,
  listCreatives,
  listCreativeTemplates,
  listInviteLinks,
  listMessageTemplates,
  listMessagingAccounts,
  listOfferCategories,
  listOffers,
  listPosts,
  listSavedSearches,
  listSegments,
  listTeamContacts,
  listTrackedLinks,
  previewOfferFromLink,
  previewPost,
  requestFeedSync,
  requestUpload,
  saveOffer,
  schedulePosts,
  searchOffers,
  setChannelAdminOnly,
  setOfferCopy,
  setOfferStatus,
  syncGroups,
  updateBrandKit,
  updateChannel,
  updateGroup,
  updateGroupSettings,
  updateInviteLink,
  updatePreferences,
  updateTrackedLink,
  upsertAutomationRule,
  upsertMessageTemplate,
  upsertSavedSearch,
  upsertSegment,
  validateCreative,
  validateOffer,
} from "@ofertas/core";
import { z } from "zod";
import { INSTRUCTIONS } from "./instructions";

export const MCP_SERVER_NAME = "ofertas";
export const MCP_SERVER_VERSION = "0.1.0";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const body = isAppError(err)
    ? err.toJSON()
    : { error: { code: "INTERNAL_ERROR", message: "Erro interno ao executar a ferramenta." } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

/** Envolve o handler: converte AppError no JSON padrão com isError. */
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (!isAppError(err)) console.error(err);
      return fail(err);
    }
  };
}

/** Separa dry_run / idempotency_key / reason dos demais argumentos. */
function splitOpts<T extends MutationOptions>(args: T) {
  const { dry_run, idempotency_key, reason, ...rest } = args;
  const opts: CoreMutationOptions = { dryRun: dry_run, idempotencyKey: idempotency_key, reason };
  return [rest, opts] as const;
}

const READ = { readOnlyHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

/** Um servidor MCP por requisição, já com o ator autenticado. */
export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "get_workspace_overview",
    {
      title: "Visão geral do workspace",
      description:
        "Resumo do workspace: contadores, aprovações pendentes, alertas e quais módulos da plataforma já estão disponíveis. Chame primeiro para se situar.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => getOverview(ctx)),
  );

  server.registerTool(
    "get_preferences",
    {
      title: "Ler preferências do negócio",
      description:
        "Tom de voz, nichos, janelas de envio, proibições e notas do workspace. Siga essas preferências em tudo que produzir.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => getPreferences(ctx)),
  );

  server.registerTool(
    "update_preferences",
    {
      title: "Atualizar preferências do negócio",
      description:
        "Atualização parcial: só os campos enviados mudam. Use dry_run=true para ver o antes/depois sem salvar.",
      inputSchema: { ...Preferences.shape, ...MutationOptions.shape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async ({ dry_run, idempotency_key, reason, ...patch }) =>
      updatePreferences(ctx, patch, {
        dryRun: dry_run,
        idempotencyKey: idempotency_key,
        reason,
      }),
    ),
  );

  server.registerTool(
    "get_audit_log",
    {
      title: "Log de auditoria",
      description:
        "Últimas ações feitas no workspace (por humanos, agentes e sistema), da mais recente para a mais antiga. Paginação por cursor.",
      inputSchema: AuditQuery.shape,
      annotations: { readOnlyHint: true },
    },
    safe(async (args) => listAudit(ctx, args)),
  );

  server.registerResource(
    "preferences",
    "workspace://preferences",
    {
      title: "Preferências do negócio",
      description: "Mesmo conteúdo de get_preferences.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await getPreferences(ctx), null, 2),
        },
      ],
    }),
  );

  // ── Canais e segmentos ─────────────────────────────────────────
  server.registerTool(
    "list_channels",
    {
      title: "Listar canais",
      description:
        "Grupos e canais com membros, limite, link de convite, segmentos e se o número é admin (number_is_admin). Arquivados (removidos) só com include_archived.",
      inputSchema: ListChannelsQuery.shape,
      annotations: READ,
    },
    safe(async (args) => listChannels(ctx, args)),
  );

  server.registerTool(
    "update_channel",
    {
      title: "Editar canal",
      description:
        "Muda status ('paused' para de publicar; 'archived' remove o grupo da plataforma e cancela os agendamentos dele; 'active' volta), limite de membros (usado pelos links de convite) e segmentos (segment_ids substitui a lista). Grupos entram pela importação (sync_whatsapp_groups); não há cadastro manual.",
      inputSchema: { channel_id: z.uuid(), ...UpdateChannelInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => {
      const [{ channel_id, ...rest }, opts] = splitOpts(args);
      return updateChannel(ctx, channel_id, rest, opts);
    }),
  );

  server.registerTool(
    "list_segments",
    {
      title: "Listar segmentos (nichos)",
      description: "Nichos que agrupam canais, ex.: casa, tech. Inclui quantos canais cada um tem.",
      annotations: READ,
    },
    safe(async () => listSegments(ctx)),
  );

  server.registerTool(
    "upsert_segment",
    {
      title: "Criar ou editar segmento",
      description: "Sem id cria (name obrigatório); com id edita.",
      inputSchema: { ...UpsertSegmentInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => upsertSegment(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "delete_segment",
    {
      title: "Apagar segmento",
      description:
        "Apaga o segmento; os canais continuam, só perdem a etiqueta. Recusa (CONFLICT) se alguma regra automática ou link de convite usa o segmento.",
      inputSchema: { segment_id: z.uuid(), ...MutationOptions.shape },
      annotations: { ...WRITE, destructiveHint: true },
    },
    safe(async (args) => {
      const [rest, opts] = splitOpts(args);
      return deleteSegment(ctx, rest.segment_id, opts);
    }),
  );

  // ── Links rastreados ───────────────────────────────────────────
  server.registerTool(
    "create_tracked_link",
    {
      title: "Criar link rastreado",
      description:
        "Cria um link curto próprio que redireciona para destination_url e conta os cliques. Use source (wa, ig, bio, story, ads) e campaign para medir depois. Todo link divulgado deve passar por aqui.",
      inputSchema: { ...CreateTrackedLinkInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => createTrackedLink(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "update_tracked_link",
    {
      title: "Editar link rastreado",
      description:
        "Troca o destino sem mudar o link curto (ex.: oferta expirou → substituta), desativa (active=false manda para o fallback) ou muda a validade.",
      inputSchema: { ...UpdateTrackedLinkInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => updateTrackedLink(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "list_tracked_links",
    {
      title: "Listar links rastreados",
      description:
        "Links do workspace, mais recentes primeiro. Filtros por canal, campanha, origem, status e busca.",
      inputSchema: ListTrackedLinksQuery.shape,
      annotations: READ,
    },
    safe(async (args) => listTrackedLinks(ctx, args)),
  );

  server.registerTool(
    "get_link_stats",
    {
      title: "Estatísticas de cliques",
      description:
        "Cliques humanos, pessoas únicas e acessos de robôs (prévias do WhatsApp etc., não contam como clique). Agrupe por day, link, invite, channel ou source. Padrão: últimos 7 dias por dia.",
      inputSchema: LinkStatsQuery.shape,
      annotations: READ,
    },
    safe(async (args) => getLinkStats(ctx, args)),
  );

  // ── Convites rotativos ─────────────────────────────────────────
  server.registerTool(
    "create_invite_link",
    {
      title: "Criar convite rotativo",
      description:
        "Cria um link fixo de entrada (/entrar/<slug>) que manda cada pessoa para um grupo do segmento com vaga. Use na bio, anúncios e stories no lugar do link direto do grupo.",
      inputSchema: { ...CreateInviteLinkInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => createInviteLink(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "update_invite_link",
    {
      title: "Editar convite rotativo",
      description:
        "Muda nome, estratégia, reserva de vagas, fallback ou pausa o convite (active=false).",
      inputSchema: { ...UpdateInviteLinkInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => updateInviteLink(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "list_invite_links",
    {
      title: "Listar convites rotativos",
      description:
        "Convites com capacidade atual: grupos com vaga, vagas livres e qual grupo recebe o próximo membro. channels=0 significa que todos lotaram.",
      annotations: READ,
    },
    safe(async () => listInviteLinks(ctx)),
  );

  // ── Afiliados e ofertas ────────────────────────────────────────
  server.registerTool(
    "list_affiliate_accounts",
    {
      title: "Contas de afiliado",
      description:
        "Contas conectadas (Shopee etc.): modo real (API), feed (catálogo do feed de produtos, importado todo dia, só itens com desconto) ou simulado; status e o que cada uma suporta. Conectar contas é feito só pelo humano no painel.",
      annotations: READ,
    },
    safe(async () => listAffiliateAccounts(ctx)),
  );

  server.registerTool(
    "refresh_affiliate_feed",
    {
      title: "Atualizar feed de produtos",
      description:
        "Pede nova importação do feed de produtos de uma conta em modo feed. O worker importa em até 1 minuto; a importação pode levar alguns minutos.",
      inputSchema: { account_id: z.uuid(), ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => {
      const [rest, opts] = splitOpts(args);
      return requestFeedSync(ctx, rest.account_id, opts);
    }),
  );

  server.registerTool(
    "list_offer_categories",
    {
      title: "Categorias de ofertas",
      description:
        "Categorias disponíveis para filtrar search_offers (category_id), com quantos produtos em desconto há em cada uma.",
      annotations: READ,
    },
    safe(async () => listOfferCategories(ctx)),
  );

  server.registerTool(
    "search_offers",
    {
      title: "Buscar ofertas",
      description:
        "Busca produtos nas plataformas conectadas e devolve com nota 0–100 (desconto real, comissão, avaliação, vendas, nicho) e sinais de qualidade (fake_discount, lowest_30d, low_rating...). Não salva nada na curadoria: use save_offer para isso.",
      inputSchema: SearchOffersInput.shape,
      annotations: READ,
    },
    safe(async (args) => searchOffers(ctx, args)),
  );

  server.registerTool(
    "save_offer",
    {
      title: "Salvar oferta",
      description:
        "Salva um produto (product_id de search_offers) como oferta aprovada, ou status=new para revisão humana. Consulta o preço atual antes e recusa produto sem estoque.",
      inputSchema: { ...SaveOfferInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => saveOffer(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "set_offer_copy",
    {
      title: "Escrever texto da oferta",
      description:
        'Escreva você mesmo o texto da mensagem da oferta: headline (chamada curta de impacto, pode ter 1 emoji), body (1-2 frases sobre o produto) e extra (fechamento com urgência ou dica). Não coloque preço, parcelas, cupom nem link: o sistema monta a linha "De ~R$ X~ por *R$ Y no Pix* ou *Nx sem juros*" e o link na hora do envio. Use o tom de voz de get_preferences. copy=null volta ao modelo padrão. Veja o resultado com preview_post.',
      inputSchema: {
        offer_id: z.uuid(),
        ...SetOfferCopyInput.shape,
        ...MutationOptions.shape,
      },
      annotations: WRITE,
    },
    safe(async ({ offer_id, ...args }) => setOfferCopy(ctx, offer_id, ...splitOpts(args))),
  );

  server.registerTool(
    "preview_offer_from_link",
    {
      title: "Ler link de produto",
      description:
        "Abre um link de produto (Shopee, Mercado Livre, Amazon, Magalu; aceita link curto de afiliado) e devolve título, foto e preço encontrados, e o que falta (missing). Não grava nada. Use antes de import_offer_from_link.",
      inputSchema: OfferFromLinkInput.shape,
      annotations: READ,
    },
    safe(async (args) => previewOfferFromLink(ctx, args)),
  );

  server.registerTool(
    "import_offer_from_link",
    {
      title: "Criar oferta por link",
      description:
        "Cria uma oferta a partir de um link colado, com título, foto, preço e, se houver, preço De, Pix e parcelas (confira com preview_offer_from_link; o que faltar, pegue da página que você viu ou pergunte ao usuário; não invente preço). O link vira o destino dos links curtos. Sem conta real da loja, o preço não é revalidado antes do envio.",
      inputSchema: { ...ImportOfferFromLinkInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => importOfferFromLink(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "approve_offer",
    {
      title: "Aprovar oferta",
      description: "Aprova uma oferta da curadoria (status new) para publicação.",
      inputSchema: { offer_id: UpdateOfferStatusInput.shape.offer_id, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => {
      const [rest, opts] = splitOpts(args);
      return setOfferStatus(ctx, { offer_id: rest.offer_id, status: "approved" }, opts);
    }),
  );

  server.registerTool(
    "reject_offer",
    {
      title: "Rejeitar oferta",
      description:
        "Rejeita uma oferta com motivo. Produtos rejeitados não voltam pela busca automática.",
      inputSchema: {
        offer_id: UpdateOfferStatusInput.shape.offer_id,
        reason: UpdateOfferStatusInput.shape.reason,
        dry_run: MutationOptions.shape.dry_run,
        idempotency_key: MutationOptions.shape.idempotency_key,
      },
      annotations: WRITE,
    },
    safe(async (args) =>
      setOfferStatus(
        ctx,
        { offer_id: args.offer_id, status: "rejected", reason: args.reason },
        { dryRun: args.dry_run, idempotencyKey: args.idempotency_key, reason: args.reason },
      ),
    ),
  );

  server.registerTool(
    "list_offers",
    {
      title: "Listar ofertas",
      description:
        "Ofertas da curadoria por status (new = aguardando revisão, approved, rejected, expired), nota mínima e busca.",
      inputSchema: ListOffersQuery.shape,
      annotations: READ,
    },
    safe(async (args) => listOffers(ctx, args)),
  );

  server.registerTool(
    "get_offer",
    {
      title: "Detalhe da oferta",
      description:
        "Oferta com histórico de preço (mín./mediana 30 dias, mín. 90 dias, série diária) e últimas validações.",
      inputSchema: { offer_id: z.uuid() },
      annotations: READ,
    },
    safe(async ({ offer_id }) => getOffer(ctx, offer_id)),
  );

  server.registerTool(
    "validate_offer",
    {
      title: "Validar oferta agora",
      description:
        "Confere preço, estoque e prazo na plataforma. Se o preço subiu mais de 5% ou acabou o estoque, a oferta vira expired. Rode antes de divulgar.",
      inputSchema: { offer_id: z.uuid(), ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => {
      const [rest, opts] = splitOpts(args);
      return validateOffer(ctx, rest.offer_id, opts);
    }),
  );

  server.registerTool(
    "find_similar_offers",
    {
      title: "Ofertas parecidas",
      description:
        "Alternativas para uma oferta expirada ou fraca: mesma categoria, preço na faixa de 50% a 150%, ordenadas pela nota.",
      inputSchema: FindSimilarInput.shape,
      annotations: READ,
    },
    safe(async (args) => findSimilarOffers(ctx, args)),
  );

  server.registerTool(
    "create_offer_link",
    {
      title: "Gerar link da oferta",
      description:
        "Gera o link de afiliado com sub-ids e o envolve num link curto rastreado. Use um link por lugar de divulgação (source: wa, ig, story, bio, ads; channel_id para o grupo). Publique o share_url: é o link curto, exceto na Amazon, que proíbe encurtador (vai o link de afiliado direto).",
      inputSchema: { ...CreateOfferLinkInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => createOfferLink(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "list_saved_searches",
    {
      title: "Buscas salvas",
      description:
        "Buscas que rodam sozinhas no servidor e colocam ofertas boas na curadoria (status new). Mostra o resultado da última execução.",
      annotations: READ,
    },
    safe(async () => listSavedSearches(ctx)),
  );

  server.registerTool(
    "upsert_saved_search",
    {
      title: "Criar ou editar busca salva",
      description:
        "Sem id cria (name e query obrigatórios). query aceita os mesmos filtros de search_offers. Ofertas com nota >= min_score entram na curadoria a cada interval_minutes.",
      inputSchema: { ...UpsertSavedSearchInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => upsertSavedSearch(ctx, ...splitOpts(args))),
  );

  // ── WhatsApp e publicação ──────────────────────────────────────
  server.registerTool(
    "list_whatsapp_accounts",
    {
      title: "Números de WhatsApp",
      description:
        "Números conectados à plataforma, status (connected, disconnected, logged_out) e quantos grupos cada um tem. Conectar, desconectar e remover número é feito pelo humano no painel (QR ou código).",
      annotations: READ,
    },
    safe(async () => listMessagingAccounts(ctx)),
  );

  server.registerTool(
    "sync_whatsapp_groups",
    {
      title: "Importar grupos do número",
      description:
        "Importa grupos do número como canais. Rode primeiro com dry_run=true: a prévia lista todos os grupos do número (groups, com channel_id se já importado e number_is_admin) e os que ele deixou (left). Depois envie group_jids com os grupos escolhidos (e segment_ids opcionais). Sem group_jids só atualiza os já importados. Não importe grupos pessoais: pergunte ao humano quais usar.",
      inputSchema: { account_id: z.uuid(), ...SyncGroupsInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => {
      const [{ account_id, ...rest }, opts] = splitOpts(args);
      return syncGroups(ctx, account_id, rest, opts);
    }),
  );

  server.registerTool(
    "set_group_admin_only",
    {
      title: "Só admins enviam",
      description:
        "Liga/desliga 'só administradores enviam mensagens' no grupo. Recomendado ligado em grupos de ofertas (reduz spam e risco de banimento).",
      inputSchema: { channel_id: z.uuid(), admin_only: z.boolean(), ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => {
      const [rest, opts] = splitOpts(args);
      return setChannelAdminOnly(ctx, rest.channel_id, rest.admin_only, opts);
    }),
  );

  server.registerTool(
    "get_group",
    {
      title: "Detalhes do grupo",
      description:
        "Lê o grupo no WhatsApp na hora: nome, descrição, as 4 configurações, admins (telefones de fora da equipe mascarados), números da equipe no grupo e comunidade. Também atualiza o canal.",
      inputSchema: { channel_id: z.uuid() },
      annotations: READ,
    },
    safe(async (args) => getGroup(ctx, args.channel_id)),
  );

  server.registerTool(
    "update_group",
    {
      title: "Editar grupo",
      description:
        "Muda nome (até 25 caracteres), descrição (vazio limpa) e/ou foto (URL pública de imagem; a plataforma converte para JPEG) do grupo no WhatsApp.",
      inputSchema: { channel_id: z.uuid(), ...UpdateGroupInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => {
      const [{ channel_id, ...rest }, opts] = splitOpts(args);
      return updateGroup(ctx, channel_id, rest, opts);
    }),
  );

  server.registerTool(
    "update_group_settings",
    {
      title: "Configurações do grupo",
      description:
        "Liga/desliga: admin_only (só admins enviam), locked (só admins editam dados), approval_required (entrada com aprovação), admins_add_members (só admins adicionam). Recomendado para ofertas: true, true, false, true. O número precisa ser admin.",
      inputSchema: {
        channel_id: z.uuid(),
        ...UpdateGroupSettingsInput.shape,
        ...MutationOptions.shape,
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const [{ channel_id, ...rest }, opts] = splitOpts(args);
      return updateGroupSettings(ctx, channel_id, rest, opts);
    }),
  );

  server.registerTool(
    "list_team_contacts",
    {
      title: "Números da equipe",
      description:
        "Telefones da equipe (dono, número reserva, moderadores). Só eles podem ser adicionados a grupos. Criar grupo, entrar/sair, participantes, novo link de convite e comunidades são feitos pelo humano no painel.",
      annotations: READ,
    },
    safe(async () => listTeamContacts(ctx)),
  );

  server.registerTool(
    "list_message_templates",
    {
      title: "Modelos de mensagem",
      description: "Modelos do workspace e o modelo embutido padrão, com as variáveis disponíveis.",
      annotations: READ,
    },
    safe(async () => listMessageTemplates(ctx)),
  );

  server.registerTool(
    "upsert_message_template",
    {
      title: "Criar ou editar modelo de mensagem",
      description:
        "Modelo do texto das ofertas. Use variações separadas por --- para não repetir a mesma mensagem. A prévia (dry_run) mostra um exemplo renderizado.",
      inputSchema: { ...UpsertMessageTemplateInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => upsertMessageTemplate(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "preview_post",
    {
      title: "Prévia da mensagem",
      description: "Mostra o texto exato (e a imagem) que uma oferta vai gerar, sem enviar nada.",
      inputSchema: PreviewPostInput.shape,
      annotations: READ,
    },
    safe(async (args) => previewPost(ctx, args)),
  );

  server.registerTool(
    "schedule_posts",
    {
      title: "Agendar publicações",
      description:
        "Agenda ofertas aprovadas (ou um texto) em grupos ou segmentos. A plataforma respeita janelas de envio, intervalo entre posts e não repete o mesmo produto no mesmo grupo por 7 dias. Na hora do envio a oferta é revalidada e o link rastreado é gerado. Rode antes com dry_run=true.",
      inputSchema: { ...SchedulePostsInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => schedulePosts(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "list_posts",
    {
      title: "Fila e histórico de publicações",
      description:
        "Publicações por status: scheduled (na fila), sent, failed, skipped (oferta inválida no envio), canceled, deleted.",
      inputSchema: ListPostsQuery.shape,
      annotations: READ,
    },
    safe(async (args) => listPosts(ctx, args)),
  );

  server.registerTool(
    "cancel_post",
    {
      title: "Cancelar publicação agendada",
      description: "Tira da fila uma publicação que ainda não foi enviada.",
      inputSchema: { post_id: z.uuid(), ...MutationOptions.shape },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async (args) => {
      const [rest, opts] = splitOpts(args);
      return cancelPost(ctx, rest.post_id, opts);
    }),
  );

  server.registerTool(
    "delete_sent_post",
    {
      title: "Apagar mensagem enviada",
      description: "Apaga para todos, no grupo, uma mensagem já enviada (ex.: oferta acabou).",
      inputSchema: { post_id: z.uuid(), ...MutationOptions.shape },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async (args) => {
      const [rest, opts] = splitOpts(args);
      return deleteSentPost(ctx, rest.post_id, opts);
    }),
  );

  server.registerTool(
    "list_automation_rules",
    {
      title: "Regras de publicação automática",
      description: "Regras que publicam sozinhas as ofertas aprovadas nos grupos.",
      annotations: READ,
    },
    safe(async () => listAutomationRules(ctx)),
  );

  server.registerTool(
    "upsert_automation_rule",
    {
      title: "Criar ou editar regra automática",
      description:
        "A cada minuto, dentro das janelas, a regra agenda a melhor oferta aprovada (filtros: nota, desconto, palavras-chave, plataforma) em cada grupo dos segmentos, até max_per_day por grupo e com intervalo mínimo entre posts.",
      inputSchema: { ...UpsertAutomationRuleInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => upsertAutomationRule(ctx, ...splitOpts(args))),
  );

  // ── Criativos ──────────────────────────────────────────────────
  server.registerTool(
    "get_brand_kit",
    {
      title: "Identidade visual",
      description:
        "Nome, cores e chamada usados nos criativos. Siga estas cores também nas imagens que você criar fora da plataforma.",
      annotations: READ,
    },
    safe(async () => getBrandKit(ctx)),
  );

  server.registerTool(
    "update_brand_kit",
    {
      title: "Atualizar identidade visual",
      description: "Atualização parcial do nome, cores (hexadecimal) e chamada dos criativos.",
      inputSchema: { ...UpdateBrandKitInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => updateBrandKit(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "list_creative_templates",
    {
      title: "Templates de criativo",
      description:
        "Templates de imagem disponíveis, formatos (1:1, 4:5, 9:16) e parâmetros aceitos.",
      annotations: READ,
    },
    safe(async () => listCreativeTemplates()),
  );

  server.registerTool(
    "generate_creative",
    {
      title: "Gerar criativo da oferta",
      description:
        "Gera o card da oferta (foto, preço de/por, desconto, cupom, selo) nos formatos pedidos. Devolve preview_url de cada formato: abra para conferir e ajuste headline/cta/accent_color se precisar.",
      inputSchema: { ...GenerateCreativeInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => generateCreative(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "request_upload",
    {
      title: "Pedir link de upload",
      description:
        "Para subir uma imagem que você criou: devolve put_url (válida por 15 min) e um comando curl pronto. Envie o arquivo com PUT e depois chame complete_upload.",
      inputSchema: { ...RequestUploadInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => requestUpload(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "complete_upload",
    {
      title: "Concluir upload",
      description:
        "Depois do PUT, transforma o arquivo em criativo (opcionalmente ligado a uma oferta) e devolve a validação do formato. Marque ai_generated=true se a imagem foi feita por IA.",
      inputSchema: { ...CompleteUploadInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => completeUpload(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "import_media_from_url",
    {
      title: "Importar imagem por URL",
      description:
        "Baixa uma imagem pública (PNG, JPEG ou WebP, até 10 MB) e cria um criativo com ela.",
      inputSchema: { ...ImportMediaInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => importMediaFromUrl(ctx, ...splitOpts(args))),
  );

  server.registerTool(
    "list_creatives",
    {
      title: "Biblioteca de criativos",
      description: "Criativos do workspace (por oferta e origem), com URLs das imagens e prévias.",
      inputSchema: ListCreativesQuery.shape,
      annotations: READ,
    },
    safe(async (args) => listCreatives(ctx, args)),
  );

  server.registerTool(
    "get_creative",
    {
      title: "Detalhe do criativo",
      description: "Variantes por formato, URLs e problemas de validação.",
      inputSchema: { creative_id: z.uuid() },
      annotations: READ,
    },
    safe(async ({ creative_id }) => getCreative(ctx, creative_id)),
  );

  server.registerTool(
    "delete_creative",
    {
      title: "Remover criativo",
      description:
        "Remove um criativo e seus arquivos. Posts agendados com ele passam a gerar o card na hora.",
      inputSchema: { creative_id: z.uuid(), ...MutationOptions.shape },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async (args) => {
      const [rest, opts] = splitOpts(args);
      return deleteCreative(ctx, rest.creative_id, opts);
    }),
  );

  server.registerTool(
    "validate_creative",
    {
      title: "Validar criativo para um formato",
      description:
        "Confere proporção, resolução, tipo e tamanho para wa_image, feed_4x5 ou story_9x16.",
      inputSchema: ValidateCreativeInput.shape,
      annotations: READ,
    },
    safe(async (args) => validateCreative(ctx, args)),
  );

  // ── Métricas, alertas e calendário (Fase 5) ────────────────────
  server.registerTool(
    "get_performance_summary",
    {
      title: "Resumo de desempenho",
      description:
        "Membros, entradas/saídas, envios, cliques (humanos e robôs), top grupos e ofertas, melhores horários, alertas e insights do período, com comparação ao período anterior. Comissões ainda não (módulo Financeiro).",
      inputSchema: MetricsPeriodQuery.shape,
      annotations: READ,
    },
    safe(async (args) => getPerformanceSummary(ctx, args)),
  );

  server.registerTool(
    "get_funnel",
    {
      title: "Funil",
      description:
        "Cliques no convite → entradas → ficaram → cliques em ofertas (pedidos virão no Financeiro), com taxas, referência e a etapa gargalo com dica de ação.",
      inputSchema: MetricsPeriodQuery.shape,
      annotations: READ,
    },
    safe(async (args) => getFunnel(ctx, args)),
  );

  server.registerTool(
    "get_metrics_breakdown",
    {
      title: "Métricas detalhadas",
      description:
        "view=channels: por grupo (membros, saídas, cliques por envio, cliques por 100 membros). view=offers: por oferta. view=hours: cliques por envio por dia da semana × hora (para escolher horários).",
      inputSchema: MetricsBreakdownQuery.shape,
      annotations: READ,
    },
    safe(async (args) => getMetricsBreakdown(ctx, args)),
  );

  server.registerTool(
    "get_system_status",
    {
      title: "Saúde da operação",
      description:
        "Worker rodando?, fila de envio (agendados, atrasados, falhas na última hora), status dos números de WhatsApp e alertas abertos.",
      annotations: READ,
    },
    safe(async () => getSystemStatus(ctx)),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "Alertas",
      description:
        "Alertas operacionais (número caiu, fila parada, envios falhando). Abrem e se resolvem sozinhos conforme o estado.",
      inputSchema: ListAlertsQuery.shape,
      annotations: READ,
    },
    safe(async (args) => listAlerts(ctx, args)),
  );

  server.registerTool(
    "get_seasonal_calendar",
    {
      title: "Calendário sazonal",
      description:
        "Próximas datas do varejo (Black Friday, 11.11, Natal, Dia das Mães...) com dias até a data, quando começar a preparar, categorias foco e checklist.",
      inputSchema: SeasonalCalendarQuery.shape,
      annotations: READ,
    },
    safe(async (args) => getSeasonalCalendar(ctx, args)),
  );

  server.registerPrompt(
    "planejar_campanha_sazonal",
    {
      title: "Planejar campanha sazonal",
      description:
        "Roteiro para o agente montar o plano de uma data sazonal (ex.: Black Friday) com base nos dados do workspace.",
      argsSchema: {
        evento: z
          .string()
          .optional()
          .describe("Chave ou nome da data (ex.: black_friday). Vazio = a próxima importante."),
        objetivo: z
          .string()
          .optional()
          .describe("Meta do negócio, ex.: dobrar cliques ou chegar a 5 mil membros."),
      },
    },
    ({ evento, objetivo }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: seasonalPrompt(evento, objetivo),
          },
        },
      ],
    }),
  );

  return server;
}

function seasonalPrompt(evento?: string, objetivo?: string) {
  return `Monte um plano de campanha para ${evento ? `a data "${evento}"` : "a próxima data sazonal importante"}${objetivo ? ` com o objetivo: ${objetivo}` : ""}.

Passos:
1. get_seasonal_calendar: ache a data, os dias que faltam, as categorias foco e o checklist.
2. get_preferences: respeite nichos, tom de voz, janelas de envio e proibições.
3. get_performance_summary (period=30d) e get_funnel: entenda a base atual e o gargalo.
4. get_metrics_breakdown view=hours e view=channels: melhores horários e grupos perto de lotar.
5. search_offers nas categorias foco (desconto mínimo 30%) e desconfie da flag fake_discount.

Entregue:
- Linha do tempo (esquenta, dia D, pós-data) com quantidade de posts por dia e por grupo, dentro dos limites anti-banimento.
- Regras automáticas sugeridas (upsert_automation_rule) e buscas salvas (upsert_saved_search).
- Criativos: template e headline (generate_creative).
- Captação: grupos extras e convites rotativos, se algum grupo estiver acima de 80%.
- Riscos e o que monitorar (get_system_status) no dia.

Não execute nada ainda: mostre o plano, depois aplique com dry_run=true e só confirme com o aval do usuário.`;
}
