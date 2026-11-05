import type { QUALITY_FLAGS } from "@ofertas/contracts";
import { type DbOrTx, pricePoints } from "@ofertas/db";
import { and, gte, inArray, sql } from "drizzle-orm";

export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export type PriceSummary = {
  min_30d: number | null;
  median_30d: number | null;
  min_90d: number | null;
  points: number;
  /** Dias entre a observação mais antiga e agora */
  span_days: number;
};

const DAY_MS = 86_400_000;
const EMPTY: PriceSummary = {
  min_30d: null,
  median_30d: null,
  min_90d: null,
  points: 0,
  span_days: 0,
};

/** Resumo do histórico de preço (30 e 90 dias) de vários produtos. */
export async function priceSummaries(db: DbOrTx, productIds: string[], at: Date) {
  const map = new Map<string, PriceSummary>();
  if (productIds.length === 0) return map;
  const d30 = new Date(at.getTime() - 30 * DAY_MS);
  const d90 = new Date(at.getTime() - 90 * DAY_MS);
  const in30 = sql`${pricePoints.capturedAt} >= ${d30.toISOString()}`;
  const rows = await db
    .select({
      productId: pricePoints.productId,
      min30: sql<string | null>`min(${pricePoints.price}) filter (where ${in30})`,
      median30: sql<
        string | null
      >`percentile_cont(0.5) within group (order by ${pricePoints.price}) filter (where ${in30})`,
      min90: sql<string | null>`min(${pricePoints.price})`,
      points: sql<number>`count(*)::int`,
      firstAt: sql<Date>`min(${pricePoints.capturedAt})`,
    })
    .from(pricePoints)
    .where(and(inArray(pricePoints.productId, productIds), gte(pricePoints.capturedAt, d90)))
    .groupBy(pricePoints.productId);
  for (const r of rows) {
    const first = new Date(r.firstAt);
    map.set(r.productId, {
      min_30d: r.min30 === null ? null : Number(r.min30),
      median_30d: r.median30 === null ? null : Number(r.median30),
      min_90d: r.min90 === null ? null : Number(r.min90),
      points: r.points,
      span_days: Math.floor((at.getTime() - first.getTime()) / DAY_MS),
    });
  }
  return map;
}

export const summaryOrEmpty = (s: PriceSummary | undefined) => s ?? EMPTY;

export type ScoreInput = {
  price: number;
  originalPrice: number | null;
  discountPct: number | null;
  commissionValue: number | null;
  rating: number | null;
  soldCount: number | null;
  available: boolean;
  title: string;
  categoryName: string | null;
  couponCode?: string | null;
  /** Cupom lido da loja (ex.: "Aplicar cupom de 10%" da Amazon). */
  coupon?: { code: string | null; description: string } | null;
};

/** Sinais de qualidade. Só acusa desconto falso e "menor preço" com histórico suficiente. */
export function qualityFlags(p: ScoreInput, h: PriceSummary): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const enoughHistory = h.points >= 3 && h.span_days >= 3;
  if (enoughHistory && p.originalPrice && h.median_30d && p.originalPrice > h.median_30d * 1.15) {
    flags.push("fake_discount");
  }
  if (h.points >= 3 && h.span_days >= 30 && h.min_90d !== null && p.price <= h.min_90d) {
    flags.push("lowest_90d");
  } else if (h.points >= 3 && h.span_days >= 7 && h.min_30d !== null && p.price <= h.min_30d) {
    flags.push("lowest_30d");
  }
  if (p.rating !== null && p.rating < 4) flags.push("low_rating");
  if (!p.available) flags.push("unavailable");
  if (p.couponCode || p.coupon) flags.push("coupon_required");
  return flags;
}

const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));
const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * Nota de 0 a 100. Pesos:
 * desconto real 40 · comissão 20 · avaliação 15 · vendas 10 · nicho 10 · menor preço até 5.
 * Penalidades: desconto falso −15, avaliação baixa −10, indisponível zera.
 */
export function offerScore(
  p: ScoreInput,
  h: PriceSummary,
  flags: QualityFlag[],
  niches: string[],
): number {
  if (!p.available) return 0;

  // Desconto real: compara com a mediana observada; sem histórico, confia no desconto informado.
  let realDiscount: number;
  if (h.median_30d && h.points >= 3) {
    realDiscount = clamp((h.median_30d - p.price) / h.median_30d, 0, 1) * 100;
  } else {
    realDiscount = flags.includes("fake_discount") ? 0 : (p.discountPct ?? 0);
  }
  let score = Math.min(40, realDiscount * 0.8);

  const cv = p.commissionValue ?? 0;
  score += Math.min(20, (20 * Math.log10(1 + cv)) / Math.log10(51));
  score += p.rating === null ? 7 : clamp((p.rating - 3.5) / 1.3) * 15;
  score += p.soldCount === null ? 3 : clamp(Math.log10(p.soldCount + 1) / 4) * 10;

  if (niches.length === 0) {
    score += 5;
  } else {
    const hay = normalize(`${p.title} ${p.categoryName ?? ""}`);
    if (niches.some((n) => hay.includes(normalize(n)))) score += 10;
  }

  if (flags.includes("lowest_90d")) score += 5;
  else if (flags.includes("lowest_30d")) score += 3;
  if (flags.includes("fake_discount")) score -= 15;
  if (flags.includes("low_rating")) score -= 10;

  return Math.round(clamp(score, 0, 100));
}
