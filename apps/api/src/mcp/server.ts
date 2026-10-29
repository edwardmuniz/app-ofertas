import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuditQuery, MutationOptions, Preferences } from "@ofertas/contracts";
import {
  type Ctx,
  getOverview,
  getPreferences,
  isAppError,
  listAudit,
  updatePreferences,
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

  return server;
}
