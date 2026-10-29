import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AuditQuery,
  CreateInviteLinkInput,
  CreateTrackedLinkInput,
  LinkStatsQuery,
  ListTrackedLinksQuery,
  MutationOptions,
  Preferences,
  UpdateInviteLinkInput,
  UpdateTrackedLinkInput,
  UpsertChannelInput,
  UpsertSegmentInput,
} from "@ofertas/contracts";
import {
  type MutationOptions as CoreMutationOptions,
  type Ctx,
  createInviteLink,
  createTrackedLink,
  getLinkStats,
  getOverview,
  getPreferences,
  isAppError,
  listAudit,
  listChannels,
  listInviteLinks,
  listSegments,
  listTrackedLinks,
  updateInviteLink,
  updatePreferences,
  updateTrackedLink,
  upsertChannel,
  upsertSegment,
} from "@ofertas/core";
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
        "Grupos e canais cadastrados, com membros, limite, link de convite e segmentos. Nesta fase o cadastro é manual; a importação do WhatsApp chega na Fase 3.",
      annotations: READ,
    },
    safe(async () => listChannels(ctx)),
  );

  server.registerTool(
    "upsert_channel",
    {
      title: "Criar ou editar canal",
      description:
        "Sem id cria um canal (name obrigatório); com id edita só os campos enviados. segment_ids substitui a lista de segmentos.",
      inputSchema: { ...UpsertChannelInput.shape, ...MutationOptions.shape },
      annotations: WRITE,
    },
    safe(async (args) => upsertChannel(ctx, ...splitOpts(args))),
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

  return server;
}
