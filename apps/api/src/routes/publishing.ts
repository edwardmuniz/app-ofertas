import {
  AutomationRule,
  Channel,
  ConnectionState,
  CreateMessagingAccountInput,
  ListPostsQuery,
  MessageTemplate,
  MessagingAccount,
  Post,
  PostPage,
  PostPreview,
  PreviewPostInput,
  SchedulePostsInput,
  ScheduleResult,
  SyncGroupsResult,
  UpsertAutomationRuleInput,
  UpsertMessageTemplateInput,
} from "@ofertas/contracts";
import {
  type Ctx,
  cancelPost,
  createMessagingAccount,
  type Deps,
  deleteSentPost,
  getConnectionState,
  handleMessagingWebhook,
  listAutomationRules,
  listMessageTemplates,
  listMessagingAccounts,
  listPosts,
  logoutMessagingAccount,
  previewPost,
  requestPairingCode,
  schedulePosts,
  setChannelAdminOnly,
  syncGroups,
  upsertAutomationRule,
  upsertMessageTemplate,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor } from "../auth";
import { errors, MutationResult, mutationOpts, mutationSchema } from "./common";

const IdParams = z.object({ id: z.uuid() });

/** WhatsApp (números e grupos), modelos, publicações e regras. */
export const publishingRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  // ── Números ────────────────────────────────────────────────────
  app.get(
    "/whatsapp/accounts",
    { schema: { tags: ["whatsapp"], response: { 200: z.array(MessagingAccount), ...errors } } },
    async (req) => listMessagingAccounts(ctx(req)),
  );
  app.post(
    "/whatsapp/accounts",
    {
      schema: {
        tags: ["whatsapp"],
        description:
          "Cria a instância no provedor (só pelo painel). Depois conecte por QR ou código.",
        body: CreateMessagingAccountInput,
        ...mutationSchema,
        response: { 200: MutationResult(MessagingAccount), ...errors },
      },
    },
    async (req) => createMessagingAccount(ctx(req), req.body, mutationOpts(req)),
  );
  app.get(
    "/whatsapp/accounts/:id/connection",
    {
      schema: {
        tags: ["whatsapp"],
        description: "Status da conexão e QR atual (atualize a cada poucos segundos até conectar).",
        params: IdParams,
        response: { 200: ConnectionState, ...errors },
      },
    },
    async (req) => getConnectionState(ctx(req), req.params.id),
  );
  app.post(
    "/whatsapp/accounts/:id/pairing-code",
    {
      schema: {
        tags: ["whatsapp"],
        params: IdParams,
        body: z.object({ phone: z.string().min(10).max(20) }),
        response: { 200: z.object({ code: z.string() }), ...errors },
      },
    },
    async (req) => requestPairingCode(ctx(req), req.params.id, req.body.phone),
  );
  app.post(
    "/whatsapp/accounts/:id/logout",
    {
      schema: {
        tags: ["whatsapp"],
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(MessagingAccount), ...errors },
      },
    },
    async (req) => logoutMessagingAccount(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/whatsapp/accounts/:id/sync-groups",
    {
      schema: {
        tags: ["whatsapp"],
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(SyncGroupsResult), ...errors },
      },
    },
    async (req) => syncGroups(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/channels/:id/admin-only",
    {
      schema: {
        tags: ["whatsapp"],
        params: IdParams,
        body: z.object({ admin_only: z.boolean() }),
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) =>
      setChannelAdminOnly(ctx(req), req.params.id, req.body.admin_only, mutationOpts(req)),
  );

  // ── Modelos ────────────────────────────────────────────────────
  app.get(
    "/message-templates",
    {
      schema: {
        tags: ["publicação"],
        response: {
          200: z.object({ builtin_default: z.string(), items: z.array(MessageTemplate) }),
          ...errors,
        },
      },
    },
    async (req) => listMessageTemplates(ctx(req)),
  );
  app.post(
    "/message-templates",
    {
      schema: {
        tags: ["publicação"],
        body: UpsertMessageTemplateInput,
        ...mutationSchema,
        response: { 200: MutationResult(MessageTemplate), ...errors },
      },
    },
    async (req) => upsertMessageTemplate(ctx(req), req.body, mutationOpts(req)),
  );

  // ── Publicações ────────────────────────────────────────────────
  app.post(
    "/posts/preview",
    {
      schema: {
        tags: ["publicação"],
        body: PreviewPostInput,
        response: { 200: PostPreview, ...errors },
      },
    },
    async (req) => previewPost(ctx(req), req.body),
  );
  app.post(
    "/posts",
    {
      schema: {
        tags: ["publicação"],
        description:
          "Agenda ofertas ou texto em grupos/segmentos. Use ?dry_run=true para ver o plano.",
        body: SchedulePostsInput,
        ...mutationSchema,
        response: { 200: MutationResult(ScheduleResult), ...errors },
      },
    },
    async (req) => schedulePosts(ctx(req), req.body, mutationOpts(req)),
  );
  app.get(
    "/posts",
    {
      schema: {
        tags: ["publicação"],
        querystring: ListPostsQuery,
        response: { 200: PostPage, ...errors },
      },
    },
    async (req) => listPosts(ctx(req), req.query),
  );
  app.post(
    "/posts/:id/cancel",
    {
      schema: {
        tags: ["publicação"],
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(Post), ...errors },
      },
    },
    async (req) => cancelPost(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/posts/:id/delete-sent",
    {
      schema: {
        tags: ["publicação"],
        description: "Apaga para todos a mensagem já enviada no grupo.",
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(Post), ...errors },
      },
    },
    async (req) => deleteSentPost(ctx(req), req.params.id, mutationOpts(req)),
  );

  // ── Regras ─────────────────────────────────────────────────────
  app.get(
    "/automation-rules",
    { schema: { tags: ["publicação"], response: { 200: z.array(AutomationRule), ...errors } } },
    async (req) => listAutomationRules(ctx(req)),
  );
  app.post(
    "/automation-rules",
    {
      schema: {
        tags: ["publicação"],
        body: UpsertAutomationRuleInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(AutomationRule), ...errors },
      },
    },
    async (req) => upsertAutomationRule(ctx(req), req.body, mutationOpts(req)),
  );
  app.patch(
    "/automation-rules/:id",
    {
      schema: {
        tags: ["publicação"],
        params: IdParams,
        body: UpsertAutomationRuleInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(AutomationRule), ...errors },
      },
    },
    async (req) =>
      upsertAutomationRule(ctx(req), { ...req.body, id: req.params.id }, mutationOpts(req)),
  );
};

/**
 * Webhooks do provedor de WhatsApp. Sem autenticação por header: a origem é validada pelo
 * token da instância no corpo. Sempre responde 200 rápido (o provedor reenvia em caso de erro).
 */
export const webhookRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  app.post(
    "/webhooks/whatsapp/:provider",
    {
      schema: { hide: true, params: z.object({ provider: z.enum(["evolution_go", "fake"]) }) },
      bodyLimit: 5 * 1024 * 1024,
    },
    async (req, reply) => {
      try {
        const res = await handleMessagingWebhook(deps, req.params.provider, req.body);
        if (!res.ok) req.log.warn({ reason: res.reason }, "webhook de WhatsApp recusado");
        return reply.status(res.ok ? 200 : 401).send(res);
      } catch (err) {
        req.log.error(err, "erro no webhook de WhatsApp");
        return reply.status(200).send({ ok: false });
      }
    },
  );
};
