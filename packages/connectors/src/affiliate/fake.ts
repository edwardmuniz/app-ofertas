import {
  type AffiliateConnector,
  ConnectorError,
  type Platform,
  type ProductOffer,
  type SearchQuery,
  type SearchResult,
  sanitizeSubId,
} from "./types";

// Catálogo simulado e determinístico para desenvolver e testar sem credenciais.

type Template = { title: string; min: number; max: number };

const CATALOG: Record<string, { id: string; name: string; templates: Template[] }> = {
  casa: {
    id: "100636",
    name: "Casa e Decoração",
    templates: [
      { title: "Aspirador Robô {b} Smart com Mapeamento", min: 600, max: 1800 },
      { title: "Jogo de Lençol Casal 400 Fios {b}", min: 60, max: 220 },
      { title: "Organizador de Gaveta {b} Kit 8 Peças", min: 25, max: 70 },
      { title: "Luminária de Mesa LED {b} Recarregável", min: 40, max: 130 },
      { title: "Cortina Blackout {b} 2,80m", min: 50, max: 160 },
    ],
  },
  cozinha: {
    id: "100637",
    name: "Cozinha",
    templates: [
      { title: "Air Fryer {b} 4L Digital", min: 280, max: 650 },
      { title: "Jogo de Panelas Antiaderente {b} 10 Peças", min: 180, max: 520 },
      { title: "Liquidificador {b} 1200W 12 Velocidades", min: 120, max: 330 },
      { title: "Cafeteira Elétrica {b} 30 Xícaras", min: 90, max: 260 },
      { title: "Kit Potes Herméticos {b} 10 Unidades", min: 35, max: 110 },
    ],
  },
  tech: {
    id: "100535",
    name: "Eletrônicos",
    templates: [
      { title: "Fone Bluetooth {b} TWS com Cancelamento de Ruído", min: 60, max: 450 },
      { title: "Smartwatch {b} Tela AMOLED", min: 120, max: 900 },
      { title: "Carregador Turbo {b} 65W USB-C", min: 45, max: 180 },
      { title: "Caixa de Som Bluetooth {b} à Prova d'Água", min: 90, max: 600 },
      { title: "Power Bank {b} 20000mAh", min: 70, max: 220 },
    ],
  },
  beleza: {
    id: "100630",
    name: "Beleza",
    templates: [
      { title: "Secador de Cabelo {b} 2000W Íons", min: 90, max: 380 },
      { title: "Kit Skincare {b} Vitamina C", min: 40, max: 180 },
      { title: "Prancha Alisadora {b} Titânio", min: 80, max: 350 },
      { title: "Perfume {b} 100ml", min: 70, max: 420 },
    ],
  },
  moda: {
    id: "100017",
    name: "Moda",
    templates: [
      { title: "Tênis Casual {b} Masculino", min: 90, max: 400 },
      { title: "Mochila Notebook {b} Impermeável", min: 70, max: 260 },
      { title: "Kit 5 Camisetas Básicas {b}", min: 60, max: 160 },
      { title: "Relógio Feminino {b} Dourado", min: 50, max: 300 },
    ],
  },
  games: {
    id: "100644",
    name: "Games",
    templates: [
      { title: "Controle Sem Fio {b} para PC e Celular", min: 80, max: 320 },
      { title: "Headset Gamer {b} RGB 7.1", min: 90, max: 450 },
      { title: "Mouse Gamer {b} 12000 DPI", min: 50, max: 280 },
      { title: "Teclado Mecânico {b} Switch Blue", min: 120, max: 480 },
    ],
  },
};

const BRANDS = [
  "Mondial",
  "Philco",
  "Britânia",
  "Xiaomi",
  "JBL",
  "Baseus",
  "Multilaser",
  "Oster",
  "Tramontina",
  "Ugreen",
  "Redragon",
  "Lenoxx",
];

function rng(seed: number) {
  // mulberry32
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

type FakeItem = Omit<ProductOffer, "platform" | "affiliateUrl">;

function buildCatalog(): FakeItem[] {
  const items: FakeItem[] = [];
  let seq = 0;
  for (const cat of Object.values(CATALOG)) {
    for (const t of cat.templates) {
      for (let v = 0; v < 10; v++) {
        seq++;
        const r = rng(seq * 7919);
        const brand = BRANDS[Math.floor(r() * BRANDS.length)] ?? "Genérico";
        const original = round2(t.min + r() * (t.max - t.min));
        const discount = Math.floor(r() * 70);
        const price = round2(original * (1 - discount / 100));
        const externalId = String(22_000_000_000 + seq * 137);
        items.push({
          externalId,
          title: t.title.replace("{b}", brand),
          url: `https://shopee.com.br/product/1000${seq}/${externalId}`,
          imageUrls: [`https://picsum.photos/seed/oferta${seq}/600/600`],
          price,
          originalPrice: discount > 0 ? original : null,
          discountPct: discount > 0 ? discount : null,
          commissionRate: round2(0.03 + r() * 0.12),
          commissionValue: null,
          rating: round2(3.6 + r() * 1.4),
          soldCount: Math.floor(10 ** (1 + r() * 4)),
          shopName: `${brand} Oficial`,
          categoryIds: [cat.id],
          categoryName: cat.name,
          available: true,
          validUntil: null,
        });
      }
    }
  }
  for (const i of items) i.commissionValue = round2(i.price * (i.commissionRate ?? 0));
  return items;
}

const CATALOG_ITEMS = buildCatalog();

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Controles para testes e demonstrações: mudar preço/estoque de um item simulado. */
export const fakeAffiliateControls = {
  overrides: new Map<string, { price?: number; available?: boolean }>(),
  setPrice(externalId: string, price: number) {
    this.overrides.set(externalId, { ...this.overrides.get(externalId), price });
  },
  setAvailable(externalId: string, available: boolean) {
    this.overrides.set(externalId, { ...this.overrides.get(externalId), available });
  },
  reset() {
    this.overrides.clear();
  },
  failNext: null as null | ConnectorError["code"],
};

export class FakeAffiliateConnector implements AffiliateConnector {
  readonly capabilities = {
    search: true,
    lookup: true,
    linkGeneration: true,
    subIds: 5,
    conversionsReport: false,
  };

  constructor(readonly platform: Platform = "shopee") {}

  private checkFailure() {
    const code = fakeAffiliateControls.failNext;
    if (code) {
      fakeAffiliateControls.failNext = null;
      throw new ConnectorError(this.platform, code, `Falha simulada (${code}).`);
    }
  }

  private materialize(item: FakeItem): ProductOffer {
    const o = fakeAffiliateControls.overrides.get(item.externalId);
    const price = o?.price ?? item.price;
    return {
      ...item,
      platform: this.platform,
      price,
      commissionValue: round2(price * (item.commissionRate ?? 0)),
      available: o?.available ?? true,
      affiliateUrl: `https://s.shopee.com.br/fake${item.externalId.slice(-6)}`,
    };
  }

  async ping() {
    this.checkFailure();
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    this.checkFailure();
    const terms = q.keyword ? normalize(q.keyword).split(/\s+/).filter(Boolean) : [];
    let list = CATALOG_ITEMS.filter((i) => {
      if (q.categoryId && !i.categoryIds.includes(q.categoryId)) return false;
      const hay = normalize(`${i.title} ${i.categoryName ?? ""}`);
      return terms.every((t) => hay.includes(t));
    }).map((i) => this.materialize(i));

    const sorters: Record<string, (a: ProductOffer, b: ProductOffer) => number> = {
      sales: (a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0),
      price_asc: (a, b) => a.price - b.price,
      price_desc: (a, b) => b.price - a.price,
      commission: (a, b) => (b.commissionValue ?? 0) - (a.commissionValue ?? 0),
    };
    const sorter = sorters[q.sort ?? "relevance"];
    if (sorter) list = [...list].sort(sorter);

    const limit = Math.min(q.limit ?? 20, 50);
    const start = ((q.page ?? 1) - 1) * limit;
    return { items: list.slice(start, start + limit), hasMore: start + limit < list.length };
  }

  async lookup(externalId: string) {
    this.checkFailure();
    const item = CATALOG_ITEMS.find((i) => i.externalId === externalId);
    return item ? this.materialize(item) : null;
  }

  async generateLink(productUrl: string, subIds: string[]) {
    this.checkFailure();
    const id = productUrl.split("/").pop()?.slice(-6) ?? "x";
    const subs = subIds.map(sanitizeSubId).filter(Boolean).slice(0, 5);
    return `https://s.shopee.com.br/fake${id}${subs.length ? `?sub=${subs.join("-")}` : ""}`;
  }
}

/** Categorias do catálogo simulado (para telas e testes). */
export const FAKE_CATEGORIES = Object.values(CATALOG).map((c) => ({ id: c.id, name: c.name }));
