"use client";

import { ExternalLink, ImageOff, Star } from "lucide-react";
import { PlatformBadge } from "@/components/ui";
import { FLAG_LABELS, money, scoreClass, TONE_CLASS } from "@/lib/format";

export function Flags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => {
        const meta = FLAG_LABELS[f] ?? { label: f, tone: "info" as const };
        return (
          <span key={f} className={`rounded px-1.5 py-0.5 text-xs ${TONE_CLASS[meta.tone]}`}>
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}

export function Price({
  price,
  original,
  discount,
}: {
  price: number;
  original: number | null;
  discount: number | null;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-lg font-semibold tabular-nums">{money(price)}</span>
      {original && (
        <span className="text-xs text-neutral-500 tabular-nums line-through">
          {money(original)}
        </span>
      )}
      {discount ? <span className="text-xs font-medium text-emerald-600">-{discount}%</span> : null}
    </div>
  );
}

export function Score({ value }: { value: number }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums ${scoreClass(value)}`}
      title="Nota 0–100: desconto real, comissão, avaliação, vendas e nicho"
    >
      {value}
    </span>
  );
}

/** Dados que o card de produto mostra (vale para resultado de busca e oferta salva). */
export type CardProduct = {
  title: string;
  image_url: string | null;
  url: string;
  platform: string;
  price: number;
  original_price: number | null;
  discount_pct: number | null;
  rating: number | null;
  sold_count: number | null;
  shop_name?: string | null;
  category: string | null;
  score: number;
  flags: string[];
  commission_value: number | null;
};

/**
 * Card no estilo de vitrine: foto grande com selo de desconto, preço em destaque, avaliação,
 * loja e link para abrir o produto na própria loja. As ações ficam no rodapé.
 */
export function ProductCard({
  p,
  badge,
  overlay,
  footer,
  children,
}: {
  p: CardProduct;
  /** Etiqueta no canto da foto (ex.: "Na curadoria") */
  badge?: React.ReactNode;
  /** Painel que cobre a foto (motivo da rejeição, gerar link): o card mantém o tamanho */
  overlay?: React.ReactNode;
  footer: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col overflow-hidden p-0">
      {/* Foto em área quadrada fixa: imagem alta ou larga não muda o tamanho do card. */}
      <div className="relative aspect-square shrink-0 overflow-hidden bg-white dark:bg-neutral-950">
        {p.image_url ? (
          // biome-ignore lint/performance/noImgElement: imagens externas das lojas
          <img
            src={p.image_url}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-contain p-2"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-300">
            <ImageOff className="h-8 w-8" />
          </div>
        )}
        {p.discount_pct ? (
          <span className="absolute top-2 left-2 rounded-md bg-emerald-600 px-1.5 py-0.5 text-xs font-semibold text-white">
            -{p.discount_pct}%
          </span>
        ) : null}
        <span className="absolute top-2 right-2">
          <Score value={p.score} />
        </span>
        {badge && <span className="absolute bottom-2 left-2">{badge}</span>}
        {overlay && (
          <div className="absolute inset-0 z-10 overflow-y-auto bg-white/95 p-3 backdrop-blur-sm dark:bg-neutral-900/95">
            {overlay}
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
          <PlatformBadge platform={p.platform} />
          {p.category && <span className="truncate">{p.category}</span>}
        </div>
        <a
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="line-clamp-2 min-h-10 text-sm leading-5 hover:underline"
          title={p.title}
        >
          {p.title}
        </a>
        <Price price={p.price} original={p.original_price} discount={null} />
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-neutral-500">
          {p.rating ? (
            <span className="inline-flex items-center gap-0.5">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              {p.rating.toFixed(1)}
            </span>
          ) : null}
          {p.sold_count ? <span>{p.sold_count.toLocaleString("pt-BR")} vendidos</span> : null}
          {p.commission_value ? <span>comissão {money(p.commission_value)}</span> : null}
          {p.shop_name && <span className="truncate">{p.shop_name}</span>}
        </div>
        <Flags flags={p.flags} />
        {children}
        <a
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 hover:underline dark:hover:text-neutral-100"
        >
          <ExternalLink className="h-3 w-3" /> Ver na loja
        </a>
        <div className="mt-auto flex flex-wrap gap-2 pt-2">{footer}</div>
      </div>
    </div>
  );
}
