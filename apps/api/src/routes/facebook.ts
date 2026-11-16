import {
  AddFacebookGroupInput,
  AnalyzeFacebookGroupInput,
  BrowserJob,
  BrowserJobResultInput,
  Channel,
  ClaimBrowserJobInput,
  DiscoverFacebookGroupsInput,
  DiscoverFacebookGroupsResult,
  FacebookAccount,
  FacebookHeartbeatInput,
  FacebookHeartbeatResult,
  PlanFacebookPostsInput,
  PlanFacebookPostsResult,
  PrepareFacebookJoinInput,
  RankFacebookGroupsInput,
  RankFacebookGroupsResult,
  SetGroupPostingPolicyInput,
} from "@ofertas/contracts";
import {
  addFacebookGroup,
  analyzeFacebookGroup,
  browserJobImage,
  type Ctx,
  claimBrowserJob,
  completeBrowserJob,
  type Deps,
  discoverFacebookGroups,
  facebookHeartbeat,
  listFacebookAccounts,
  planFacebookPosts,
  prepareFacebookJoin,
  rankFacebookGroups,
  removeFacebookGroup,
  resumeFacebookAccount,
  setGroupPostingPolicy,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor } from "../auth";
import { errors, MutationResult, mutationOpts, mutationSchema } from "./common";

const IdParams = z.object({ id: z.uuid() });
const tags = ["facebook"];

/** Grupos do Facebook pela extensão do Chrome (spec 19). */
export const facebookRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  // ── Painel, agentes ────────────────────────────────────────────
  app.get(
    "/facebook/discover",
    {
      schema: {
        tags,
        querystring: DiscoverFacebookGroupsInput,
        response: { 200: DiscoverFacebookGroupsResult, ...errors },
      },
    },
    async (req) => discoverFacebookGroups(ctx(req), req.query),
  );
  app.post(
    "/facebook/discover/rank",
    {
      schema: {
        tags,
        body: RankFacebookGroupsInput,
        response: { 200: RankFacebookGroupsResult, ...errors },
      },
    },
    async (req) => rankFacebookGroups(ctx(req), req.body),
  );
  app.post(
    "/facebook/posts/plan",
    {
      schema: {
        tags,
        body: PlanFacebookPostsInput,
        response: { 200: PlanFacebookPostsResult, ...errors },
      },
    },
    async (req) => planFacebookPosts(ctx(req), req.body),
  );
  app.get(
    "/facebook/accounts",
    { schema: { tags, response: { 200: z.array(FacebookAccount), ...errors } } },
    async (req) => listFacebookAccounts(ctx(req)),
  );
  app.post(
    "/facebook/accounts/:id/resume",
    {
      schema: {
        tags,
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(z.object({ resumed: z.literal(true) })), ...errors },
      },
    },
    async (req) => resumeFacebookAccount(ctx(req), req.params.id, mutationOpts(req)),
  );

  // ── Extensão ───────────────────────────────────────────────────
  app.post(
    "/facebook/joins/prepare",
    {
      schema: {
        tags,
        body: PrepareFacebookJoinInput,
        ...mutationSchema,
        response: {
          200: MutationResult(z.object({ group_id: z.string(), url: z.url() })),
          ...errors,
        },
      },
    },
    async (req) => prepareFacebookJoin(ctx(req), req.body, mutationOpts(req)),
  );
  app.post(
    "/facebook/heartbeat",
    {
      schema: {
        tags,
        body: FacebookHeartbeatInput,
        response: { 200: FacebookHeartbeatResult, ...errors },
      },
    },
    async (req) => facebookHeartbeat(ctx(req), req.body),
  );
  app.post(
    "/facebook/groups",
    {
      schema: {
        tags,
        body: AddFacebookGroupInput,
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) => addFacebookGroup(ctx(req), req.body, mutationOpts(req)),
  );
  app.post(
    "/facebook/analyze-group",
    {
      schema: {
        tags,
        body: AnalyzeFacebookGroupInput,
        ...mutationSchema,
        response: {
          200: MutationResult(
            z.object({
              channel: Channel,
              policy: z.string().nullable(),
              evidence: z.array(z.string()),
              kept_human: z.boolean(),
            }),
          ),
          ...errors,
        },
      },
    },
    async (req) => analyzeFacebookGroup(ctx(req), req.body, mutationOpts(req)),
  );
  app.patch(
    "/channels/:id/posting-policy",
    {
      schema: {
        tags,
        params: IdParams,
        body: SetGroupPostingPolicyInput,
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) => setGroupPostingPolicy(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.delete(
    "/facebook/groups/:id",
    {
      schema: {
        tags,
        summary: "Remover grupo do Facebook da operação (arquiva e cancela agendados)",
        params: IdParams,
        ...mutationSchema,
        response: {
          200: MutationResult(
            z.object({ channel: Channel, scheduled_posts_canceled: z.number().int() }),
          ),
          ...errors,
        },
      },
    },
    async (req) => removeFacebookGroup(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/facebook/jobs/claim",
    {
      schema: {
        tags,
        body: ClaimBrowserJobInput,
        response: { 200: BrowserJob, 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      const job = await claimBrowserJob(ctx(req), req.body);
      if (!job) return reply.code(204).send(null);
      return job;
    },
  );
  app.get(
    "/facebook/jobs/:id/image",
    { schema: { tags, params: IdParams } },
    async (req, reply) => {
      const img = await browserJobImage(ctx(req), req.params.id);
      reply.header("content-type", img.contentType).header("cache-control", "no-store");
      return reply.send(img.data);
    },
  );
  app.post(
    "/facebook/jobs/:id/result",
    {
      schema: {
        tags,
        params: IdParams,
        body: BrowserJobResultInput,
        response: { 200: z.object({ status: z.enum(["done", "failed"]) }), ...errors },
      },
    },
    async (req) => completeBrowserJob(ctx(req), req.params.id, req.body),
  );
};
