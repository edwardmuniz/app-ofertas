import type { PublicOffer, PublicStorefront } from "@ofertas/core";

// Página pública da vitrine (/@slug). HTML enxuto, sem scripts de terceiros, pensado para celular.

const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const money = (v: number) => brl.format(v).replace(/ /g, " ");

const STORE: Record<string, string> = {
  amazon: "Amazon",
  shopee: "Shopee",
  mercadolivre: "Mercado Livre",
  magalu: "Magalu",
};

/** Texto branco ou escuro, o que tiver mais contraste com a cor. */
function readableOn(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
  return l > 0.45 ? "#1C1917" : "#FFFFFF";
}

function offerCard(o: PublicOffer) {
  const img = o.image
    ? `<img src="${esc(o.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="noimg">sem foto</div>`;
  const off = o.discount_pct ? `<span class="off">-${o.discount_pct}%</span>` : "";
  const from = o.original_price ? `<s>${money(o.original_price)}</s>` : "";
  const pix =
    o.pix_price && o.pix_price < o.price
      ? `<div class="pix">${money(o.pix_price)} no Pix</div>`
      : "";
  return `<a class="card" href="${esc(o.url)}" data-o="${esc(o.id)}" target="_blank" rel="nofollow sponsored noopener">
  <div class="ph">${img}${off}</div>
  <div class="body">
    <div class="store">${esc(STORE[o.platform] ?? o.platform)}</div>
    <div class="t">${esc(o.title)}</div>
    <div class="price">${from}<b>${money(o.price)}</b></div>${pix}
    <span class="cta">Ver oferta</span>
  </div>
</a>`;
}

export function storefrontHtml(
  sf: PublicStorefront,
  opts: { inviteHref: (slug: string) => string; beaconUrl: string },
) {
  const d = sf.design;
  const onAccent = readableOn(d.accent_color);
  const avatar = sf.avatar_url
    ? `<img class="av" src="${esc(sf.avatar_url)}" alt="">`
    : `<div class="av av0">${esc(sf.title.slice(0, 1).toUpperCase())}</div>`;
  const cover = d.cover_url ? `<img class="cover" src="${esc(d.cover_url)}" alt="">` : "";
  const buttons = sf.invites
    .map(
      (v) =>
        `<a class="join" href="${esc(opts.inviteHref(v.slug))}">${esc(d.join_label)}${sf.invites.length > 1 ? `: ${esc(v.label)}` : ""}</a>`,
    )
    .join("");
  const links = d.links
    .map(
      (l) =>
        `<a class="extra" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`,
    )
    .join("");
  const section = (title: string, list: PublicOffer[]) =>
    list.length
      ? `<h2>${esc(title)}</h2><div class="grid">${list.map(offerCard).join("")}</div>`
      : "";
  const highlights = sf.offers.filter((o) => o.featured);
  const rest = sf.offers.filter((o) => !o.featured);
  let body = section("Destaques", highlights);
  if (d.group_by_category) {
    const groups = new Map<string, PublicOffer[]>();
    for (const o of rest) {
      const key = o.category ?? "Outras ofertas";
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    for (const [cat, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      body += section(cat, list);
    }
  } else {
    body += section(d.offers_title, rest);
  }
  if (!sf.offers.length) {
    body = `<p class="empty">As ofertas do dia aparecem aqui. Entre no grupo para receber primeiro.</p>`;
  }
  const desc = sf.tagline ?? "Ofertas selecionadas todos os dias.";

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${d.accent_color}">
<title>${esc(sf.title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(sf.title)}">
<meta property="og:description" content="${esc(desc)}">
${d.cover_url || sf.avatar_url ? `<meta property="og:image" content="${esc(d.cover_url ?? sf.avatar_url ?? "")}">` : ""}
<style>
:root{--accent:${d.accent_color};--on-accent:${onAccent};--bg:${d.background_color};--text:${d.text_color}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
.cover{display:block;width:100%;max-height:220px;object-fit:cover;border-radius:16px;margin-bottom:-42px}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
header{text-align:center}
.av{position:relative;width:84px;height:84px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 12px;background:#e7e5e4;border:3px solid var(--bg)}
.av0{display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;color:#57534e}
h1{font-size:22px;margin:0}
.tag{opacity:.75;margin:6px 0 18px;font-size:15px}
.join{display:block;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:700;padding:14px;border-radius:12px;margin:10px 0;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.extra{display:block;border:2px solid var(--accent);color:var(--text);text-decoration:none;font-weight:600;padding:11px;border-radius:12px;margin:10px 0;font-size:15px}
h2{font-size:17px;margin:28px 0 12px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media(min-width:600px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.card{background:#fff;border-radius:12px;overflow:hidden;text-decoration:none;color:#1c1917;display:flex;flex-direction:column;border:1px solid #e7e5e4}
.ph{position:relative;aspect-ratio:1;background:#fff}
.ph img{width:100%;height:100%;object-fit:contain}
.noimg{display:flex;height:100%;align-items:center;justify-content:center;color:#a8a29e;font-size:12px}
.off{position:absolute;top:8px;left:8px;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:12px;padding:3px 7px;border-radius:999px}
.body{padding:10px;display:flex;flex-direction:column;gap:4px;flex:1}
.store{font-size:11px;color:#78716c;text-transform:uppercase;letter-spacing:.04em}
.t{font-size:13px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}
.price{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.price s{color:#a8a29e;font-size:12px}.price b{font-size:17px}
.pix{color:#15803d;font-size:12px;font-weight:600}
.cta{margin-top:auto;text-align:center;background:#1c1917;color:#fff;border-radius:8px;padding:8px;font-size:13px;font-weight:600}
.empty{opacity:.75;text-align:center;margin-top:28px}
footer{margin-top:32px;text-align:center;opacity:.55;font-size:11px;line-height:1.5}
</style></head><body><main>
<header>${cover}${avatar}<h1>${esc(sf.title)}</h1><p class="tag">${esc(desc)}</p>${buttons}${links}</header>
${body}
${d.footer_note ? `<footer>${esc(d.footer_note)}</footer>` : ""}
</main>
<script>
document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[data-o]");if(!a)return;try{navigator.sendBeacon(${JSON.stringify(opts.beaconUrl)}+"&o="+encodeURIComponent(a.getAttribute("data-o")))}catch(_){}});
</script>
</body></html>`;
}
