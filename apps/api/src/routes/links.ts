import {
  Channel,
  CreateInviteLinkInput,
  CreateTrackedLinkInput,
  InviteLink,
  LinkStats,
  LinkStatsQuery,
  ListTrackedLinksQuery,
  Segment,
  TrackedLink,
  TrackedLinkPage,
  UpdateInviteLinkInput,
  UpdateTrackedLinkInput,
  UpsertChannelInput,
  UpsertSegmentInput,
} from "@ofertas/contracts";
import {
  type Ctx,
  createInviteLink,
  createTrackedLink,
  type Deps,
  getLinkStats,
  listChannels,
  listInviteLinks,
  listSegments,
  listTrackedLinks,
  updateInviteLink,
  updateTrackedLink,
  upsertChannel,
  upsertSegment,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor } from "../auth";
import { errors, MutationResult, mutationOpts, mutationSchema } from "./common";

const IdParams = z.object({ id: z.uuid() });

/** Canais, segmentos, links rastreados, convites e estatísticas de cliques. */
export const linkRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  // ── Canais ─────────────────────────────────────────────────────
  app.get(
    "/channels",
    { schema: { tags: ["canais"], response: { 200: z.array(Channel), ...errors } } },
    async (req) => listChannels(ctx(req)),
  );
  app.post(
    "/channels",
    {
      schema: {
        tags: ["canais"],
        body: UpsertChannelInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) => upsertChannel(ctx(req), req.body, mutationOpts(req)),
  );
  app.patch(
    "/channels/:id",
    {
      schema: {
        tags: ["canais"],
        params: IdParams,
        body: UpsertChannelInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) => upsertChannel(ctx(req), { ...req.body, id: req.params.id }, mutationOpts(req)),
  );

  // ── Segmentos ──────────────────────────────────────────────────
  const SegmentOut = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
  });
  app.get(
    "/segments",
    { schema: { tags: ["canais"], response: { 200: z.array(Segment), ...errors } } },
    async (req) => listSegments(ctx(req)),
  );
  app.post(
    "/segments",
    {
      schema: {
        tags: ["canais"],
        body: UpsertSegmentInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(SegmentOut), ...errors },
      },
    },
    async (req) => upsertSegment(ctx(req), req.body, mutationOpts(req)),
  );
  app.patch(
    "/segments/:id",
    {
      schema: {
        tags: ["canais"],
        params: IdParams,
        body: UpsertSegmentInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(SegmentOut), ...errors },
      },
    },
    async (req) => upsertSegment(ctx(req), { ...req.body, id: req.params.id }, mutationOpts(req)),
  );

  // ── Links rastreados ───────────────────────────────────────────
  app.get(
    "/links",
    {
      schema: {
        tags: ["links"],
        querystring: ListTrackedLinksQuery,
        response: { 200: TrackedLinkPage, ...errors },
      },
    },
    async (req) => listTrackedLinks(ctx(req), req.query),
  );
  app.post(
    "/links",
    {
      schema: {
        tags: ["links"],
        body: CreateTrackedLinkInput,
        ...mutationSchema,
        response: { 200: MutationResult(TrackedLink), ...errors },
      },
    },
    async (req) => createTrackedLink(ctx(req), req.body, mutationOpts(req)),
  );
  app.patch(
    "/links/:id",
    {
      schema: {
        tags: ["links"],
        description: "Troca destino, ativa/desativa ou muda validade. O link curto não muda.",
        params: IdParams,
        body: UpdateTrackedLinkInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(TrackedLink), ...errors },
      },
    },
    async (req) =>
      updateTrackedLink(ctx(req), { ...req.body, id: req.params.id }, mutationOpts(req)),
  );

  app.get(
    "/stats/clicks",
    {
      schema: {
        tags: ["links"],
        description:
          "Cliques de links e convites: totais e quebra por dia, link, convite, canal ou origem.",
        querystring: LinkStatsQuery,
        response: { 200: LinkStats, ...errors },
      },
    },
    async (req) => getLinkStats(ctx(req), req.query),
  );

  // ── Convites rotativos ─────────────────────────────────────────
  app.get(
    "/invite-links",
    { schema: { tags: ["convites"], response: { 200: z.array(InviteLink), ...errors } } },
    async (req) => listInviteLinks(ctx(req)),
  );
  app.post(
    "/invite-links",
    {
      schema: {
        tags: ["convites"],
        body: CreateInviteLinkInput,
        ...mutationSchema,
        response: { 200: MutationResult(InviteLink), ...errors },
      },
    },
    async (req) => createInviteLink(ctx(req), req.body, mutationOpts(req)),
  );
  app.patch(
    "/invite-links/:id",
    {
      schema: {
        tags: ["convites"],
        params: IdParams,
        body: UpdateInviteLinkInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(InviteLink), ...errors },
      },
    },
    async (req) =>
      updateInviteLink(ctx(req), { ...req.body, id: req.params.id }, mutationOpts(req)),
  );
};
