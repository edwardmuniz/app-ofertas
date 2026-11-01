import {
  BrandKit,
  CompleteUploadInput,
  Creative,
  CreativePage,
  CreativeTemplateInfo,
  GenerateCreativeInput,
  ImportMediaInput,
  ListCreativesQuery,
  MAX_UPLOAD_BYTES,
  RequestUploadInput,
  UpdateBrandKitInput,
  UploadTicket,
} from "@ofertas/contracts";
import {
  type Ctx,
  completeUpload,
  type Deps,
  deleteCreative,
  generateCreative,
  getBrandKit,
  getCreative,
  importMediaFromUrl,
  listCreatives,
  listCreativeTemplates,
  receiveUpload,
  requestUpload,
  serveMedia,
  updateBrandKit,
  validateCreative,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor } from "../auth";
import { errors, MutationResult, mutationOpts, mutationSchema } from "./common";

const IdParams = z.object({ id: z.uuid() });

export const creativeRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  app.get(
    "/brand-kit",
    { schema: { tags: ["criativos"], response: { 200: BrandKit, ...errors } } },
    async (req) => getBrandKit(ctx(req)),
  );
  app.patch(
    "/brand-kit",
    {
      schema: {
        tags: ["criativos"],
        body: UpdateBrandKitInput,
        ...mutationSchema,
        response: { 200: MutationResult(BrandKit), ...errors },
      },
    },
    async (req) => updateBrandKit(ctx(req), req.body, mutationOpts(req)),
  );
  app.get(
    "/creative-templates",
    {
      schema: { tags: ["criativos"], response: { 200: z.array(CreativeTemplateInfo), ...errors } },
    },
    async (req) => {
      requireActor(req);
      return listCreativeTemplates();
    },
  );
  app.post(
    "/creatives/generate",
    {
      schema: {
        tags: ["criativos"],
        body: GenerateCreativeInput,
        ...mutationSchema,
        response: { 200: MutationResult(Creative), ...errors },
      },
    },
    async (req) => generateCreative(ctx(req), req.body, mutationOpts(req)),
  );
  app.post(
    "/creatives/uploads",
    {
      schema: {
        tags: ["criativos"],
        description: "Pede um link assinado para enviar a imagem com PUT.",
        body: RequestUploadInput,
        ...mutationSchema,
        response: { 200: MutationResult(UploadTicket), ...errors },
      },
    },
    async (req) => requestUpload(ctx(req), req.body, mutationOpts(req)),
  );
  app.post(
    "/creatives/uploads/:id/complete",
    {
      schema: {
        tags: ["criativos"],
        params: IdParams,
        body: CompleteUploadInput.omit({ upload_id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(Creative), ...errors },
      },
    },
    async (req) =>
      completeUpload(ctx(req), { ...req.body, upload_id: req.params.id }, mutationOpts(req)),
  );
  app.post(
    "/creatives/import",
    {
      schema: {
        tags: ["criativos"],
        body: ImportMediaInput,
        ...mutationSchema,
        response: { 200: MutationResult(Creative), ...errors },
      },
    },
    async (req) => importMediaFromUrl(ctx(req), req.body, mutationOpts(req)),
  );
  app.get(
    "/creatives",
    {
      schema: {
        tags: ["criativos"],
        querystring: ListCreativesQuery,
        response: { 200: CreativePage, ...errors },
      },
    },
    async (req) => listCreatives(ctx(req), req.query),
  );
  app.get(
    "/creatives/:id",
    { schema: { tags: ["criativos"], params: IdParams, response: { 200: Creative, ...errors } } },
    async (req) => getCreative(ctx(req), req.params.id),
  );
  app.delete(
    "/creatives/:id",
    {
      schema: {
        tags: ["criativos"],
        description: "Remove o criativo e seus arquivos.",
        params: IdParams,
        ...mutationSchema,
        response: {
          200: MutationResult(z.object({ id: z.string(), deleted: z.literal(true) })),
          ...errors,
        },
      },
    },
    async (req) => deleteCreative(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/creatives/:id/validate",
    {
      schema: {
        tags: ["criativos"],
        params: IdParams,
        body: z.object({ format: z.enum(["wa_image", "feed_4x5", "story_9x16"]) }),
      },
    },
    async (req) =>
      validateCreative(ctx(req), { creative_id: req.params.id, format: req.body.format }),
  );
};

/** Rotas públicas validadas por assinatura: envio do arquivo e entrega das imagens. */
export const mediaRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const parseBuffer = (
    _req: unknown,
    body: Buffer,
    done: (err: Error | null, body?: Buffer) => void,
  ) => done(null, body);
  for (const type of ["image/png", "image/jpeg", "image/webp", "application/octet-stream"]) {
    app.addContentTypeParser(
      type,
      { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES + 1024 },
      parseBuffer,
    );
  }

  const Signed = z.object({ e: z.coerce.number(), s: z.string().min(10) });

  app.put(
    "/uploads/:id",
    {
      schema: { hide: true, params: IdParams, querystring: Signed },
      bodyLimit: MAX_UPLOAD_BYTES + 1024,
    },
    async (req) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return receiveUpload(deps, req.params.id, req.query.e, req.query.s, body);
    },
  );

  app.get(
    "/media/:id",
    { schema: { hide: true, params: IdParams, querystring: Signed } },
    async (req, reply) => {
      const file = await serveMedia(deps, req.params.id, req.query.e, req.query.s);
      if (!file)
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Arquivo não encontrado." } });
      return reply
        .type(file.mime)
        .header("cache-control", "public, max-age=86400, immutable")
        .send(file.data);
    },
  );
};
