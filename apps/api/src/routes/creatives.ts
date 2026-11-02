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
  MAX_VIDEO_BYTES,
  PublicImage,
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
  publishImage,
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
    "/creatives/uploads/:id/publish",
    {
      schema: {
        tags: ["criativos"],
        description:
          "Depois do PUT, devolve um endereço público e permanente da imagem (logo, capa, foto do grupo, foto da oferta).",
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(PublicImage), ...errors },
      },
    },
    async (req) => publishImage(ctx(req), { upload_id: req.params.id }, mutationOpts(req)),
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
  // Vídeo do agente local (submit_video): até 100 MB. octet-stream fica no limite de imagem.
  app.addContentTypeParser(
    "video/mp4",
    { parseAs: "buffer", bodyLimit: MAX_VIDEO_BYTES + 1024 },
    parseBuffer,
  );

  const Signed = z.object({ e: z.coerce.number(), s: z.string().min(10) });

  app.put(
    "/uploads/:id",
    {
      schema: { hide: true, params: IdParams, querystring: Signed },
      bodyLimit: MAX_VIDEO_BYTES + 1024,
    },
    async (req) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return receiveUpload(deps, req.params.id, req.query.e, req.query.s, body);
    },
  );

  const EXT: Record<string, string> = {
    "video/mp4": "mp4",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  app.get(
    "/media/:id",
    {
      schema: {
        hide: true,
        params: IdParams,
        querystring: Signed.extend({ dl: z.string().max(80).optional() }),
      },
    },
    async (req, reply) => {
      const file = await serveMedia(deps, req.params.id, req.query.e, req.query.s, {
        download: Boolean(req.query.dl),
      });
      if (!file)
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Arquivo não encontrado." } });
      if ("redirect" in file) return reply.redirect(file.redirect, 302);
      reply
        .type(file.mime)
        .header("cache-control", "public, max-age=86400, immutable")
        .header("accept-ranges", "bytes");
      // ?dl=nome baixa o arquivo em vez de abrir.
      if (req.query.dl) {
        const name = req.query.dl.replace(/[^\w.-]+/g, "-");
        reply.header(
          "content-disposition",
          `attachment; filename="${name}.${EXT[file.mime] ?? "bin"}"`,
        );
      }
      // Pedido por partes (players de vídeo, principalmente no iPhone).
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        const size = file.data.length;
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          return reply.status(416).header("content-range", `bytes */${size}`).send();
        }
        return reply
          .status(206)
          .header("content-range", `bytes ${start}-${end}/${size}`)
          .send(file.data.subarray(start, end + 1));
      }
      return reply.send(file.data);
    },
  );
};
