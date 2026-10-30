const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : brl.format(v);

export const FLAG_LABELS: Record<string, { label: string; tone: "bad" | "good" | "info" }> = {
  fake_discount: { label: "Desconto suspeito", tone: "bad" },
  low_rating: { label: "Avaliação baixa", tone: "bad" },
  unavailable: { label: "Sem estoque", tone: "bad" },
  lowest_90d: { label: "Menor preço 90d", tone: "good" },
  lowest_30d: { label: "Menor preço 30d", tone: "good" },
  coupon_required: { label: "Com cupom", tone: "info" },
};

export const TONE_CLASS = {
  bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
};

export function scoreClass(score: number) {
  if (score >= 70) return "bg-emerald-600 text-white";
  if (score >= 45) return "bg-amber-500 text-white";
  return "bg-neutral-400 text-white dark:bg-neutral-600";
}
