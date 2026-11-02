import {
  AudienceStats,
  Content,
  ContentKit,
  ContentKitQuery,
  CreateContentInput,
  ListContentsQuery,
  MarkContentPostedInput,
  MetricsPeriodQuery,
  ReviewContentInput,
  Storefront,
  SubmitVideoInput,
  UpdateContentInput,
  UpdateStorefrontInput,
} from "@ofertas/contracts";
import {
  type Ctx,
  createContent,
  type Deps,
  deleteContent,
  getAudienceStats,
  getContent,
  getContentKit,
  getStorefront,
  listContents,
  markContentPosted,
  reviewContent,
  submitVideo,
  updateContent,
  updateStorefront,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor } from "../auth";
import { errors, MutationResult, mutationOpts, mutationSchema } from "./common";

/** Audiência orgânica: vitrine pública e medição por origem (spec 18). */
export const audienceRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  app.get(
    "/storefront",
    { schema: { tags: ["audiência"], response: { 200: Storefront.nullable(), ...errors } } },
    async (req) => getStorefront(ctx(req)),
  );
  app.patch(
    "/storefront",
    {
      schema: {
        tags: ["audiência"],
        body: UpdateStorefrontInput,
        ...mutationSchema,
        response: { 200: MutationResult(Storefront), ...errors },
      },
    },
    async (req) => updateStorefront(ctx(req), req.body, mutationOpts(req)),
  );
  app.get(
    "/audience/stats",
    {
      schema: {
        tags: ["audiência"],
        querystring: MetricsPeriodQuery,
        response: { 200: AudienceStats, ...errors },
      },
    },
    async (req) => getAudienceStats(ctx(req), req.query),
  );

  // ── Estúdio de conteúdo ───────────────────────────────────────
  const IdParams = z.object({ id: z.uuid() });
  app.get(
    "/content/kit",
    {
      schema: {
        tags: ["audiência"],
        querystring: ContentKitQuery,
        response: { 200: ContentKit, ...errors },
      },
    },
    async (req) => getContentKit(ctx(req), req.query),
  );
  app.get(
    "/contents",
    {
      schema: {
        tags: ["audiência"],
        querystring: ListContentsQuery,
        response: { 200: z.array(Content), ...errors },
      },
    },
    async (req) => listContents(ctx(req), req.query),
  );
  app.post(
    "/contents",
    {
      schema: {
        tags: ["audiência"],
        body: CreateContentInput,
        ...mutationSchema,
        response: { 200: MutationResult(Content), ...errors },
      },
    },
    async (req) => createContent(ctx(req), req.body, mutationOpts(req)),
  );
  app.post(
    "/contents/video",
    {
      schema: {
        tags: ["audiência"],
        summary: "Enviar vídeo feito pelo agente local (fica aguardando aprovação)",
        body: SubmitVideoInput,
        ...mutationSchema,
        response: { 200: MutationResult(Content), ...errors },
      },
    },
    async (req) => submitVideo(ctx(req), req.body, mutationOpts(req)),
  );
  app.post(
    "/contents/:id/review",
    {
      schema: {
        tags: ["audiência"],
        summary: "Aprovar ou recusar um vídeo enviado (só usuário do painel)",
        params: IdParams,
        body: ReviewContentInput,
        ...mutationSchema,
        response: { 200: MutationResult(Content), ...errors },
      },
    },
    async (req) => reviewContent(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.get(
    "/contents/:id",
    { schema: { tags: ["audiência"], params: IdParams, response: { 200: Content, ...errors } } },
    async (req) => getContent(ctx(req), req.params.id),
  );
  app.patch(
    "/contents/:id",
    {
      schema: {
        tags: ["audiência"],
        params: IdParams,
        body: UpdateContentInput,
        ...mutationSchema,
        response: { 200: MutationResult(Content), ...errors },
      },
    },
    async (req) => updateContent(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.delete(
    "/contents/:id",
    {
      schema: {
        tags: ["audiência"],
        summary: "Excluir conteúdo e arquivos",
        params: IdParams,
        ...mutationSchema,
        response: {
          200: MutationResult(z.object({ id: z.string(), deleted: z.literal(true) })),
          ...errors,
        },
      },
    },
    async (req) => deleteContent(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/contents/:id/posted",
    {
      schema: {
        tags: ["audiência"],
        params: IdParams,
        body: MarkContentPostedInput,
        ...mutationSchema,
        response: { 200: MutationResult(Content), ...errors },
      },
    },
    async (req) => markContentPosted(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
};
