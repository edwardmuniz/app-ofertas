// Popup da extensão: lê a página aberta, mostra o formulário e cadastra a oferta no OfZap.
const { ofzMoney, ofzAffiliateLink } = globalThis;

const el = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of ["settings", "offer", "unsupported"]) el(s).hidden = s !== id;
};
const STORE_NAMES = {
  mercadolivre: "Mercado Livre",
  amazon: "Amazon",
  shopee: "Shopee",
  magalu: "Magalu",
};
const STORE_COLORS = {
  mercadolivre: "#ffe600",
  amazon: "#ff9900",
  shopee: "#ee4d2d",
  magalu: "#0086ff",
};
const brl = (n) => (n ? n.toFixed(2).replace(".", ",") : "");
const money = (n) =>
  `R$ ${n
    .toFixed(2)
    .replace(".", ",")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

let page = null;
/** Último cupom usado e se ele se repete sozinho nos próximos produtos. */
let memory = { lastCoupon: null, keepCoupon: false, status: "approved" };

async function loadMemory() {
  const m = await chrome.storage.local.get(["lastCoupon", "keepCoupon", "status"]);
  memory = {
    lastCoupon: m.lastCoupon || null,
    keepCoupon: Boolean(m.keepCoupon),
    status: m.status === "new" ? "new" : "approved",
  };
}

function saveMemory() {
  return chrome.storage.local.set(memory);
}

function currentCoupon() {
  const code = el("coupon-code").value.trim().toUpperCase();
  const description = el("coupon-desc").value.trim();
  return code || description ? { code, description } : null;
}

function setCoupon(c) {
  el("coupon-code").value = c?.code || "";
  el("coupon-desc").value = c?.description || "";
  renderSummary();
  updateLastButton();
}

/** Botão "Usar o último cupom", quando há um salvo diferente do que está no formulário. */
function updateLastButton() {
  const last = memory.lastCoupon;
  const now = currentCoupon();
  const same = last && now && last.code === now.code && last.description === now.description;
  const b = el("use-last");
  b.hidden = !last || Boolean(same);
  if (last) {
    b.textContent = `Usar o último: ${[last.code, last.description].filter(Boolean).join(" · ")}`;
  }
}

function message(id, text, ok) {
  const m = el(id);
  m.textContent = text;
  m.className = `msg ${ok ? "ok" : "bad"}`;
  m.hidden = !text;
}

async function settings() {
  const s = await chrome.storage.local.get(["apiUrl", "token"]);
  return { apiUrl: (s.apiUrl || "").replace(/\/+$/, ""), token: s.token || "" };
}

/** Chama a API do OfZap com o token. Erro vira a mensagem da plataforma. */
async function call(path, init = {}) {
  const { apiUrl, token } = await settings();
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    throw new Error(e ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : `Erro ${res.status}.`);
  }
  return body;
}

// ── Configuração ────────────────────────────────────────────────

async function openSettings() {
  const s = await settings();
  el("api-url").value = s.apiUrl;
  el("api-token").value = s.token;
  message("settings-msg", "", true);
  show("settings");
}

async function saveSettings() {
  const apiUrl = el("api-url").value.trim().replace(/\/+$/, "");
  const token = el("api-token").value.trim();
  if (!/^https?:\/\//.test(apiUrl) || !token) {
    return message("settings-msg", "Preencha o endereço da API e o token.", false);
  }
  // Permissão para falar com o endereço da API (pedida só para ele).
  const origin = `${new URL(apiUrl).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) return message("settings-msg", "Sem permissão para acessar a API.", false);
  await chrome.storage.local.set({ apiUrl, token });
  try {
    const ov = await call("/v1/workspace/overview");
    message("settings-msg", `Ligado ao OfZap: ${ov.workspace.name}.`, true);
    setTimeout(start, 900);
  } catch (err) {
    message("settings-msg", `Não funcionou: ${err.message}`, false);
  }
}

// ── Oferta ──────────────────────────────────────────────────────

function fill(d) {
  const store = el("store");
  store.textContent = STORE_NAMES[d.store] || "Loja";
  store.style.setProperty("--store-color", STORE_COLORS[d.store] || "");
  store.hidden = false;
  el("title").value = d.title || "";
  el("image").src = d.image_url || "";
  el("image").hidden = !d.image_url;
  el("price").value = brl(d.price);
  el("pix").value = brl(d.pix_price);
  el("original").value = brl(d.original_price);
  el("inst-count").value = d.installments ? String(d.installments.count) : "";
  el("inst-value").value = d.installments ? brl(d.installments.value) : "";
  el("inst-free").checked = Boolean(d.installments?.interest_free);
  // "Repetir nos próximos" ligado: vale o cupom salvo; senão, o que a página mostra.
  const coupon = memory.keepCoupon && memory.lastCoupon ? memory.lastCoupon : d.coupon;
  el("coupon-code").value = coupon?.code || "";
  el("coupon-desc").value = coupon?.description || "";
  el("keep-coupon").checked = memory.keepCoupon;
  // Última escolha entre "Aprovar já" e "Mandar para revisar".
  const radio = document.querySelector(`input[name="status"][value="${memory.status}"]`);
  if (radio) radio.checked = true;
  updateLastButton();
  el("affiliate").value = d.affiliate_url || "";
  updateAffiliateHint();
  renderSummary();
}

/** Resumo do preço como sai na mensagem: "De R$ X por R$ Y · R$ Z no Pix · 10x R$ W". */
function renderSummary() {
  const price = ofzMoney(el("price").value);
  const box = el("summary");
  if (!price) {
    box.innerHTML = "";
    return;
  }
  const original = ofzMoney(el("original").value);
  const pix = ofzMoney(el("pix").value);
  const count = Number(el("inst-count").value);
  const value = ofzMoney(el("inst-value").value);
  const parts = [
    `${original && original > price ? `De <s>${money(original)}</s> por ` : ""}<b>${money(price)}</b>`,
    pix && pix < price ? `<span class="pix">${money(pix)} no Pix</span>` : null,
    count >= 2 && value
      ? `${count}x ${money(value)}${el("inst-free").checked ? " sem juros" : ""}`
      : null,
  ].filter(Boolean);
  const code = el("coupon-code").value.trim().toUpperCase();
  const rule = el("coupon-desc").value.trim();
  const coupon = code
    ? `🎟️ ${esc(code)}${rule ? ` · ${esc(rule)}` : ""}`
    : rule
      ? `🎟️ ${esc(rule)}`
      : "";
  box.innerHTML = `${parts.join(" · ")}${coupon ? `<br />${coupon}` : ""}`;
}

function updateAffiliateHint() {
  const hint = el("affiliate-hint");
  const chip = el("affiliate-status");
  const has = Boolean(el("affiliate").value.trim());
  chip.className = `chip ${has || page?.store === "amazon" ? "ok" : "warn"}`;
  chip.textContent = has ? "✓ encontrado" : page?.store === "amazon" ? "tag automática" : "falta";
  if (has || !page) {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  hint.textContent =
    page.store === "mercadolivre"
      ? "Sem link de afiliado: clique em “Compartilhar” na barra de Afiliados do Mercado Livre e depois em “Ler a página de novo” (ou copie o link e toque em Colar)."
      : page.store === "amazon"
        ? "Na Amazon o OfZap coloca a sua tag sozinho."
        : "Sem link de afiliado: se a conta da loja estiver conectada, o OfZap gera um. Se não, cole o seu.";
}

async function readPage() {
  message("offer-msg", "", true);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return show("unsupported");
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["parse.js", "extract.js"],
    });
    page = res?.result || null;
  } catch {
    page = null;
  }
  if (!page?.store) return show("unsupported");
  await loadMemory();
  fill(page);
  show("offer");
}

async function pasteLink() {
  try {
    const text = await navigator.clipboard.readText();
    const link = ofzAffiliateLink(text) || (/^https?:\/\//.test(text.trim()) ? text.trim() : null);
    if (link) el("affiliate").value = link;
    else message("offer-msg", "Nada de link na área de transferência.", false);
  } catch {
    message("offer-msg", "Não deu para ler a área de transferência.", false);
  }
  updateAffiliateHint();
}

async function send() {
  const price = ofzMoney(el("price").value);
  const title = el("title").value.trim();
  if (!price) return message("offer-msg", "Informe o preço.", false);
  if (title.length < 3) return message("offer-msg", "Informe o título.", false);
  const count = Number(el("inst-count").value);
  const value = ofzMoney(el("inst-value").value);
  const code = el("coupon-code").value.trim().toUpperCase();
  const desc = el("coupon-desc").value.trim();
  const affiliate = el("affiliate").value.trim();
  const body = {
    url: affiliate || page.product_url,
    product_url: page.product_url,
    title,
    image_url: page.image_url || null,
    price,
    original_price: ofzMoney(el("original").value),
    pix_price: ofzMoney(el("pix").value),
    installments:
      Number.isInteger(count) && count >= 2 && value
        ? { count, value, interest_free: el("inst-free").checked }
        : null,
    ...(code ? { coupon_code: code } : {}),
    ...(desc ? { coupon_description: desc } : {}),
    status: document.querySelector('input[name="status"]:checked')?.value || "approved",
  };
  const button = el("send");
  button.disabled = true;
  button.textContent = "Cadastrando…";
  try {
    const res = await call("/v1/offers/from-link", { method: "POST", body: JSON.stringify(body) });
    const where = res.result?.status === "approved" ? "Aprovadas" : "Para revisar";
    message("offer-msg", `Cadastrada! Está em Ofertas › ${where}.`, true);
    const used = currentCoupon();
    if (used) {
      memory.lastCoupon = used;
      await saveMemory();
      updateLastButton();
    }
  } catch (err) {
    message("offer-msg", err.message, false);
  } finally {
    button.disabled = false;
    button.textContent = "Cadastrar no OfZap";
  }
}

async function start() {
  const s = await settings();
  if (!s.apiUrl || !s.token) return openSettings();
  await readPage();
}

el("open-settings").addEventListener("click", openSettings);
el("save-settings").addEventListener("click", saveSettings);
el("reread").addEventListener("click", readPage);
el("paste-link").addEventListener("click", pasteLink);
el("send").addEventListener("click", send);
el("affiliate").addEventListener("input", updateAffiliateHint);
el("use-last").addEventListener("click", () => setCoupon(memory.lastCoupon));
el("keep-coupon").addEventListener("change", async () => {
  memory.keepCoupon = el("keep-coupon").checked;
  // Ligou com um cupom no formulário: é esse que passa a se repetir.
  const now = currentCoupon();
  if (memory.keepCoupon && now) memory.lastCoupon = now;
  await saveMemory();
  updateLastButton();
});
for (const id of ["coupon-code", "coupon-desc"]) {
  el(id).addEventListener("input", updateLastButton);
}
for (const radio of document.querySelectorAll('input[name="status"]')) {
  radio.addEventListener("change", () => {
    memory.status = radio.value === "new" ? "new" : "approved";
    saveMemory();
  });
}
for (const id of [
  "price",
  "pix",
  "original",
  "inst-count",
  "inst-value",
  "inst-free",
  "coupon-code",
  "coupon-desc",
]) {
  el(id).addEventListener("input", renderSummary);
}
start();
