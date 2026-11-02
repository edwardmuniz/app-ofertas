import { amazonImages } from "@ofertas/connectors";
import {
  type Content,
  type ContentKit,
  ContentKitQuery,
  CreateContentInput,
  ListContentsQuery,
  MarkContentPostedInput,
  ReviewContentInput,
  SubmitVideoInput,
  UpdateContentInput,
} from "@ofertas/contracts";
import {
  assets,
  contents,
  type DbOrTx,
  offers,
  products,
  storefronts,
  uploads,
  workspaces,
} from "@ofertas/db";
import {
  type BrandKit,
  inspectImage,
  inspectVideo,
  renderStudioFrames,
  type StudioItem,
} from "@ofertas/render";
import { and, desc, eq, gte, ilike, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now, systemActor } from "./context";
import { mediaUrl, readBrandKit, storeAsset } from "./creatives";
import { AppError } from "./errors";
import { type MutationOptions, runMutation } from "./mutation";
import { storefrontUrl } from "./storefront";
import { offerVars } from "./templates";
import { localDate } from "./tz";

type Row = typeof contents.$inferSelect;
type MediaDeps = Pick<Deps, "secrets" | "publicApiUrl">;

const DEFAULT_OUTRO = "Entre no grupo e receba ofertas assim todo dia";
const DEFAULT_TAGS = ["achadinhos", "ofertas", "promocao", "achadosdodia", "economia"];
const RECENT_DAYS = 3;
const OFFER_WINDOW_DAYS = 7;

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });

/** Avisos antes de aprovar ou postar: oferta que saiu ou mudou de preço desde que o conteúdo foi feito. */
async function offerWarnings(db: DbOrTx, r: Row): Promise<string[]> {
  if (!["pending_review", "ready"].includes(r.status) || r.offerIds.length === 0) return [];
  const rows = await loadOffers(db, r.workspaceId, r.offerIds);
  const byId = new Map(rows.map((x) => [x.offer.id, x]));
  const out: string[] = [];
  for (const id of r.offerIds) {
    const x = byId.get(id);
    const name = x ? x.product.title.slice(0, 50) : "Uma oferta";
    if (x?.offer.status !== "approved") {
      out.push(`${name}: não está mais aprovada (expirou ou foi removida).`);
      continue;
    }
    const before = r.offerPrices[id];
    if (before && Math.abs(before - x.offer.price) >= 0.01) {
      out.push(`${name}: preço mudou de ${brl(before)} para ${brl(x.offer.price)}.`);
    }
  }
  return out;
}

async function toContent(deps: MediaDeps, db: DbOrTx, r: Row): Promise<Content> {
  const ids = [...r.assetIds, ...(r.coverAssetId ? [r.coverAssetId] : [])];
  const files = ids.length ? await db.select().from(assets).where(inArray(assets.id, ids)) : [];
  const byId = new Map(files.map((a) => [a.id, a]));
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    title: r.title,
    hook: r.hook,
    subhook: r.subhook,
    outro: r.outro,
    caption: r.caption,
    hashtags: r.hashtags,
    offer_ids: r.offerIds,
    files: r.assetIds
      .map((id) => byId.get(id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .map((a) => ({
        url: mediaUrl(deps, a.id),
        mime: a.mime,
        width: a.width ?? 0,
        height: a.height ?? 0,
      })),
    cover_url: r.coverAssetId ? mediaUrl(deps, r.coverAssetId) : null,
    seconds: r.seconds,
    error: r.error,
    review_note: r.reviewNote,
    warnings: await offerWarnings(db, r),
    reviewed_at: r.reviewedAt?.toISOString() ?? null,
    posted_to: r.postedTo,
    posted_at: r.postedAt?.toISOString() ?? null,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
  };
}

async function brandOf(db: DbOrTx, workspaceId: string, redirectBaseUrl: string) {
  const [sf] = await db.select().from(storefronts).where(eq(storefronts.workspaceId, workspaceId));
  const kit = await readBrandKit(db, workspaceId);
  return {
    kit: { ...kit, name: sf?.title ?? kit.name },
    storefront: sf?.active ? storefrontUrl({ redirectBaseUrl }, sf.slug) : null,
    logo: sf?.avatarUrl ?? null,
  };
}

/** Ofertas usadas em conteúdos dos últimos dias (para variar). */
async function recentlyUsed(db: DbOrTx, workspaceId: string, at: Date) {
  const rows = await db
    .select({ ids: contents.offerIds })
    .from(contents)
    .where(
      and(
        eq(contents.workspaceId, workspaceId),
        gte(contents.createdAt, new Date(at.getTime() - RECENT_DAYS * 86_400_000)),
        notInArray(contents.status, ["rejected", "failed"]),
      ),
    );
  return new Set(rows.flatMap((r) => r.ids));
}

// ── Kit do dia ──────────────────────────────────────────────────

/** Matéria-prima para o agente montar conteúdo: ofertas aprovadas com fotos, preços e o link da bio. */
export async function getContentKit(ctx: Ctx, raw: ContentKitQuery = {}): Promise<ContentKit> {
  requireScope(ctx.actor, "growth:read");
  const q = ContentKitQuery.parse(raw);
  const wsId = ctx.actor.workspaceId;
  const at = now(ctx);
  const conds = [
    eq(offers.workspaceId, wsId),
    eq(offers.status, "approved"),
    isNotNull(offers.affiliateUrl),
    gte(offers.createdAt, new Date(at.getTime() - OFFER_WINDOW_DAYS * 86_400_000)),
  ];
  if (q.max_price) conds.push(lte(offers.price, q.max_price));
  if (q.min_discount) conds.push(gte(offers.discountPct, q.min_discount));
  if (q.platform) conds.push(eq(products.platform, q.platform));
  if (q.q) conds.push(ilike(products.title, `%${q.q.replace(/[%_\\]/g, "\\$&")}%`));
  const rows = await ctx.db
    .select({ offer: offers, product: products })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(and(...conds))
    .orderBy(desc(offers.score), desc(offers.createdAt))
    .limit(q.limit * 2);
  const used = await recentlyUsed(ctx.db, wsId, at);
  // Ofertas ainda não usadas primeiro.
  const sorted = [
    ...rows.filter((r) => !used.has(r.offer.id)),
    ...rows.filter((r) => used.has(r.offer.id)),
  ];
  const { kit, storefront, logo } = await brandOf(ctx.db, wsId, ctx.redirectBaseUrl);
  return {
    brand: kit.name,
    storefront_url: storefront,
    offers: sorted.slice(0, q.limit).map(({ offer: o, product: p }) => {
      const v = offerVars(o, p, "");
      return {
        offer_id: o.id,
        title: p.title,
        platform: v.plataforma ?? p.platform,
        category: p.categoryName,
        price: o.price,
        original_price: o.originalPrice,
        discount_pct: o.discountPct,
        pix_price: o.priceDetails?.pix_price ?? null,
        installments: v.parcelas ?? null,
        image_urls: p.imageUrls,
        score: o.score,
        recently_used: used.has(o.id),
      };
    }),
    tips: [
      "3 a 5 ofertas por conteúdo, com um tema que dê vontade de ver até o fim (ex.: achadinhos de cozinha até R$ 100).",
      "A frase de abertura aparece nos 2 primeiros segundos: seja específico (número + tema + preço).",
      "Na legenda: chamada, a lista curta das ofertas e 'link na bio para entrar no grupo'. Não coloque links (as redes escondem).",
      storefront
        ? `Termine com o endereço da vitrine: ${storefront.replace(/^https?:\/\//, "")}.`
        : "Crie a vitrine (update_storefront) para o conteúdo terminar com o endereço da bio.",
    ],
    video_brief: videoBrief(kit, storefront, logo),
  };
}

// ── Vídeo feito pelo agente local ───────────────────────────────

/** Formato aceito no envio do vídeo (submit_video). */
export const VIDEO_RULES = {
  width: 1080,
  height: 1920,
  fps: 30,
  min_seconds: 5,
  max_seconds: 90,
  max_mb: 100,
};
/** Margens que TikTok/Reels/Shorts cobrem com botões e legenda. */
const SAFE_AREA = { top: 180, bottom: 380, right: 160, left: 60 };

function videoBrief(
  kit: BrandKit,
  storefront: string | null,
  logo: string | null,
): ContentKit["video_brief"] {
  const handle = storefront ? storefront.replace(/^https?:\/\//, "") : null;
  const r = VIDEO_RULES;
  return {
    format: r,
    safe_area: SAFE_AREA,
    brand: {
      name: kit.name,
      primary_color: kit.primary_color,
      secondary_color: kit.secondary_color,
      text_color: kit.text_color,
      logo_url: logo,
      handle,
    },
    steps: [
      "Preparar (uma vez): Node.js 22+ e FFmpeg; confira com `npx hyperframes doctor`. No Claude Code, a skill ajuda: `claude plugin marketplace add heygen-com/hyperframes` e `claude plugin install hyperframes@hyperframes` (depois /reload-plugins).",
      "Projeto: `npx hyperframes init <pasta> --resolution portrait --non-interactive`. Baixe as fotos (image_urls) para assets/ da pasta; não dependa de endereços externos na renderização.",
      `Roteiro de 15 a 30 s: abertura de até 2 s com a frase (hook) grande; uma cena de 3 a 5 s por oferta com a foto em destaque, nome curto, preço (e o preço no Pix, se houver), preço riscado só quando original_price existir, desconto e loja; fechamento de 3 s com "Link na bio"${handle ? ` e ${handle}` : ""}.`,
      'Composição: raiz com data-composition-id, data-start="0", data-width="1080", data-height="1920" e data-duration; timeline GSAP pausada registrada em window.__timelines[<composition-id>]; anime transform e opacity; nada de repeat infinito, horário ou aleatório.',
      `Nada importante nas margens (px): topo ${SAFE_AREA.top}, base ${SAFE_AREA.bottom}, direita ${SAFE_AREA.right}, esquerda ${SAFE_AREA.left}. Use as cores da marca com bom contraste e texto grande (legível no celular sem som).`,
      "Sem áudio, ou só música livre de direitos (as redes colocam música no app). Não use vídeos das lojas nem de outros criadores. Preços exatamente como no kit.",
      "Conferir: `npx hyperframes lint` e `npx hyperframes check`; veja quadros com `npx hyperframes snapshot --at 1,5,10`.",
      `Renderizar: \`npx hyperframes render -q standard -o video.mp4\` (MP4 ${r.width}×${r.height}, ${r.min_seconds} a ${r.max_seconds} s, até ${r.max_mb} MB).`,
      "Enviar: request_upload (mime video/mp4, size_bytes exato) → PUT do arquivo com o curl devolvido → submit_video com upload_id, offer_ids na ordem, hook, legenda e hashtags. Capa opcional: PNG/JPEG por request_upload e cover_upload_id.",
      "O vídeo fica aguardando aprovação no painel (Audiência › Conteúdo). Se for recusado (status rejected), leia review_note, ajuste e envie outro.",
    ],
  };
}

// ── Criar ───────────────────────────────────────────────────────

function defaultCaption(hook: string, items: { title: string; price: string }[]) {
  const list = items
    .map(
      (it, i) =>
        `${i + 1}. ${it.title.length > 60 ? `${it.title.slice(0, 59).trimEnd()}…` : it.title} — ${it.price}`,
    )
    .join("\n");
  return `${hook}\n\n${list}\n\nLink na bio para entrar no grupo e receber ofertas assim todo dia.`;
}

const tagify = (tags: string[]) =>
  [
    ...new Set(
      tags.map((t) => t.replace(/^#/, "").replace(/\s+/g, "").toLowerCase()).filter(Boolean),
    ),
  ].slice(0, 20);

async function loadOffers(db: DbOrTx, workspaceId: string, ids: string[]) {
  const rows = await db
    .select({ offer: offers, product: products })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(and(eq(offers.workspaceId, workspaceId), inArray(offers.id, ids)));
  const byId = new Map(rows.map((r) => [r.offer.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
}

/** Cria um carrossel. A montagem roda no worker em segundos. */
export async function createContent(ctx: Ctx, raw: CreateContentInput, opts: MutationOptions = {}) {
  const input = CreateContentInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "growth.create_content",
    scope: "growth:write",
    input,
    opts,
    target: () => ({ type: "content", id: wsId }),
    preview: async (c, i) => {
      const ids = [...new Set(i.offer_ids)];
      const found = await loadOffers(c.db, wsId, ids);
      if (found.length !== ids.length) {
        throw new AppError("VALIDATION_ERROR", "Oferta não encontrada neste workspace.", {
          hint: "Use os offer_id de get_content_kit.",
        });
      }
      const expired = found.filter((r) => r.offer.status !== "approved");
      if (expired.length) {
        throw new AppError("VALIDATION_ERROR", "Só ofertas aprovadas entram no conteúdo.", {
          details: { offer_ids: expired.map((r) => r.offer.id) },
        });
      }
      const items = found.map((r) => ({
        title: r.product.title,
        price: offerVars(r.offer, r.product, "").preco ?? "",
      }));
      return {
        offer_ids: ids,
        offer_prices: Object.fromEntries(found.map((r) => [r.offer.id, r.offer.price])),
        title: i.title || i.hook,
        caption: i.caption || defaultCaption(i.hook, items),
        hashtags: tagify(i.hashtags?.length ? i.hashtags : DEFAULT_TAGS),
      };
    },
    execute: async (tx, i, p) => {
      const [row] = await tx.db
        .insert(contents)
        .values({
          workspaceId: wsId,
          kind: i.kind,
          title: p.title,
          hook: i.hook,
          subhook: i.subhook ?? null,
          outro: i.outro || DEFAULT_OUTRO,
          caption: p.caption,
          hashtags: p.hashtags,
          offerIds: p.offer_ids,
          offerPrices: p.offer_prices,
          createdBy: ctx.actor.label,
        })
        .returning();
      if (!row) throw new Error("Falha ao salvar o conteúdo");
      return toContent(ctx, tx.db, row);
    },
  });
}

async function loadRow(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(contents)
    .where(and(eq(contents.id, id), eq(contents.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Conteúdo não encontrado.");
  return row;
}

export async function getContent(ctx: Ctx, id: string) {
  requireScope(ctx.actor, "growth:read");
  return toContent(ctx, ctx.db, await loadRow(ctx.db, ctx.actor.workspaceId, id));
}

export async function listContents(ctx: Ctx, raw: ListContentsQuery = {}) {
  requireScope(ctx.actor, "growth:read");
  const q = ListContentsQuery.parse(raw);
  const conds = [eq(contents.workspaceId, ctx.actor.workspaceId)];
  if (q.status) conds.push(eq(contents.status, q.status));
  if (q.posted === "yes") conds.push(sql`jsonb_array_length(${contents.postedTo}) > 0`);
  if (q.posted === "no") conds.push(sql`jsonb_array_length(${contents.postedTo}) = 0`);
  const rows = await ctx.db
    .select()
    .from(contents)
    .where(and(...conds))
    .orderBy(desc(contents.createdAt))
    .limit(q.limit);
  return Promise.all(rows.map((r) => toContent(ctx, ctx.db, r)));
}

export async function updateContent(
  ctx: Ctx,
  id: string,
  raw: UpdateContentInput,
  opts: MutationOptions = {},
) {
  const input = UpdateContentInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "growth.update_content",
    scope: "growth:write",
    input: { id, ...input },
    opts,
    target: () => ({ type: "content", id }),
    preview: async (c) => ({ before: await toContent(ctx, c.db, await loadRow(c.db, wsId, id)) }),
    execute: async (tx, i) => {
      const [row] = await tx.db
        .update(contents)
        .set({
          ...(i.title !== undefined && { title: i.title }),
          ...(i.caption !== undefined && { caption: i.caption }),
          ...(i.hashtags !== undefined && { hashtags: tagify(i.hashtags) }),
        })
        .where(and(eq(contents.id, id), eq(contents.workspaceId, wsId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Conteúdo não encontrado.");
      return toContent(ctx, tx.db, row);
    },
  });
}

/** Registra onde o conteúdo foi postado (acumula as redes). */
export async function markContentPosted(
  ctx: Ctx,
  id: string,
  raw: MarkContentPostedInput,
  opts: MutationOptions = {},
) {
  const input = MarkContentPostedInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "growth.mark_content_posted",
    scope: "growth:write",
    input: { id, ...input },
    opts,
    target: () => ({ type: "content", id }),
    preview: async (c) => {
      const row = await loadRow(c.db, wsId, id);
      if (row.status !== "ready") {
        throw new AppError("CONFLICT", "O conteúdo ainda não está pronto.", {
          hint:
            row.status === "pending_review"
              ? "Aprove no painel antes de postar."
              : "Só conteúdos prontos (aprovados) podem ser marcados como postados.",
        });
      }
      const asked = input.platforms.map((p) => p.toLowerCase());
      const platforms = input.undo
        ? row.postedTo.filter((p) => !asked.includes(p))
        : [...new Set([...row.postedTo, ...asked])];
      return { platforms };
    },
    execute: async (tx, _i, p) => {
      const [row] = await tx.db
        .update(contents)
        .set({ postedTo: p.platforms, postedAt: p.platforms.length ? now(ctx) : null })
        .where(and(eq(contents.id, id), eq(contents.workspaceId, wsId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Conteúdo não encontrado.");
      return toContent(ctx, tx.db, row);
    },
  });
}

/** Exclui o conteúdo e os arquivos dele (vídeo, imagens e capa). */
export async function deleteContent(ctx: Ctx, id: string, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  const res = await runMutation(ctx, {
    action: "growth.delete_content",
    scope: "growth:write",
    input: { id },
    opts,
    target: () => ({ type: "content", id }),
    preview: async (c) => {
      const row = await loadRow(c.db, wsId, id);
      if (row.status === "rendering") {
        throw new AppError("CONFLICT", "Espere terminar de montar para excluir.");
      }
      const ids = [...row.assetIds, ...(row.coverAssetId ? [row.coverAssetId] : [])];
      const files = ids.length
        ? await c.db
            .select({ id: assets.id, key: assets.storageKey })
            .from(assets)
            .where(and(eq(assets.workspaceId, wsId), inArray(assets.id, ids)))
        : [];
      return { id: row.id, title: row.title, files };
    },
    execute: async (tx, _i, p) => {
      await tx.db.delete(contents).where(and(eq(contents.id, id), eq(contents.workspaceId, wsId)));
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
    // Arquivos saem depois do banco: se falhar, só sobra arquivo órfão.
    await Promise.all(res.result.files.map((k) => ctx.storage.delete(k).catch(() => undefined)));
    return { status: "done" as const, result: { id: res.result.id, deleted: true as const } };
  }
  return res;
}

// ── Montagem (worker) ───────────────────────────────────────────

/** WebP do Mercado Livre → JPEG (o desenho não lê WebP). */
const jpegUrl = (url: string) =>
  /mlstatic\.com/.test(url) ? url.replace(/\.webp(\?.*)?$/i, ".jpg") : url;

async function dataUrl(deps: Pick<Deps, "fetchMedia">, url: string) {
  try {
    const { data } = await deps.fetchMedia(jpegUrl(url));
    const meta = inspectImage(data);
    if (!meta || meta.mime === "image/webp") return null;
    return `data:${meta.mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Fotos do produto: as salvas e, na Amazon com uma só, a galeria da página. */
async function productPhotos(
  deps: Pick<Deps, "fetchMedia" | "fetchPage">,
  product: typeof products.$inferSelect,
  max: number,
) {
  let urls = product.imageUrls;
  if (product.platform === "amazon" && urls.length < 2 && max > 1) {
    try {
      const page = await deps.fetchPage(product.url);
      const gallery = amazonImages(page.html, 4);
      if (gallery.length) urls = [...new Set([...gallery, ...urls])];
    } catch {
      // sem galeria: segue com a foto salva
    }
  }
  const out: string[] = [];
  for (const u of urls) {
    if (out.length >= max) break;
    const d = await dataUrl(deps, u);
    if (d) out.push(d);
  }
  return out;
}

/** Recebe o vídeo feito pelo agente local e deixa aguardando aprovação no painel. */
export async function submitVideo(ctx: Ctx, raw: SubmitVideoInput, opts: MutationOptions = {}) {
  const input = SubmitVideoInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "growth.submit_video",
    scope: "growth:write",
    input,
    opts,
    target: (i) => ({ type: "upload", id: i.upload_id }),
    preview: async (c, i) => {
      const video = await uploadedAsset(c.db, wsId, i.upload_id, "video");
      const data = await ctx.storage.get(video.storageKey);
      const meta = data ? inspectVideo(data) : null;
      if (!meta) throw new AppError("VALIDATION_ERROR", "O arquivo enviado não é um MP4 válido.");
      if (meta.codec && !/^avc[13]$/.test(meta.codec)) {
        throw new AppError("VALIDATION_ERROR", "O vídeo precisa estar em H.264.", {
          hint: "As redes e o navegador do painel tocam H.264. Renderize de novo com o padrão do HyperFrames (libx264).",
          details: { codec: meta.codec },
        });
      }
      const ratio = meta.height / meta.width;
      if (ratio < 1.7 || ratio > 1.82 || meta.width < 720) {
        throw new AppError("VALIDATION_ERROR", "O vídeo precisa ser vertical 9:16.", {
          hint: `Renderize em ${VIDEO_RULES.width}×${VIDEO_RULES.height}.`,
          details: { width: meta.width, height: meta.height },
        });
      }
      if (meta.seconds < VIDEO_RULES.min_seconds || meta.seconds > VIDEO_RULES.max_seconds) {
        throw new AppError(
          "VALIDATION_ERROR",
          `O vídeo precisa ter de ${VIDEO_RULES.min_seconds} a ${VIDEO_RULES.max_seconds} segundos.`,
          { details: { seconds: meta.seconds } },
        );
      }
      const cover = i.cover_upload_id
        ? await uploadedAsset(c.db, wsId, i.cover_upload_id, "image")
        : null;
      const ids = [...new Set(i.offer_ids)];
      const found = await loadOffers(c.db, wsId, ids);
      if (found.length !== ids.length) {
        throw new AppError("VALIDATION_ERROR", "Oferta não encontrada neste workspace.", {
          hint: "Use os offer_id de get_content_kit.",
        });
      }
      const items = found.map((r) => ({
        title: r.product.title,
        price: offerVars(r.offer, r.product, "").preco ?? "",
      }));
      return {
        video_asset_id: video.id,
        cover_asset_id: cover?.id ?? null,
        seconds: meta.seconds,
        offer_ids: ids,
        offer_prices: Object.fromEntries(found.map((r) => [r.offer.id, r.offer.price])),
        title: i.title || i.hook,
        caption: i.caption || defaultCaption(i.hook, items),
        hashtags: tagify(i.hashtags?.length ? i.hashtags : DEFAULT_TAGS),
      };
    },
    execute: async (tx, i, p) => {
      const used = [i.upload_id, ...(i.cover_upload_id ? [i.cover_upload_id] : [])];
      await tx.db
        .update(uploads)
        .set({ status: "completed" })
        .where(and(eq(uploads.workspaceId, wsId), inArray(uploads.id, used)));
      const [row] = await tx.db
        .insert(contents)
        .values({
          workspaceId: wsId,
          kind: "video",
          status: "pending_review",
          title: p.title,
          hook: i.hook,
          outro: DEFAULT_OUTRO,
          caption: p.caption,
          hashtags: p.hashtags,
          offerIds: p.offer_ids,
          offerPrices: p.offer_prices,
          assetIds: [p.video_asset_id],
          coverAssetId: p.cover_asset_id,
          seconds: p.seconds,
          createdBy: ctx.actor.label,
        })
        .returning();
      if (!row) throw new Error("Falha ao salvar o vídeo");
      return toContent(ctx, tx.db, row);
    },
  });
}

async function uploadedAsset(
  db: DbOrTx,
  workspaceId: string,
  uploadId: string,
  kind: "video" | "image",
) {
  const [up] = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.workspaceId, workspaceId)));
  if (!up) throw new AppError("NOT_FOUND", "Upload não encontrado.");
  if (up.status === "pending") {
    throw new AppError("CONFLICT", "O arquivo ainda não foi enviado.", {
      hint: "Faça o PUT do arquivo na put_url antes.",
    });
  }
  if (up.status === "completed") {
    const [used] = up.assetId
      ? await db
          .select({ id: contents.id })
          .from(contents)
          .where(
            and(
              eq(contents.workspaceId, workspaceId),
              sql`${contents.assetIds} @> ${JSON.stringify([up.assetId])}::jsonb`,
            ),
          )
      : [];
    throw new AppError("CONFLICT", "Este upload já foi usado.", {
      hint: used
        ? `Já virou o conteúdo ${used.id} (veja com get_content); não precisa enviar de novo.`
        : "Peça um novo link com request_upload.",
      details: used ? { content_id: used.id } : undefined,
    });
  }
  if ((up.mime === "video/mp4") !== (kind === "video")) {
    throw new AppError(
      "VALIDATION_ERROR",
      kind === "video" ? "Este upload não é um vídeo MP4." : "A capa precisa ser uma imagem.",
    );
  }
  const [asset] = up.assetId ? await db.select().from(assets).where(eq(assets.id, up.assetId)) : [];
  if (!asset) throw new AppError("NOT_FOUND", "Arquivo do upload não encontrado.");
  return asset;
}

/**
 * Aprova (fica pronto para postar) ou recusa (com o motivo) um conteúdo. Só por pessoa.
 * Dá para mudar de ideia: recusar um aprovado ou aprovar um recusado.
 */
export async function reviewContent(
  ctx: Ctx,
  id: string,
  raw: ReviewContentInput,
  opts: MutationOptions = {},
) {
  const input = ReviewContentInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  if (ctx.actor.type !== "user") {
    throw new AppError("FORBIDDEN", "A aprovação de vídeos é feita por uma pessoa, no painel.", {
      hint: "Peça para o usuário aprovar em Audiência › Conteúdo.",
    });
  }
  return runMutation(ctx, {
    action: "growth.review_content",
    scope: "growth:write",
    input: { id, ...input },
    opts,
    target: () => ({ type: "content", id }),
    preview: async (c, i) => {
      const row = await loadRow(c.db, wsId, id);
      const from: Row["status"][] =
        i.decision === "approve" ? ["pending_review", "rejected"] : ["pending_review", "ready"];
      if (!from.includes(row.status)) {
        throw new AppError(
          "CONFLICT",
          i.decision === "approve"
            ? "Só dá para aprovar o que está aguardando aprovação ou foi recusado."
            : "Só dá para recusar o que está aguardando aprovação ou pronto.",
          { details: { status: row.status } },
        );
      }
      return { before: row.status };
    },
    execute: async (tx, i) => {
      const [row] = await tx.db
        .update(contents)
        .set({
          status: i.decision === "approve" ? "ready" : "rejected",
          reviewNote: i.note || null,
          reviewedAt: now(ctx),
          reviewedBy: ctx.actor.label,
        })
        .where(and(eq(contents.id, id), eq(contents.workspaceId, wsId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Conteúdo não encontrado.");
      return toContent(ctx, tx.db, row);
    },
  });
}

async function renderOne(deps: Deps, row: Row) {
  const found = await loadOffers(deps.db, row.workspaceId, row.offerIds);
  if (found.length === 0) throw new Error("As ofertas deste conteúdo não existem mais.");
  // Vídeo vem pronto do agente local (spec 18); o servidor só monta carrossel.
  if (row.kind !== "carousel") throw new Error("Vídeo não é montado no servidor.");
  const { kit, storefront } = await brandOf(deps.db, row.workspaceId, deps.redirectBaseUrl);
  const items: StudioItem[] = [];
  for (const { offer, product } of found) {
    const v = offerVars(offer, product, "");
    items.push({
      title: product.title,
      price: v.preco ?? "",
      originalPrice: v.preco_original ?? null,
      discountPct: offer.discountPct,
      pixPrice: v.preco_pix ?? null,
      installments: v.parcelas ?? null,
      platform: v.plataforma ?? product.platform,
      images: await productPhotos(deps, product, 1),
    });
  }
  const frames = await renderStudioFrames(
    {
      hook: row.hook,
      subhook: row.subhook,
      outro: row.outro,
      handle: storefront ? storefront.replace(/^https?:\/\//, "") : null,
      items,
    },
    kit,
    "carousel",
  );
  const first = frames[0];
  if (!first) throw new Error("Nenhum quadro gerado.");
  const cover = await storeAsset(
    deps,
    deps.db,
    row.workspaceId,
    first.png,
    { mime: "image/png", width: 1080, height: 1350 },
    "render",
  );
  const ids = [cover.id];
  for (const f of frames.slice(1)) {
    const a = await storeAsset(
      deps,
      deps.db,
      row.workspaceId,
      f.png,
      { mime: "image/png", width: 1080, height: 1350 },
      "render",
    );
    ids.push(a.id);
  }
  return { assetIds: ids, coverAssetId: cover.id, seconds: null };
}

/** Monta os carrosséis na fila. Roda no worker. */
export async function renderPendingContents(deps: Deps, opts: { limit?: number } = {}) {
  const results: { id: string; status: "ready" | "failed"; error?: string }[] = [];
  const rows = await deps.db
    .select()
    .from(contents)
    .where(eq(contents.status, "queued"))
    .orderBy(contents.createdAt)
    .limit(opts.limit ?? 3);
  for (const row of rows) {
    // Reserva o conteúdo (outro worker não pega o mesmo).
    const [claimed] = await deps.db
      .update(contents)
      .set({ status: "rendering", attempts: row.attempts + 1 })
      .where(and(eq(contents.id, row.id), eq(contents.status, "queued")))
      .returning();
    if (!claimed) continue;
    try {
      const out = await renderOne(deps, claimed);
      await deps.db
        .update(contents)
        .set({ status: "ready", error: null, ...out })
        .where(eq(contents.id, row.id));
      results.push({ id: row.id, status: "ready" });
    } catch (err) {
      const message = String((err as Error).message ?? err).slice(0, 500);
      // Até 3 tentativas: falha passageira (foto que não abriu) volta para a fila.
      const retry = claimed.attempts < 3;
      await deps.db
        .update(contents)
        .set({ status: retry ? "queued" : "failed", error: message })
        .where(eq(contents.id, row.id));
      results.push({ id: row.id, status: "failed", error: message });
    }
  }
  return results;
}

// ── Conteúdo diário automático ──────────────────────────────────

/**
 * Preferência `studio_daily`: a partir das 8h (fuso do workspace), monta um carrossel com as melhores
 * ofertas aprovadas que ainda não entraram em conteúdo nos últimos dias. Uma vez por dia.
 */
export async function runDailyStudio(deps: Deps) {
  const created: string[] = [];
  const list = await deps.db
    .select({ id: workspaces.id, tz: workspaces.timezone })
    .from(workspaces)
    .where(sql`(${workspaces.settings} -> 'preferences' ->> 'studio_daily') = 'true'`);
  const at = now(deps);
  for (const ws of list) {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: ws.tz,
      }).format(at),
    );
    if (hour < 8) continue;
    const key = `studio:daily:${ws.id}:${localDate(at, ws.tz)}`;
    if (!(await deps.cache.setIfAbsent(key, "1", 2 * 86_400))) continue;
    const ctx: Ctx = { ...deps, actor: systemActor(ws.id, "studio") };
    const kit = await getContentKit(ctx, { limit: 5 });
    const fresh = kit.offers.filter((o) => !o.recently_used);
    const picks = (fresh.length >= 3 ? fresh : kit.offers).slice(0, 5);
    if (picks.length < 2) continue;
    const res = await createContent(
      ctx,
      {
        kind: "carousel",
        offer_ids: picks.map((o) => o.offer_id),
        title: "Achadinhos do dia",
        hook: `${picks.length} achadinhos de hoje com desconto`,
      },
      { reason: "Conteúdo diário automático" },
    );
    if (res.status === "done" && res.result) created.push(res.result.id);
  }
  return created;
}
