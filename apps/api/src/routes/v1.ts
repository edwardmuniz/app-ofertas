import {
  ApiToken,
  AuditPage,
  AuditQuery,
  CreatedToken,
  CreateTokenInput,
  ErrorResponse,
  LoginInput,
  Me,
  Preferences,
  SignupInput,
  WorkspaceOverview,
} from "@ofertas/contracts";
import {
  AppError,
  type Ctx,
  createToken,
  type Deps,
  getOverview,
  getPreferences,
  listAudit,
  listTokens,
  login,
  logout,
  resolveSession,
  revokeToken,
  signup,
  updatePreferences,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor, SESSION_COOKIE, setSessionCookie } from "../auth";
import { errors, MutationHeaders, MutationQuery, MutationResult } from "./common";

export type V1Options = { deps: Deps; allowSignup: boolean; secureCookies: boolean };

export const v1Routes: FastifyPluginAsyncZod<V1Options> = async (app, opts) => {
  const { deps } = opts;
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  app.get(
    "/health",
    { schema: { tags: ["sistema"], response: { 200: z.object({ ok: z.boolean() }) } } },
    async () => ({ ok: true }),
  );

  // ── Auth (painel) ──────────────────────────────────────────────
  app.post(
    "/auth/signup",
    {
      schema: {
        tags: ["auth"],
        body: SignupInput,
        response: { 200: Me, ...errors, 409: ErrorResponse },
      },
    },
    async (req, reply) => {
      const s = await signup(deps, req.body, { allowSignup: opts.allowSignup });
      setSessionCookie(reply, s.sessionToken, s.expiresAt, opts.secureCookies);
      return s.me;
    },
  );

  app.post(
    "/auth/login",
    { schema: { tags: ["auth"], body: LoginInput, response: { 200: Me, ...errors } } },
    async (req, reply) => {
      const s = await login(deps, req.body);
      setSessionCookie(reply, s.sessionToken, s.expiresAt, opts.secureCookies);
      return s.me;
    },
  );

  app.post(
    "/auth/logout",
    { schema: { tags: ["auth"], response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req, reply) => {
      const sid = req.cookies[SESSION_COOKIE];
      if (sid) await logout(deps, sid);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    },
  );

  app.get(
    "/auth/me",
    { schema: { tags: ["auth"], response: { 200: Me, ...errors } } },
    async (req) => {
      requireActor(req);
      const sid = req.cookies[SESSION_COOKIE];
      const r = sid ? await resolveSession(deps, sid) : null;
      if (!r) {
        // Chamado com token de agente: não há "usuário" — devolve 401 explicativo.
        throw new AppError("UNAUTHENTICATED", "/auth/me só existe para sessões do painel.", {
          hint: "Agentes devem usar GET /v1/workspace/overview.",
        });
      }
      return r.me;
    },
  );

  // ── Workspace ──────────────────────────────────────────────────
  app.get(
    "/workspace/overview",
    { schema: { tags: ["workspace"], response: { 200: WorkspaceOverview, ...errors } } },
    async (req) => getOverview(ctx(req)),
  );

  app.get(
    "/workspace/preferences",
    { schema: { tags: ["workspace"], response: { 200: Preferences, ...errors } } },
    async (req) => getPreferences(ctx(req)),
  );

  app.patch(
    "/workspace/preferences",
    {
      schema: {
        tags: ["workspace"],
        description: "Atualização parcial. Suporta ?dry_run=true e header Idempotency-Key.",
        body: Preferences,
        querystring: MutationQuery,
        headers: MutationHeaders,
        response: { 200: MutationResult(Preferences), ...errors },
      },
    },
    async (req) =>
      updatePreferences(ctx(req), req.body, {
        dryRun: req.query.dry_run,
        idempotencyKey: req.headers["idempotency-key"],
        reason: req.headers["x-audit-reason"],
      }),
  );

  // ── Tokens de agente ───────────────────────────────────────────
  app.get(
    "/tokens",
    { schema: { tags: ["tokens"], response: { 200: z.array(ApiToken), ...errors } } },
    async (req) => listTokens(ctx(req)),
  );

  app.post(
    "/tokens",
    {
      schema: {
        tags: ["tokens"],
        description: "Cria token de agente. Só pelo painel (sessão de usuário).",
        body: CreateTokenInput,
        response: { 200: CreatedToken, ...errors },
      },
    },
    async (req) => createToken(ctx(req), req.body),
  );

  app.delete(
    "/tokens/:id",
    {
      schema: {
        tags: ["tokens"],
        params: z.object({ id: z.uuid() }),
        response: { 200: ApiToken, ...errors },
      },
    },
    async (req) => revokeToken(ctx(req), req.params.id),
  );

  // ── Auditoria ──────────────────────────────────────────────────
  app.get(
    "/audit-log",
    {
      schema: {
        tags: ["auditoria"],
        querystring: AuditQuery,
        response: { 200: AuditPage, ...errors },
      },
    },
    async (req) => listAudit(ctx(req), req.query),
  );
};
