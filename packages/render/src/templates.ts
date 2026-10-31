// Templates de criativo em Satori (árvore de elementos → SVG → PNG).
// Satori não desenha emoji sem imagens extras: os templates usam só texto e formas.

export const CREATIVE_FORMATS = {
  wa_image: { width: 1080, height: 1080, label: "WhatsApp / feed quadrado (1:1)" },
  feed_4x5: { width: 1080, height: 1350, label: "Feed Instagram (4:5)" },
  story_9x16: { width: 1080, height: 1920, label: "Story / Reels (9:16)" },
} as const;
export type CreativeFormat = keyof typeof CREATIVE_FORMATS;

export type BrandKit = {
  name: string;
  primary_color: string;
  secondary_color: string;
  text_color: string;
  cta: string;
};

export const DEFAULT_BRAND: BrandKit = {
  name: "Ofertas",
  primary_color: "#E11D48",
  secondary_color: "#FFF1F2",
  text_color: "#171717",
  cta: "Link na legenda",
};

export type CreativeData = {
  title: string;
  price: string;
  originalPrice: string | null;
  discountPct: number | null;
  coupon: string | null;
  badge: string | null;
  platform: string;
  /** data URL da foto do produto (ou null para usar um placeholder) */
  image: string | null;
};

export type TemplateParams = { headline?: string; cta?: string; accent_color?: string };

type El = { type: string; props: Record<string, unknown> };
type Style = Record<string, string | number>;

const h = (type: string, style: Style, ...children: (El | string | null | false)[]): El => ({
  type,
  props: {
    style: { display: "flex", ...style },
    children: children.filter((c) => c !== null && c !== false),
  },
});

const img = (src: string, style: Style): El => ({ type: "img", props: { src, style } });

const truncate = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

function productBox(d: CreativeData, brand: BrandKit, accent: string, height: number): El {
  return h(
    "div",
    {
      position: "relative",
      flexGrow: 1,
      minHeight: height,
      backgroundColor: "#FFFFFF",
      borderRadius: 40,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    d.image
      ? img(d.image, { width: "86%", height: "86%", objectFit: "contain" })
      : h(
          "div",
          { fontSize: 180, fontWeight: 800, color: accent, opacity: 0.25 },
          d.title.slice(0, 1).toUpperCase(),
        ),
    d.discountPct
      ? h(
          "div",
          {
            position: "absolute",
            top: 28,
            left: 28,
            backgroundColor: accent,
            color: "#FFFFFF",
            borderRadius: 999,
            padding: "18px 30px",
            fontSize: 52,
            fontWeight: 800,
          },
          `-${d.discountPct}%`,
        )
      : null,
    d.badge
      ? h(
          "div",
          {
            position: "absolute",
            top: 28,
            right: 28,
            backgroundColor: brand.text_color,
            color: "#FFFFFF",
            borderRadius: 16,
            padding: "14px 22px",
            fontSize: 30,
            fontWeight: 700,
          },
          d.badge,
        )
      : null,
  );
}

function header(brand: BrandKit, d: CreativeData, accent: string, headline?: string): El {
  return h(
    "div",
    { justifyContent: "space-between", alignItems: "center" },
    h("div", { fontSize: 44, fontWeight: 800, color: accent }, brand.name),
    h(
      "div",
      { fontSize: 32, fontWeight: 700, color: brand.text_color, opacity: 0.6 },
      headline ?? d.platform,
    ),
  );
}

/** Card de preço: foto grande, desconto, preço "de/por" e cupom. */
function cardPreco(
  d: CreativeData,
  brand: BrandKit,
  p: TemplateParams,
  w: number,
  hgt: number,
): El {
  const accent = p.accent_color ?? brand.primary_color;
  const pad = 64;
  // A foto ocupa o espaço que sobrar (flexGrow); este é só o mínimo.
  const imageH = Math.round(hgt * 0.25);
  return h(
    "div",
    {
      width: w,
      height: hgt,
      flexDirection: "column",
      backgroundColor: brand.secondary_color,
      padding: pad,
      gap: 28,
      fontFamily: "Inter",
      // Sem isto o Satori soma o padding à largura da raiz.
      boxSizing: "border-box",
    },
    header(brand, d, accent, p.headline),
    productBox(d, brand, accent, imageH),
    h(
      "div",
      { fontSize: 50, fontWeight: 700, color: brand.text_color, lineHeight: 1.2, maxHeight: 130 },
      truncate(d.title, 70),
    ),
    h(
      "div",
      { flexDirection: "column", gap: 4 },
      d.originalPrice
        ? h(
            "div",
            {
              fontSize: 40,
              color: brand.text_color,
              opacity: 0.55,
              textDecoration: "line-through",
            },
            `De ${d.originalPrice}`,
          )
        : null,
      h("div", { fontSize: 112, fontWeight: 800, color: accent, lineHeight: 1 }, d.price),
    ),
    h(
      "div",
      { justifyContent: "space-between", alignItems: "center" },
      d.coupon
        ? h(
            "div",
            {
              border: `4px dashed ${accent}`,
              borderRadius: 18,
              padding: "14px 24px",
              fontSize: 38,
              fontWeight: 800,
              color: accent,
            },
            `CUPOM ${d.coupon}`,
          )
        : h("div", {}, ""),
      h(
        "div",
        {
          backgroundColor: brand.text_color,
          color: "#FFFFFF",
          borderRadius: 999,
          padding: "18px 34px",
          fontSize: 36,
          fontWeight: 700,
        },
        p.cta ?? brand.cta,
      ),
    ),
  );
}

/** Destaque de cupom: código grande, foto menor e preço com cupom. */
function cupomDestaque(
  d: CreativeData,
  brand: BrandKit,
  p: TemplateParams,
  w: number,
  hgt: number,
): El {
  const accent = p.accent_color ?? brand.primary_color;
  const pad = 64;
  const imageH = Math.round(hgt * 0.2);
  return h(
    "div",
    {
      width: w,
      height: hgt,
      flexDirection: "column",
      backgroundColor: accent,
      padding: pad,
      gap: 32,
      fontFamily: "Inter",
      // Sem isto o Satori soma o padding à largura da raiz.
      boxSizing: "border-box",
      color: "#FFFFFF",
    },
    h(
      "div",
      { justifyContent: "space-between", alignItems: "center" },
      h("div", { fontSize: 44, fontWeight: 800 }, brand.name),
      h("div", { fontSize: 32, fontWeight: 700, opacity: 0.85 }, p.headline ?? "CUPOM EXCLUSIVO"),
    ),
    h(
      "div",
      {
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#FFFFFF",
        color: accent,
        borderRadius: 40,
        border: "6px dashed rgba(255,255,255,0.9)",
        padding: "48px 32px",
        gap: 8,
      },
      h(
        "div",
        { fontSize: 36, fontWeight: 700, color: brand.text_color, opacity: 0.6 },
        "USE O CUPOM",
      ),
      h(
        "div",
        {
          fontSize: d.coupon && d.coupon.length > 10 ? 96 : 140,
          fontWeight: 800,
          letterSpacing: 4,
        },
        d.coupon ?? "SEM CUPOM",
      ),
    ),
    productBox({ ...d, badge: null }, brand, accent, imageH),
    h(
      "div",
      { fontSize: 48, fontWeight: 700, lineHeight: 1.2, maxHeight: 120 },
      truncate(d.title, 60),
    ),
    h(
      "div",
      { alignItems: "flex-end", gap: 24 },
      h("div", { fontSize: 104, fontWeight: 800, lineHeight: 1 }, d.price),
      d.originalPrice
        ? h(
            "div",
            { fontSize: 40, opacity: 0.75, textDecoration: "line-through", paddingBottom: 12 },
            d.originalPrice,
          )
        : null,
    ),
  );
}

export const CREATIVE_TEMPLATES = {
  card_preco: {
    name: "Card de preço",
    description: "Foto grande do produto, selo de desconto, preço de/por, cupom e chamada.",
    render: cardPreco,
  },
  cupom_destaque: {
    name: "Cupom em destaque",
    description: "Código do cupom em evidência, com foto, título e preço.",
    render: cupomDestaque,
  },
} as const;
export type CreativeTemplateKey = keyof typeof CREATIVE_TEMPLATES;
