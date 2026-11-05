import {
  ListStoreCouponsQuery,
  type StoreCoupon,
  UpsertStoreCouponInput,
} from "@ofertas/contracts";
import { type DbOrTx, posts, storeCoupons } from "@ofertas/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activeAccounts, connectorFor } from "./affiliates";
import { requireScope } from "./authz";
import { type Ctx, now } from "./context";
import { AppError } from "./errors";
import { type MutationOptions, runMutation } from "./mutation";
import { PLATFORM_NAMES } from "./templates";

type CouponRow = typeof storeCoupons.$inferSelect;

/** Ativo e dentro da validade: pode ser divulgado. */
export function couponIsLive(c: Pick<CouponRow, "status" | "validUntil">, at: Date = new Date()) {
  return c.status === "active" && (!c.validUntil || c.validUntil.getTime() > at.getTime());
}

const toCoupon = (r: CouponRow, sent: number): StoreCoupon => ({
  id: r.id,
  platform: r.platform,
  title: r.title,
  code: r.code,
  details: r.details,
  url: r.url,
  affiliate_url: r.affiliateUrl,
  image_url: r.imageUrl,
  valid_until: r.validUntil?.toISOString() ?? null,
  status: r.status,
  active: couponIsLive(r),
  posts_sent: sent,
  created_at: r.createdAt.toISOString(),
});

/** "05/11 às 23:59" no fuso do workspace. */
function untilText(d: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month} às ${p.hour}:${p.minute}`;
}

/** Mensagem do post de cupom: loja, chamada, regras, código (ou "resgate no link"), validade e link. */
export function couponMessage(c: CouponRow, link: string, tz = "America/Sao_Paulo") {
  const store = PLATFORM_NAMES[c.platform] ?? c.platform;
  return [
    `🎟️ *CUPOM ${store.toUpperCase()}*`,
    "",
    `*${c.title}*`,
    c.details,
    "",
    c.code ? `Código: *${c.code}*` : "👉 Resgate o cupom no link antes de comprar",
    c.validUntil ? `⏰ Válido até ${untilText(c.validUntil, tz)}` : null,
    "",
    link,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function loadCoupons(db: DbOrTx, workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  return db
    .select()
    .from(storeCoupons)
    .where(and(eq(storeCoupons.workspaceId, workspaceId), inArray(storeCoupons.id, ids)));
}

async function getCouponRow(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await loadCoupons(db, workspaceId, [id]);
  if (!row) throw new AppError("NOT_FOUND", "Cupom não encontrado.", { details: { id } });
  return row;
}

async function sentCounts(db: DbOrTx, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db
    .select({ id: posts.couponId, n: sql<number>`count(*)::int` })
    .from(posts)
    .where(and(inArray(posts.couponId, ids), eq(posts.status, "sent")))
    .groupBy(posts.couponId);
  return new Map(rows.map((r) => [r.id ?? "", r.n]));
}

export async function listStoreCoupons(ctx: Ctx, raw: ListStoreCouponsQuery = {}) {
  requireScope(ctx.actor, "offers:read");
  const q = ListStoreCouponsQuery.parse(raw);
  const rows = await ctx.db
    .select()
    .from(storeCoupons)
    .where(eq(storeCoupons.workspaceId, ctx.actor.workspaceId))
    .orderBy(desc(storeCoupons.createdAt))
    .limit(200);
  const list = q.status === "active" ? rows.filter((r) => couponIsLive(r, now(ctx))) : rows;
  const sent = await sentCounts(
    ctx.db,
    list.map((r) => r.id),
  );
  return list.map((r) => toCoupon(r, sent.get(r.id) ?? 0));
}

/**
 * Link com a sua afiliação para a página do cupom, pela conta da loja (Shopee: link curto com
 * sub-id "cupom"; Amazon: `?tag=`). Sem conta ou se a loja recusar, fica o endereço colado.
 */
async function affiliateUrlFor(ctx: Ctx, platform: CouponRow["platform"], url: string) {
  for (const account of await activeAccounts(ctx.db, ctx.actor.workspaceId, [platform])) {
    try {
      const connector = connectorFor(ctx, account);
      if (!connector.capabilities.linkGeneration) continue;
      return await connector.generateLink(url, ["cupom"]);
    } catch {
      // Tenta a próxima conta da loja, ou fica sem afiliação.
    }
  }
  return null;
}

/** Cria ou edita um cupom da loja inteira. */
export async function upsertStoreCoupon(
  ctx: Ctx,
  raw: UpsertStoreCouponInput,
  opts: MutationOptions = {},
) {
  const input = UpsertStoreCouponInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: input.id ? "coupons.update" : "coupons.create",
    scope: "offers:write",
    input,
    opts,
    target: (i) => ({ type: "store_coupon", id: i.id }),
    preview: async (c, i) => {
      const before = i.id ? await getCouponRow(c.db, wsId, i.id) : null;
      const validUntil = i.valid_until ? new Date(i.valid_until) : null;
      if (validUntil && validUntil.getTime() <= now(c).getTime()) {
        throw new AppError("VALIDATION_ERROR", "A validade do cupom já passou.", {
          hint: "Informe uma data futura ou deixe sem prazo.",
        });
      }
      return {
        id: before?.id ?? null,
        platform: i.platform,
        title: i.title,
        code: i.code ? i.code.toUpperCase() : null,
        details: i.details || null,
        url: i.url,
        image_url: i.image_url ?? null,
        valid_until: validUntil?.toISOString() ?? null,
        // Mesmo endereço e loja: reaproveita o link de afiliado já gerado.
        reuse_affiliate:
          before && before.url === i.url && before.platform === i.platform
            ? before.affiliateUrl
            : null,
      };
    },
    execute: async (tx, _i, p) => {
      const affiliateUrl = p.reuse_affiliate ?? (await affiliateUrlFor(ctx, p.platform, p.url));
      const values = {
        platform: p.platform,
        title: p.title,
        code: p.code,
        details: p.details,
        url: p.url,
        affiliateUrl,
        imageUrl: p.image_url,
        validUntil: p.valid_until ? new Date(p.valid_until) : null,
        status: "active" as const,
      };
      const [row] = p.id
        ? await tx.db
            .update(storeCoupons)
            .set(values)
            .where(and(eq(storeCoupons.id, p.id), eq(storeCoupons.workspaceId, wsId)))
            .returning()
        : await tx.db
            .insert(storeCoupons)
            .values({ ...values, workspaceId: wsId, createdBy: ctx.actor.label })
            .returning();
      if (!row) throw new AppError("NOT_FOUND", "Cupom não encontrado.");
      const sent = await sentCounts(tx.db, [row.id]);
      return toCoupon(row, sent.get(row.id) ?? 0);
    },
  });
}

/** Apaga o cupom e cancela os envios dele que ainda estão agendados. */
export async function deleteStoreCoupon(ctx: Ctx, id: string, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "coupons.delete",
    scope: "offers:write",
    input: { id },
    opts,
    target: () => ({ type: "store_coupon", id }),
    preview: async (c) => {
      const row = await getCouponRow(c.db, wsId, id);
      const [pending] = await c.db
        .select({ n: sql<number>`count(*)::int` })
        .from(posts)
        .where(and(eq(posts.couponId, id), eq(posts.status, "scheduled")));
      return { id: row.id, title: row.title, scheduled_posts_canceled: pending?.n ?? 0 };
    },
    execute: async (tx, _i, p) => {
      await tx.db
        .update(posts)
        .set({ status: "canceled" })
        .where(and(eq(posts.couponId, id), eq(posts.status, "scheduled")));
      await tx.db
        .delete(storeCoupons)
        .where(and(eq(storeCoupons.id, id), eq(storeCoupons.workspaceId, wsId)));
      return { deleted: true as const, scheduled_posts_canceled: p.scheduled_posts_canceled };
    },
  });
}
