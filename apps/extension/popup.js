// Popup da extensão: lê a página aberta, mostra o formulário e cadastra a oferta no OfZap.
const { ofzMoney, ofzAffiliateLink } = globalThis;

const el = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of ["settings", "offer", "unsupported", "invite"]) el(s).hidden = s !== id;
  for (const button of document.querySelectorAll(".nav-item")) {
    const active =
      button.dataset.pane === id || (id === "unsupported" && button.dataset.pane === "offer");
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
};
function connectionStatus(text) {
  const status = el("connection-status");
  status.textContent = text;
  status.hidden = !text;
}
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
  m.className = `msg ${ok === "warn" ? "warn" : ok ? "ok" : "bad"}`;
  m.hidden = !text;
}

async function settings() {
  const s = await chrome.storage.local.get(["apiUrl", "token"]);
  return { apiUrl: (s.apiUrl || "").replace(/\/+$/, ""), token: s.token || "" };
}

/** Chama a API do OfZap com o token. Erro vira a mensagem da plataforma. */
async function call(path, init = {}) {
  const { apiUrl, token } = await settings();
  let res;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
  } catch {
    connectionStatus(`API indisponível: ${apiUrl}. Abra Configurar para conferir.`);
    const error = new Error(
      `Não consegui conectar à API em ${apiUrl}. Confira o endereço em Configurar e se a API está ligada.`,
    );
    error.network = true;
    throw error;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    throw new Error(e ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : `Erro ${res.status}.`);
  }
  connectionStatus("");
  return body;
}

// ── Configuração ────────────────────────────────────────────────

async function openSettings() {
  const s = await settings();
  el("api-url").value = s.apiUrl;
  el("api-token").value = s.token;
  const extra = await chrome.storage.local.get("fbUserId");
  el("fb-user-id").value = extra.fbUserId || "";
  message("settings-msg", "", true);
  show("settings");
}

async function saveSettings() {
  const apiUrl = el("api-url").value.trim().replace(/\/+$/, "");
  const token = el("api-token").value.trim();
  const fbUserId = el("fb-user-id").value.trim();
  if (!/^https?:\/\//.test(apiUrl) || !token) {
    return message("settings-msg", "Preencha o endereço da API e o token.", false);
  }
  if (fbUserId && !/^\d{5,25}$/.test(fbUserId)) {
    return message("settings-msg", "O id do perfil do Facebook deve ter só números.", false);
  }
  // Permissão para falar com o endereço da API (pedida só para ele).
  const origin = `${new URL(apiUrl).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) return message("settings-msg", "Sem permissão para acessar a API.", false);
  await chrome.storage.local.set({ apiUrl, token, fbUserId });
  try {
    const ov = await call("/v1/workspace/overview");
    message("settings-msg", `Ligado ao OfZap: ${ov.workspace.name}.`, true);
    setTimeout(start, 900);
  } catch (err) {
    message("settings-msg", `Não funcionou: ${err.message}`, false);
  }
}

// ── Publicação pontual de convite ──
let inviteDraftLoaded = false;
let inviteDraftTimer;
let inviteScheduled = false;

function inviteEdited() {
  inviteScheduled = false;
  el("invite-send").disabled = false;
  el("invite-send").textContent = "Agendar convite";
  renderInvitePreview();
}

async function loadInviteDraft() {
  if (inviteDraftLoaded) return;
  const draft = await chrome.storage.local.get(["inviteDraftLink", "inviteDraftTexts"]);
  el("invite-link").value = draft.inviteDraftLink || "";
  el("invite-texts").value = draft.inviteDraftTexts || "";
  inviteDraftLoaded = true;
  renderInvitePreview();
}

function saveInviteDraft() {
  clearTimeout(inviteDraftTimer);
  inviteDraftTimer = setTimeout(
    () =>
      void chrome.storage.local.set({
        inviteDraftLink: el("invite-link").value,
        inviteDraftTexts: el("invite-texts").value,
      }),
    250,
  );
  inviteEdited();
}

function flushInviteDraft() {
  if (!inviteDraftLoaded) return;
  clearTimeout(inviteDraftTimer);
  void chrome.storage.local.set({
    inviteDraftLink: el("invite-link").value,
    inviteDraftTexts: el("invite-texts").value,
  });
}

function renderInvitePreview() {
  const link = el("invite-link").value.trim();
  const texts = inviteVersions();
  const images = el("invite-images").files.length;
  const groups = el("invite-groups").querySelectorAll('input[type="checkbox"]:checked').length;
  const preview = el("invite-preview");
  if (!link && !texts.length && !images && !groups) {
    preview.classList.remove("ready");
    preview.textContent = "Preencha o convite para ver o resumo aqui.";
    return;
  }
  preview.classList.add("ready");
  const sample = texts[0]
    ? link && texts[0].includes(link)
      ? texts[0]
      : `${texts[0]}\n\n${link || "[link do grupo]"}`
    : "[texto do convite]";
  preview.textContent = [
    sample,
    "",
    `${groups} grupo(s) · ${images} imagem(ns) · ${texts.length} versão(ões) de texto`,
    groups > 1 ? "Um convite por grupo, com 10 minutos entre agendamentos." : "",
  ]
    .filter((line, index) => line || index === 1)
    .join("\n");
}

async function refreshCalibrationStatus() {
  const { fbUserId } = await chrome.storage.local.get("fbUserId");
  const calibration = fbUserId ? await chrome.storage.local.get(`fbCalibration:${fbUserId}`) : {};
  el("invite-calibration-status").textContent = !fbUserId
    ? "Para publicar, configure o ID do perfil do Facebook em Configurar."
    : calibration[`fbCalibration:${fbUserId}`]
      ? "Publicação automática calibrada para este perfil."
      : "Publicação automática ainda não calibrada. Você pode agendar e calibrar antes do horário do post.";
}

async function loadInviteGroups() {
  const list = el("invite-groups");
  list.replaceChildren();
  try {
    const { fbUserId } = await chrome.storage.local.get("fbUserId");
    if (!fbUserId) {
      list.textContent = "Configure seu perfil do Facebook para ver os grupos disponíveis.";
      message("invite-msg", "Configure o id do seu perfil do Facebook antes de agendar.", false);
      return;
    }
    const { inviteDraftGroups = [] } = await chrome.storage.local.get("inviteDraftGroups");
    const accounts = await call("/v1/facebook/accounts");
    const account = accounts.find((a) => a.fb_user_id === fbUserId);
    const channels = await call("/v1/channels");
    const groups = channels.filter(
      (c) =>
        c.type === "fb_group" &&
        c.facebook_account_id === account?.id &&
        c.status === "active" &&
        ["allowed", "approval", "restricted"].includes(c.posting_policy),
    );
    for (const group of groups) {
      const label = document.createElement("label");
      label.className = "discovery-item";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = group.id;
      input.checked = inviteDraftGroups.includes(group.id);
      input.addEventListener("change", () => {
        const selected = [...list.querySelectorAll('input[type="checkbox"]:checked')].map(
          (item) => item.value,
        );
        void chrome.storage.local.set({ inviteDraftGroups: selected });
        inviteEdited();
      });
      const name = document.createElement("span");
      name.textContent = group.name;
      label.append(input, name);
      list.append(label);
    }
    if (!groups.length) {
      list.textContent =
        "Nenhum grupo apto ainda. Descubra um grupo e analise suas regras primeiro.";
      message("invite-msg", "Analise e cadastre um grupo do Facebook antes de agendar.", false);
    } else message("invite-msg", "", true);
  } catch (err) {
    message("invite-msg", `Não consegui carregar os grupos: ${err.message}`, false);
  } finally {
    renderInvitePreview();
  }
}

function inviteVersions() {
  return el("invite-texts")
    .value.split(/\r?\n-{3,}\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function uploadInviteImage(file) {
  const ticket = (
    await call("/v1/creatives/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, mime: file.type, size_bytes: file.size }),
    })
  ).result;
  const put = await fetch(ticket.put_url, {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file,
  });
  if (!put.ok) throw new Error(`Falha ao enviar ${file.name} (${put.status}).`);
  return (
    await call(`/v1/creatives/uploads/${ticket.upload_id}/complete`, {
      method: "POST",
      body: JSON.stringify({ title: file.name }),
    })
  ).result.id;
}

async function scheduleInvite() {
  const link = el("invite-link").value.trim();
  const texts = inviteVersions();
  const files = [...el("invite-images").files];
  const groupIds = [...el("invite-groups").querySelectorAll("input:checked")].map((x) => x.value);
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error();
  } catch {
    return message("invite-msg", "Informe um link HTTPS válido para o grupo de WhatsApp.", false);
  }
  if (!texts.length) return message("invite-msg", "Escreva pelo menos um texto.", false);
  if (!files.length) return message("invite-msg", "Escolha pelo menos uma imagem.", false);
  if (!groupIds.length)
    return message("invite-msg", "Selecione pelo menos um grupo do Facebook.", false);
  if (
    files.some(
      (f) => !["image/png", "image/jpeg", "image/webp"].includes(f.type) || f.size > 10_000_000,
    )
  ) {
    return message("invite-msg", "Use imagens PNG, JPEG ou WebP de até 10 MB.", false);
  }
  const button = el("invite-send");
  button.disabled = true;
  let scheduled = 0;
  try {
    message("invite-msg", "Enviando imagens…", true);
    const creatives = [];
    for (const file of files) creatives.push(await uploadInviteImage(file));
    const start = Date.now();
    for (const [index, channelId] of groupIds.entries()) {
      const text = texts[index % texts.length];
      const body = text.includes(link) ? text : `${text}\n\n${link}`;
      const result = (
        await call("/v1/posts", {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({
            text: body,
            channel_ids: [channelId],
            creative_id: creatives[index % creatives.length],
            auto_publish: true,
            at: new Date(start + index * 10 * 60_000).toISOString(),
          }),
        })
      ).result;
      scheduled += result.scheduled.length;
      message("invite-msg", `Agendados ${scheduled} de ${groupIds.length} grupos…`, true);
    }
    message(
      "invite-msg",
      `${scheduled} convite(s) agendado(s). Abra os grupos quando o OfZap avisar.`,
      true,
    );
    inviteScheduled = scheduled === groupIds.length;
  } catch (err) {
    inviteScheduled = scheduled > 0;
    message(
      "invite-msg",
      scheduled
        ? `${scheduled} convite(s) agendado(s). Confira a fila antes de tentar de novo. Erro: ${err.message}`
        : `Não foi possível agendar. ${err.message}`,
      false,
    );
  } finally {
    button.disabled = inviteScheduled;
    button.textContent = inviteScheduled ? "Confira a fila de publicações" : "Agendar convite";
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
  if (!s.apiUrl || !s.token) {
    connectionStatus("Configure a API e o token para começar.");
    return openSettings();
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    /^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\/(?:search\/groups|groups\/)/i.test(
      tab?.url || "",
    )
  )
    return show("unsupported");
  await readPage();
}

function openStudio(section = "groups") {
  return chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html#${section}`) });
}

async function openInvite() {
  show("invite");
  await loadInviteDraft();
  await Promise.all([loadInviteGroups(), refreshCalibrationStatus()]);
}

el("open-settings").addEventListener("click", openSettings);
el("open-offer").addEventListener("click", readPage);
el("open-studio").addEventListener("click", () => openStudio("groups"));
el("open-discover").addEventListener("click", () => openStudio("groups"));
el("open-invite").addEventListener("click", () => openStudio("publisher").catch(openInvite));
el("home-discover").addEventListener("click", () => openStudio("groups"));
el("home-invite").addEventListener("click", () => openStudio("publisher").catch(openInvite));
el("invite-link").addEventListener("input", saveInviteDraft);
el("invite-texts").addEventListener("input", saveInviteDraft);
el("invite-images").addEventListener("change", inviteEdited);
window.addEventListener("pagehide", flushInviteDraft);
el("invite-refresh").addEventListener("click", loadInviteGroups);
el("invite-send").addEventListener("click", scheduleInvite);
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
