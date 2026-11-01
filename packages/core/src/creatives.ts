import { createHash, randomUUID } from "node:crypto";
import {
  type BrandKit,
  CompleteUploadInput,
  type Creative,
  GenerateCreativeInput,
  ImportMediaInput,
  ListCreativesQuery,
  MAX_UPLOAD_BYTES,
  RequestUploadInput,
  UpdateBrandKitInput,
  type UploadTicket,
  ValidateCreativeInput,
} from "@ofertas/contracts";
import {
  assets,
  creatives,
  creativeVariants,
  type DbOrTx,
  type offers,
  type products,
  uploads,
  workspaces,
} from "@ofertas/db";
import {
  CREATIVE_FORMATS,
  CREATIVE_TEMPLATES,
  type CreativeFormat,
  type CreativeTemplateKey,
  DEFAULT_BRAND,
  detectFormat,
  inspectImage,
  renderCreative,
  validateImage,
} from "@ofertas/render";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now } from "./context";
import { olderThan, toPage } from "./cursor";
import { AppError } from "./errors";
import { type MutationOptions, runMutation } from "./mutation";
import { loadOffer } from "./offers";
import { offerVars } from "./templates";

type AssetRow = typeof assets.$inferSelect;
type CreativeRow = typeof creatives.$inferSelect;
type VariantRow = typeof creativeVariants.$inferSelect;
type MediaDeps = Pick<Deps, "secrets" | "publicApiUrl">;

const DAY_S = 86_400;
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// ── URLs assinadas ──────────────────────────────────────────────

/** URL pública e assinada de um arquivo. A validade é arredondada para o dia (URL estável). */
export function mediaUrl(deps: MediaDeps, assetId: string, ttlDays = 30) {
  const exp = (Math.floor(Date.now() / 1000 / DAY_S) + ttlDays + 1) * DAY_S;
  const sig = deps.secrets.mac(`media:${assetId}:${exp}`);
  return `${deps.publicApiUrl.replace(/\/$/, "")}/media/${assetId}?e=${exp}&s=${sig}`;
}

function checkSignature(deps: MediaDeps, payload: string, exp: number, sig: string) {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return deps.secrets.verifyMac(payload, sig);
}

/**
 * Link da imagem para quem está fora (Evolution Go baixa a imagem do post).
 * Com S3, link direto do bucket; sem S3, a rota /media da API (precisa de API_PUBLIC_URL acessível).
 */
async function externalMediaUrl(deps: Deps, asset: AssetRow) {
  if (deps.storage.signedUrl) return deps.storage.signedUrl(asset.storageKey, DAY_S);
  return mediaUrl(deps, asset.id);
}

/** Entrega um arquivo se a assinatura for válida. */
export async function serveMedia(deps: Deps, assetId: string, exp: number, sig: string) {
  if (!checkSignature(deps, `media:${assetId}:${exp}`, exp, sig)) return null;
  const [asset] = await deps.db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return null;
  const data = await deps.storage.get(asset.storageKey);
  return data ? { data, mime: asset.mime } : null;
}

// ── Brand kit ───────────────────────────────────────────────────

async function readBrandKit(db: DbOrTx, workspaceId: string): Promise<BrandKit> {
  const [ws] = await db
    .select({ settings: workspaces.settings, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const saved = (ws?.settings as { brand_kit?: Partial<BrandKit> } | undefined)?.brand_kit ?? {};
  return { ...DEFAULT_BRAND, name: ws?.name ?? DEFAULT_BRAND.name, ...saved };
}

export async function getBrandKit(ctx: Ctx) {
  requireScope(ctx.actor, "creatives:read");
  return readBrandKit(ctx.db, ctx.actor.workspaceId);
}

export async function updateBrandKit(
  ctx: Ctx,
  raw: UpdateBrandKitInput,
  opts: MutationOptions = {},
) {
  const input = UpdateBrandKitInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "creatives.update_brand_kit",
    scope: "creatives:write",
    input,
    opts,
    preview: async (c, i) => {
      const before = await readBrandKit(c.db, wsId);
      return { before, after: { ...before, ...i } };
    },
    execute: async (tx, _i, p) => {
      const [ws] = await tx.db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, wsId));
      await tx.db
        .update(workspaces)
        .set({ settings: { ...(ws?.settings ?? {}), brand_kit: p.after } })
        .where(eq(workspaces.id, wsId));
      return p.after;
    },
  });
}

export function listCreativeTemplates() {
  return (
    Object.entries(CREATIVE_TEMPLATES) as [
      CreativeTemplateKey,
      { name: string; description: string },
    ][]
  ).map(([key, t]) => ({
    key,
    name: t.name,
    description: t.description,
    formats: (
      Object.entries(CREATIVE_FORMATS) as [
        CreativeFormat,
        { width: number; height: number; label: string },
      ][]
    ).map(([fk, f]) => ({ key: fk, width: f.width, height: f.height, label: f.label })),
    params: {
      headline: "Texto curto no topo (padrão: plataforma ou CUPOM EXCLUSIVO).",
      cta: "Texto do botão (padrão: o do brand kit).",
      accent_color: "Cor de destaque em hexadecimal.",
    },
  }));
}

// ── Montagem ────────────────────────────────────────────────────

async function storeAsset(
  deps: Pick<Deps, "storage">,
  db: DbOrTx,
  workspaceId: string,
  data: Buffer,
  meta: { mime: string; width: number; height: number },
  source: AssetRow["source"],
) {
  const key = `${workspaceId}/${randomUUID()}.${EXT[meta.mime] ?? "bin"}`;
  await deps.storage.put(key, data);
  const [row] = await db
    .insert(assets)
    .values({
      workspaceId,
      storageKey: key,
      mime: meta.mime,
      size: data.length,
      width: meta.width,
      height: meta.height,
      checksum: createHash("sha256").update(data).digest("hex"),
      source,
    })
    .returning();
  if (!row) throw new Error("Falha ao salvar arquivo");
  return row;
}

function toCreative(
  deps: MediaDeps,
  row: CreativeRow,
  variants: { v: VariantRow; asset: AssetRow }[],
): Creative {
  return {
    id: row.id,
    offer_id: row.offerId,
    title: row.title,
    origin: row.origin,
    template: row.templateKey,
    params: row.params,
    rendered_price: row.renderedPrice,
    status: row.status,
    tags: row.tags,
    ai_generated: row.aiGenerated,
    variants: variants.map(({ v, asset }) => ({
      format: v.format,
      width: asset.width,
      height: asset.height,
      url: mediaUrl(deps, asset.id),
      preview_url: v.previewAssetId ? mediaUrl(deps, v.previewAssetId, 7) : null,
      validation: v.validation,
    })),
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}

async function variantsOf(db: DbOrTx, creativeIds: string[]) {
  const map = new Map<string, { v: VariantRow; asset: AssetRow }[]>();
  if (!creativeIds.length) return map;
  const rows = await db
    .select({ v: creativeVariants, asset: assets })
    .from(creativeVariants)
    .innerJoin(assets, eq(assets.id, creativeVariants.assetId))
    .where(inArray(creativeVariants.creativeId, creativeIds));
  for (const r of rows) map.set(r.v.creativeId, [...(map.get(r.v.creativeId) ?? []), r]);
  return map;
}

async function loadCreative(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(creatives)
    .where(and(eq(creatives.id, id), eq(creatives.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Criativo não encontrado.");
  return row;
}

async function productImage(deps: Pick<Deps, "fetchMedia">, product: typeof products.$inferSelect) {
  const url = product.imageUrls[0];
  if (!url) return null;
  try {
    const { data } = await deps.fetchMedia(url);
    const meta = inspectImage(data);
    return meta ? `data:${meta.mime};base64,${data.toString("base64")}` : null;
  } catch {
    return null; // sem foto: o template usa um placeholder
  }
}

/** Renderiza e salva o criativo de uma oferta (usado pela tool e pelo envio automático). */
export async function renderOfferCreative(
  deps: Pick<Deps, "storage" | "fetchMedia">,
  db: DbOrTx,
  input: {
    offer: typeof offers.$inferSelect;
    product: typeof products.$inferSelect;
    template: CreativeTemplateKey;
    formats: CreativeFormat[];
    params: { headline?: string; cta?: string; accent_color?: string };
    createdBy: string;
  },
) {
  const { offer, product } = input;
  const brand = await readBrandKit(db, offer.workspaceId);
  const vars = offerVars(offer, product, "");
  const data = {
    title: product.title,
    price: vars.preco ?? "",
    originalPrice: vars.preco_original ?? null,
    discountPct: offer.discountPct,
    coupon: offer.couponCode,
    badge: vars.selo ? vars.selo.replace(/^[^\p{L}\p{N}]+/u, "") : null,
    platform: vars.plataforma ?? "",
    image: await productImage(deps, product),
  };
  const [row] = await db
    .insert(creatives)
    .values({
      workspaceId: offer.workspaceId,
      offerId: offer.id,
      title: product.title,
      origin: "template",
      templateKey: input.template,
      params: input.params,
      renderedPrice: offer.price,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw new Error("Falha ao salvar criativo");
  const out: { v: VariantRow; asset: AssetRow }[] = [];
  for (const format of input.formats) {
    const r = await renderCreative({
      template: input.template,
      format,
      data,
      brand,
      params: input.params,
    });
    const full = await storeAsset(
      deps,
      db,
      offer.workspaceId,
      r.full.png,
      { mime: "image/png", ...r.full },
      "render",
    );
    const preview = await storeAsset(
      deps,
      db,
      offer.workspaceId,
      r.preview.png,
      { mime: "image/png", ...r.preview },
      "render",
    );
    const [v] = await db
      .insert(creativeVariants)
      .values({
        creativeId: row.id,
        format,
        assetId: full.id,
        previewAssetId: preview.id,
        validation: [],
      })
      .returning();
    if (v) out.push({ v, asset: full });
  }
  return { row, variants: out };
}

export async function generateCreative(
  ctx: Ctx,
  raw: GenerateCreativeInput,
  opts: MutationOptions = {},
) {
  const input = GenerateCreativeInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "creatives.generate",
    scope: "creatives:write",
    input,
    opts,
    target: (i) => ({ type: "offer", id: i.offer_id }),
    preview: async (c, i) => {
      const { offer, product } = await loadOffer(c.db, wsId, i.offer_id);
      if (offer.status === "rejected") throw new AppError("CONFLICT", "Oferta rejeitada.");
      return { title: product.title, price: offer.price, template: i.template, formats: i.formats };
    },
    execute: async (tx, i) => {
      const { offer, product } = await loadOffer(tx.db, wsId, i.offer_id);
      const { row, variants } = await renderOfferCreative(ctx, tx.db, {
        offer,
        product,
        template: i.template,
        formats: i.formats,
        params: { headline: i.headline, cta: i.cta, accent_color: i.accent_color },
        createdBy: ctx.actor.label,
      });
      return toCreative(ctx, row, variants);
    },
  });
}

/** Cria criativo a partir de uma imagem já salva (upload ou importação). */
async function creativeFromAsset(
  ctx: Ctx,
  db: DbOrTx,
  asset: AssetRow,
  meta: { offer_id?: string; title?: string; tags?: string[]; ai_generated?: boolean },
  origin: "upload" | "import",
  fallbackTitle: string,
) {
  if (meta.offer_id) await loadOffer(db, ctx.actor.workspaceId, meta.offer_id);
  const format = detectFormat(asset.width ?? 1, asset.height ?? 1);
  const [row] = await db
    .insert(creatives)
    .values({
      workspaceId: ctx.actor.workspaceId,
      offerId: meta.offer_id ?? null,
      title: meta.title ?? fallbackTitle,
      origin,
      tags: meta.tags ?? [],
      aiGenerated: meta.ai_generated ?? false,
      createdBy: ctx.actor.label,
    })
    .returning();
  if (!row) throw new Error("Falha ao salvar criativo");
  const validation = validateImage(
    { mime: asset.mime, width: asset.width ?? 0, height: asset.height ?? 0, size: asset.size },
    format,
  );
  const [v] = await db
    .insert(creativeVariants)
    .values({ creativeId: row.id, format, assetId: asset.id, previewAssetId: asset.id, validation })
    .returning();
  return toCreative(ctx, row, v ? [{ v, asset }] : []);
}

// ── Upload em duas etapas ───────────────────────────────────────

const UPLOAD_TTL_S = 15 * 60;

export async function requestUpload(ctx: Ctx, raw: RequestUploadInput, opts: MutationOptions = {}) {
  const input = RequestUploadInput.parse(raw);
  const res = await runMutation(ctx, {
    action: "creatives.request_upload",
    scope: "creatives:write",
    input,
    opts,
    preview: async (_c, i) => i,
    execute: async (tx, i): Promise<UploadTicket> => {
      const expiresAt = new Date(now(ctx).getTime() + UPLOAD_TTL_S * 1000);
      const [row] = await tx.db
        .insert(uploads)
        .values({
          workspaceId: ctx.actor.workspaceId,
          filename: i.filename,
          mime: i.mime,
          maxBytes: Math.min(i.size_bytes + 1024, MAX_UPLOAD_BYTES),
          expiresAt,
          createdBy: ctx.actor.label,
        })
        .returning();
      if (!row) throw new Error("Falha ao criar upload");
      const exp = Math.floor(expiresAt.getTime() / 1000);
      const putUrl = `${ctx.publicApiUrl.replace(/\/$/, "")}/uploads/${row.id}?e=${exp}&s=${ctx.secrets.mac(`upload:${row.id}:${exp}`)}`;
      return {
        upload_id: row.id,
        put_url: putUrl,
        method: "PUT",
        headers: { "content-type": i.mime },
        expires_at: expiresAt.toISOString(),
        curl: `curl -X PUT -H "content-type: ${i.mime}" --data-binary @"${i.filename}" "${putUrl}"`,
      };
    },
  });
  return res;
}

/** Recebe o arquivo enviado na URL assinada. Valida o conteúdo pelos bytes. */
export async function receiveUpload(
  deps: Deps,
  uploadId: string,
  exp: number,
  sig: string,
  data: Buffer,
) {
  if (!checkSignature(deps, `upload:${uploadId}:${exp}`, exp, sig)) {
    throw new AppError("UNAUTHENTICATED", "Link de upload inválido ou expirado.", {
      hint: "Peça um novo link com request_upload.",
    });
  }
  const [up] = await deps.db.select().from(uploads).where(eq(uploads.id, uploadId));
  if (up?.status !== "pending") throw new AppError("CONFLICT", "Este upload já foi usado.");
  if (data.length === 0) throw new AppError("VALIDATION_ERROR", "Arquivo vazio.");
  if (data.length > up.maxBytes) {
    throw new AppError("VALIDATION_ERROR", "Arquivo maior que o informado em size_bytes.");
  }
  const meta = inspectImage(data);
  if (!meta)
    throw new AppError("VALIDATION_ERROR", "O arquivo não é uma imagem PNG, JPEG ou WebP válida.");
  const asset = await storeAsset(deps, deps.db, up.workspaceId, data, meta, "upload");
  await deps.db
    .update(uploads)
    .set({ status: "uploaded", assetId: asset.id })
    .where(eq(uploads.id, up.id));
  return { ok: true, upload_id: up.id, width: meta.width, height: meta.height };
}

export async function completeUpload(
  ctx: Ctx,
  raw: CompleteUploadInput,
  opts: MutationOptions = {},
) {
  const input = CompleteUploadInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "creatives.complete_upload",
    scope: "creatives:write",
    input,
    opts,
    target: (i) => ({ type: "upload", id: i.upload_id }),
    preview: async (c, i) => {
      const [up] = await c.db
        .select()
        .from(uploads)
        .where(and(eq(uploads.id, i.upload_id), eq(uploads.workspaceId, wsId)));
      if (!up) throw new AppError("NOT_FOUND", "Upload não encontrado.");
      if (up.status === "pending") {
        throw new AppError("CONFLICT", "O arquivo ainda não foi enviado.", {
          hint: "Faça o PUT do arquivo na put_url antes de concluir.",
        });
      }
      if (up.status === "completed") throw new AppError("CONFLICT", "Upload já concluído.");
      return { filename: up.filename, asset_id: up.assetId };
    },
    execute: async (tx, i, p) => {
      const [asset] = await tx.db
        .select()
        .from(assets)
        .where(eq(assets.id, p.asset_id ?? ""));
      if (!asset) throw new AppError("NOT_FOUND", "Arquivo do upload não encontrado.");
      await tx.db.update(uploads).set({ status: "completed" }).where(eq(uploads.id, i.upload_id));
      return creativeFromAsset(ctx, tx.db, asset, i, "upload", p.filename);
    },
  });
}

export async function importMediaFromUrl(
  ctx: Ctx,
  raw: ImportMediaInput,
  opts: MutationOptions = {},
) {
  const input = ImportMediaInput.parse(raw);
  return runMutation(ctx, {
    action: "creatives.import",
    scope: "creatives:write",
    input,
    opts,
    preview: async (_c, i) => ({ url: i.url }),
    execute: async (tx, i) => {
      const { data } = await ctx.fetchMedia(i.url);
      const meta = inspectImage(data);
      if (!meta)
        throw new AppError(
          "VALIDATION_ERROR",
          "A URL não aponta para uma imagem PNG, JPEG ou WebP.",
        );
      const asset = await storeAsset(ctx, tx.db, ctx.actor.workspaceId, data, meta, "import");
      return creativeFromAsset(
        ctx,
        tx.db,
        asset,
        i,
        "import",
        new URL(i.url).pathname.split("/").pop() || "Imagem importada",
      );
    },
  });
}

// ── Leitura ─────────────────────────────────────────────────────

export async function listCreatives(ctx: Ctx, raw: ListCreativesQuery = {}) {
  requireScope(ctx.actor, "creatives:read");
  const q = ListCreativesQuery.parse(raw);
  const conds = [eq(creatives.workspaceId, ctx.actor.workspaceId)];
  if (q.offer_id) conds.push(eq(creatives.offerId, q.offer_id));
  if (q.origin) conds.push(eq(creatives.origin, q.origin));
  if (!q.include_archived) conds.push(eq(creatives.status, "ready"));
  if (q.cursor) {
    const c = olderThan(q.cursor, creatives.createdAt, creatives.id);
    if (c) conds.push(c);
  }
  const rows = await ctx.db
    .select()
    .from(creatives)
    .where(and(...conds))
    .orderBy(desc(creatives.createdAt), desc(creatives.id))
    .limit(q.limit + 1);
  const variants = await variantsOf(
    ctx.db,
    rows.map((r) => r.id),
  );
  return toPage(rows, q.limit, (r) => toCreative(ctx, r, variants.get(r.id) ?? []));
}

export async function getCreative(ctx: Ctx, id: string) {
  requireScope(ctx.actor, "creatives:read");
  const row = await loadCreative(ctx.db, ctx.actor.workspaceId, id);
  return toCreative(ctx, row, (await variantsOf(ctx.db, [row.id])).get(row.id) ?? []);
}

/** Confere se o criativo serve para um formato de destino. */
export async function validateCreative(ctx: Ctx, raw: ValidateCreativeInput) {
  requireScope(ctx.actor, "creatives:read");
  const input = ValidateCreativeInput.parse(raw);
  const row = await loadCreative(ctx.db, ctx.actor.workspaceId, input.creative_id);
  const variants = (await variantsOf(ctx.db, [row.id])).get(row.id) ?? [];
  const exact = variants.find((v) => v.v.format === input.format);
  const candidate = exact ?? variants[0];
  if (!candidate)
    return {
      ok: false,
      format: input.format,
      issues: [{ code: "no_variant", message: "Sem imagem.", hint: "" }],
    };
  if (!exact && row.origin === "template") {
    // O template pode gerar qualquer formato: basta pedir de novo.
    const issues = [
      {
        code: "missing_format",
        message: `Este criativo não foi gerado no formato ${input.format}.`,
        hint: "Rode generate_creative com esse formato.",
      },
    ];
    return { ok: false, format: input.format, issues };
  }
  const a = candidate.asset;
  const issues = validateImage(
    { mime: a.mime, width: a.width ?? 0, height: a.height ?? 0, size: a.size },
    input.format,
  );
  return { ok: issues.length === 0, format: input.format, issues };
}

/**
 * Imagem para publicar uma oferta: usa o criativo do post (regenera se o preço mudou)
 * ou gera um novo pelo template. Devolve a URL e o id do criativo usado.
 */
export async function creativeImageForPost(
  deps: Deps,
  input: {
    offer: typeof offers.$inferSelect;
    product: typeof products.$inferSelect;
    creativeId: string | null;
    creativeTemplate: string | null;
    createdBy: string;
  },
): Promise<{ url: string; creativeId: string } | null> {
  if (input.creativeId) {
    const [row] = await deps.db.select().from(creatives).where(eq(creatives.id, input.creativeId));
    if (row) {
      const stale = row.origin === "template" && row.renderedPrice !== input.offer.price;
      if (!stale) {
        const variants = (await variantsOf(deps.db, [row.id])).get(row.id) ?? [];
        const v = variants.find((x) => x.v.format === "wa_image") ?? variants[0];
        if (v) return { url: await externalMediaUrl(deps, v.asset), creativeId: row.id };
      }
      if (stale && row.templateKey && row.templateKey in CREATIVE_TEMPLATES) {
        input = { ...input, creativeTemplate: row.templateKey };
      }
    }
  }
  if (input.creativeTemplate && input.creativeTemplate in CREATIVE_TEMPLATES) {
    const { row, variants } = await renderOfferCreative(deps, deps.db, {
      offer: input.offer,
      product: input.product,
      template: input.creativeTemplate as CreativeTemplateKey,
      formats: ["wa_image"],
      params: {},
      createdBy: input.createdBy,
    });
    const v = variants[0];
    if (v) return { url: await externalMediaUrl(deps, v.asset), creativeId: row.id };
  }
  return null;
}

// ── Remoção ─────────────────────────────────────────────────────

/**
 * Remove um criativo e seus arquivos. Posts agendados que usavam o criativo passam a gerar
 * o card na hora (ou usar a foto do produto).
 */
export async function deleteCreative(ctx: Ctx, id: string, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  const res = await runMutation(ctx, {
    action: "creatives.delete",
    scope: "creatives:write",
    input: { id },
    opts,
    target: (i) => ({ type: "creative", id: i.id }),
    preview: async (c, i) => {
      const row = await loadCreative(c.db, wsId, i.id);
      const variants = (await variantsOf(c.db, [row.id])).get(row.id) ?? [];
      const assetIds = variants
        .flatMap(({ v }) => [v.assetId, v.previewAssetId ?? ""])
        .filter(Boolean);
      const files = assetIds.length
        ? await c.db
            .select({ id: assets.id, key: assets.storageKey })
            .from(assets)
            .where(inArray(assets.id, assetIds))
        : [];
      return { id: row.id, title: row.title, files };
    },
    execute: async (tx, _i, p) => {
      await tx.db.delete(creatives).where(eq(creatives.id, p.id));
      if (p.files.length) {
        await tx.db.delete(assets).where(
          inArray(
            assets.id,
            p.files.map((f) => f.id),
          ),
        );
      }
      return { id: p.id, deleted: true as const, files: p.files.map((f) => f.key) };
    },
  });
  if (res.status === "done") {
    // Arquivos saem depois do banco: se falhar, só sobra arquivo órfão (não quebra nada).
    await Promise.all(res.result.files.map((k) => ctx.storage.delete(k).catch(() => undefined)));
    return { status: "done" as const, result: { id: res.result.id, deleted: true as const } };
  }
  return res;
}
