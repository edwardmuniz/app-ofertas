// Estúdio de conteúdo (spec 18): carrossel a partir das ofertas. O vídeo é feito pelo agente local.
// Satori não desenha emoji sem imagens extras: só texto e formas.
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { loadFonts } from "./render";
import type { BrandKit } from "./templates";

export const STUDIO_FORMATS = {
  carousel: { width: 1080, height: 1350, label: "Carrossel (Instagram 4:5)" },
} as const;
export type StudioKind = keyof typeof STUDIO_FORMATS;

export type StudioItem = {
  title: string;
  price: string;
  originalPrice: string | null;
  discountPct: number | null;
  pixPrice: string | null;
  installments: string | null;
  platform: string;
  /** data URLs das fotos (a primeira é a principal) */
  images: string[];
};

export type StudioScript = {
  /** Frase de abertura, ex.: "5 achadinhos de cozinha abaixo de R$ 100" */
  hook: string;
  subhook: string | null;
  /** Fechamento, ex.: "Entre no grupo e receba ofertas assim todo dia" */
  outro: string;
  /** Endereço da vitrine sem https, ex.: go.ofzap.com.br/@achadinhos */
  handle: string | null;
  items: StudioItem[];
};

export type StudioFrame = { role: "hook" | "item" | "outro"; png: Buffer };

/** Faixa de baixo do vídeo que as redes cobrem com legenda e botões (TikTok, Reels, Shorts). */
const SAFE_BOTTOM = 300;

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
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

function pill(text: string, bg: string, color: string, size: number): El {
  return h(
    "div",
    {
      backgroundColor: bg,
      color,
      fontSize: size,
      fontWeight: 800,
      padding: `${Math.round(size * 0.35)}px ${Math.round(size * 0.8)}px`,
      borderRadius: 999,
    },
    text,
  );
}

function hookFrame(s: StudioScript, b: BrandKit, w: number, ht: number): El {
  const thumbs = s.items
    .map((i) => i.images[0])
    .filter((x): x is string => Boolean(x))
    .slice(0, 3);
  const big = ht > 1500;
  return h(
    "div",
    {
      // O satori soma o padding ao tamanho: desconta para o quadro ter exatamente w × ht.
      width: w - 2 * (big ? 80 : 64),
      height: ht - 2 * (big ? 80 : 64) - (big ? SAFE_BOTTOM - 80 : 0),
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: b.primary_color,
      padding: big ? 80 : 64,
      paddingBottom: big ? SAFE_BOTTOM : 64,
      fontFamily: "Inter",
    },
    pill(b.name, "#FFFFFF", b.primary_color, big ? 40 : 34),
    h(
      "div",
      { flexDirection: "column", alignItems: "center", gap: 28 },
      h(
        "div",
        {
          fontSize: big ? 104 : 84,
          fontWeight: 800,
          color: "#FFFFFF",
          textAlign: "center",
          lineHeight: 1.05,
          letterSpacing: -2,
        },
        clip(s.hook, 70),
      ),
      s.subhook
        ? h(
            "div",
            { fontSize: big ? 44 : 38, color: "#FFFFFF", opacity: 0.9, textAlign: "center" },
            clip(s.subhook, 90),
          )
        : null,
    ),
    h(
      "div",
      { gap: 24, justifyContent: "center" },
      ...thumbs.map((t) =>
        h(
          "div",
          {
            width: big ? 280 : 250,
            height: big ? 280 : 250,
            backgroundColor: "#FFFFFF",
            borderRadius: 36,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          },
          img(t, { width: "88%", height: "88%", objectFit: "contain" }),
        ),
      ),
    ),
  );
}

function itemFrame(
  it: StudioItem,
  image: string | null,
  index: number,
  total: number,
  b: BrandKit,
  w: number,
  ht: number,
): El {
  const big = ht > 1500;
  return h(
    "div",
    {
      width: w - 2 * (big ? 64 : 52),
      height: ht - 2 * (big ? 64 : 52) - (big ? SAFE_BOTTOM - 64 : 0),
      flexDirection: "column",
      backgroundColor: b.secondary_color,
      padding: big ? 64 : 52,
      paddingBottom: big ? SAFE_BOTTOM : 52,
      gap: big ? 32 : 24,
      fontFamily: "Inter",
    },
    h(
      "div",
      { justifyContent: "space-between", alignItems: "center" },
      pill(`${index + 1} de ${total}`, b.primary_color, "#FFFFFF", big ? 36 : 30),
      h(
        "div",
        { fontSize: big ? 34 : 30, fontWeight: 700, color: b.text_color, opacity: 0.6 },
        it.platform,
      ),
    ),
    h(
      "div",
      {
        position: "relative",
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        backgroundColor: "#FFFFFF",
        borderRadius: 48,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      },
      image
        ? img(image, { width: "92%", height: "92%", objectFit: "contain" })
        : h(
            "div",
            { fontSize: 200, fontWeight: 800, color: b.primary_color, opacity: 0.2 },
            it.title.slice(0, 1),
          ),
      it.discountPct
        ? h(
            "div",
            {
              position: "absolute",
              top: 28,
              right: 28,
              backgroundColor: b.primary_color,
              color: "#FFFFFF",
              fontSize: big ? 52 : 44,
              fontWeight: 800,
              padding: "12px 26px",
              borderRadius: 999,
            },
            `-${it.discountPct}%`,
          )
        : null,
    ),
    h(
      "div",
      {
        fontSize: big ? 46 : 40,
        fontWeight: 700,
        color: b.text_color,
        lineHeight: 1.2,
        height: big ? 112 : 98,
        overflow: "hidden",
      },
      clip(it.title, 80),
    ),
    h(
      "div",
      { flexDirection: "column", gap: 6 },
      it.originalPrice
        ? h(
            "div",
            {
              fontSize: big ? 40 : 34,
              color: b.text_color,
              opacity: 0.55,
              textDecoration: "line-through",
            },
            `De ${it.originalPrice}`,
          )
        : null,
      h(
        "div",
        { fontSize: big ? 112 : 92, fontWeight: 800, color: b.primary_color, letterSpacing: -3 },
        it.price,
      ),
      it.pixPrice
        ? h(
            "div",
            { fontSize: big ? 40 : 34, fontWeight: 700, color: "#15803D" },
            `${it.pixPrice} no Pix`,
          )
        : it.installments
          ? h(
              "div",
              { fontSize: big ? 38 : 32, color: b.text_color, opacity: 0.75 },
              it.installments,
            )
          : null,
    ),
  );
}

function outroFrame(s: StudioScript, b: BrandKit, w: number, ht: number): El {
  const big = ht > 1500;
  return h(
    "div",
    {
      width: w - 160,
      height: ht - 160 - (big ? SAFE_BOTTOM - 80 : 0),
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: big ? 56 : 44,
      backgroundColor: b.primary_color,
      padding: 80,
      paddingBottom: big ? SAFE_BOTTOM : 80,
      fontFamily: "Inter",
    },
    h(
      "div",
      {
        fontSize: big ? 92 : 76,
        fontWeight: 800,
        color: "#FFFFFF",
        textAlign: "center",
        lineHeight: 1.08,
        letterSpacing: -2,
      },
      clip(s.outro, 70),
    ),
    h(
      "div",
      {
        flexDirection: "column",
        alignItems: "center",
        gap: 18,
        backgroundColor: "#FFFFFF",
        borderRadius: 40,
        padding: "40px 56px",
      },
      h("div", { fontSize: big ? 40 : 34, fontWeight: 700, color: b.text_color }, "Link na bio"),
      s.handle
        ? h(
            "div",
            { fontSize: big ? 44 : 36, fontWeight: 800, color: b.primary_color },
            clip(s.handle, 40),
          )
        : null,
    ),
    pill(b.name, "#FFFFFF", b.primary_color, big ? 36 : 30),
  );
}

async function toPng(tree: El, w: number, ht: number): Promise<Buffer> {
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: w,
    height: ht,
    fonts: loadFonts(),
  });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: w } }).render().asPng());
}

/**
 * Quadros do conteúdo: abertura, um por foto de cada produto (até 2 no vídeo, 1 no carrossel) e
 * encerramento com a vitrine.
 */
export async function renderStudioFrames(
  script: StudioScript,
  brand: BrandKit,
  kind: StudioKind,
): Promise<StudioFrame[]> {
  const { width, height } = STUDIO_FORMATS[kind];
  const frames: StudioFrame[] = [
    {
      role: "hook",
      png: await toPng(hookFrame(script, brand, width, height), width, height),
    },
  ];
  const total = script.items.length;
  for (const [i, it] of script.items.entries()) {
    frames.push({
      role: "item",
      png: await toPng(
        itemFrame(it, it.images[0] ?? null, i, total, brand, width, height),
        width,
        height,
      ),
    });
  }
  frames.push({
    role: "outro",
    png: await toPng(outroFrame(script, brand, width, height), width, height),
  });
  return frames;
}
