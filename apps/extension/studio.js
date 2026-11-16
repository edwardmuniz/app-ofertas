const $ = (id) => document.getElementById(id);
const state = {
  texts: [],
  images: [],
  groups: [],
  candidates: [],
  selected: new Set(),
  myGroups: [],
  myGroupsFbUserId: null,
  myGroupsSelected: new Set(),
  leftGroups: [],
  pendingGroups: [],
  blockedGroups: [],
  publisherGroupInfo: null,
  publisherGroupError: null,
  scheduled: false,
};
const PREFIX = "FB: ";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notice(id, text, bad = false) {
  const node = $(id);
  node.textContent = text;
  node.className = `message${bad ? " bad" : ""}`;
  node.hidden = !text;
}

function view(name) {
  for (const section of document.querySelectorAll(".view"))
    section.hidden = section.id !== `view-${name}`;
  for (const button of document.querySelectorAll("nav button")) {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  location.hash = name;
  if (name === "library") void loadLibrary();
  if (name === "publisher") void loadPublisher();
  if (name === "groups") void restoreGroups();
}

async function config() {
  const data = await chrome.storage.local.get(["apiUrl", "token", "fbUserId"]);
  return {
    apiUrl: (data.apiUrl || "").replace(/\/+$/, ""),
    token: data.token || "",
    fbUserId: data.fbUserId || "",
  };
}

async function api(path, init = {}) {
  const { apiUrl, token } = await config();
  if (!apiUrl || !token) throw new Error("Configure o endereço da API e o token em Configuração.");
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
  } catch {
    $("connection").className = "connection bad";
    $("connection").textContent = "API indisponível. Confira a configuração.";
    throw new Error(`Não foi possível conectar à API em ${apiUrl}.`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `A API respondeu ${response.status}.`);
  $("connection").className = "connection ok";
  $("connection").textContent = "Conectado ao OfZap";
  return body;
}

async function saveSettings(event) {
  event.preventDefault();
  const apiUrl = $("api-url").value.trim().replace(/\/+$/, "");
  const token = $("api-token").value.trim();
  const fbUserId = $("fb-user-id").value.trim();
  if (!/^https?:\/\//.test(apiUrl) || !/^\d{5,25}$/.test(fbUserId))
    return notice(
      "settings-message",
      "Confira o endereço da API e o ID numérico do Facebook.",
      true,
    );
  const granted = await chrome.permissions.request({ origins: [`${new URL(apiUrl).origin}/*`] });
  if (!granted) return notice("settings-message", "Permita o acesso à API para continuar.", true);
  await chrome.storage.local.set({ apiUrl, token, fbUserId });
  try {
    const overview = await api("/v1/workspace/overview");
    notice("settings-message", `Conectado a ${overview.workspace.name}.`);
  } catch (error) {
    notice("settings-message", error.message, true);
  }
}

async function buildSearches() {
  const niche = $("niche").value.trim();
  const region = $("region").value.trim();
  if (niche.length < 2) return notice("groups-message", "Informe um nicho para buscar.", true);
  const old = await chrome.storage.local.get(["discoverNiche", "discoverLocation"]);
  if (old.discoverNiche !== niche || old.discoverLocation !== region) {
    state.candidates = [];
    state.selected = new Set();
    await chrome.storage.local.set({ discoverResults: [], discoverSelectedIds: [] });
    renderCandidates();
  }
  const base = [niche, region].filter(Boolean).join(" ");
  await chrome.storage.local.set({
    discoverNiche: niche,
    discoverLocation: region,
  });
  return base;
}

async function searchFacebook() {
  const query = await buildSearches();
  if (!query) return;
  const button = $("build-searches");
  button.disabled = true;
  button.textContent = "Buscando…";
  try {
    const granted = await chrome.permissions.request({ origins: ["https://*.facebook.com/*"] });
    if (!granted) throw new Error("Permita o acesso ao Facebook para buscar grupos.");
    const tabs = await chrome.tabs.query({ url: "https://www.facebook.com/*" });
    const tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!tab?.id) throw new Error("Abra www.facebook.com em uma aba para buscar grupos.");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["fb-search-core.js", "fb-search-main.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fb-search.js"] });
    notice("groups-message", "Consultando grupos na aba do Facebook já aberta…");
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "ofz-fb-search",
      query,
      limit: 100,
    });
    if (!result) throw new Error("A aba do Facebook não respondeu. Atualize-a e tente novamente.");
    if (!result.ok) throw new Error(result.error || "O Facebook recusou a busca.");
    await addCandidates(result.groups || []);
    notice(
      "groups-message",
      `${result.groups?.length || 0} grupo(s) encontrados pela sua sessão do Facebook.`,
    );
  } catch (error) {
    notice("groups-message", error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Buscar grupos";
  }
}

async function loadMyGroups() {
  const button = $("load-my-groups");
  button.disabled = true;
  button.textContent = "Carregando…";
  try {
    const granted = await chrome.permissions.request({ origins: ["https://*.facebook.com/*"] });
    if (!granted) throw new Error("Permita o acesso ao Facebook para carregar seus grupos.");
    const tabs = await chrome.tabs.query({ url: "https://www.facebook.com/*" });
    const tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!tab?.id) throw new Error("Abra www.facebook.com em uma aba para carregar seus grupos.");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["fb-search-core.js", "fb-search-main.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fb-search.js"] });
    notice(
      "my-groups-message",
      "Consultando seus grupos no Facebook. Isso pode levar até um minuto…",
    );
    let timeout;
    const result = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: "ofz-fb-my-groups" }),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "A consulta não respondeu em um minuto. Atualize a aba do Facebook e tente novamente.",
              ),
            ),
          70_000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!result?.ok) throw new Error(result?.error || "A aba do Facebook não respondeu.");
    const { fbUserId } = await config();
    if (fbUserId && result.fbUserId && fbUserId !== result.fbUserId)
      throw new Error(
        "A aba do Facebook usa outro perfil. Abra o perfil configurado no OfZap e tente novamente.",
      );
    state.myGroups = result.groups || [];
    state.myGroupsFbUserId = result.fbUserId || null;
    state.myGroupsSelected = new Set();
    renderMyGroups();
    await detectLeftGroups(result);
    const left = state.leftGroups.length
      ? ` ${state.leftGroups.length} grupo(s) cadastrado(s) não aparecem mais: veja abaixo.`
      : "";
    notice(
      "my-groups-message",
      result.partial
        ? `${state.myGroups.length} grupo(s) encontrados até a interrupção da consulta. Você pode cadastrar estes grupos ou tentar novamente. Com a lista incompleta, o OfZap não confere de quais grupos você saiu.`
        : `${state.myGroups.length} grupo(s) encontrados na sua conta.${left}`,
    );
  } catch (error) {
    notice("my-groups-message", error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Carregar meus grupos";
  }
}

function renderMyGroups() {
  const box = $("my-groups-list");
  box.replaceChildren();
  if (!state.myGroups.length)
    box.innerHTML = '<div class="empty">Nenhum grupo retornado pelo Facebook.</div>';
  for (const group of state.myGroups) {
    const row = document.createElement("div");
    row.className = "result";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = group.id;
    check.checked = state.myGroupsSelected.has(group.id);
    check.setAttribute("aria-label", `Selecionar ${group.name}`);
    check.addEventListener("change", () => {
      if (check.checked) state.myGroupsSelected.add(group.id);
      else state.myGroupsSelected.delete(group.id);
      updateMyGroupsSelection();
    });
    const name = document.createElement("strong");
    name.className = "result-main";
    name.textContent = group.name;
    const link = document.createElement("a");
    link.className = "group-link";
    link.href = group.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Ver grupo ↗";
    row.append(check, name, link);
    box.append(row);
  }
  updateMyGroupsSelection();
}

function updateMyGroupsSelection() {
  const count = state.myGroupsSelected.size;
  $("my-groups-count").textContent = `${count} selecionado(s)`;
  $("import-my-groups").disabled = count === 0;
}

async function importMyGroups() {
  const { fbUserId } = await config();
  if (!fbUserId)
    return notice("my-groups-message", "Configure seu perfil do Facebook primeiro.", true);
  if (state.myGroupsFbUserId && state.myGroupsFbUserId !== fbUserId)
    return notice(
      "my-groups-message",
      "O perfil configurado mudou. Carregue seus grupos novamente antes de cadastrar.",
      true,
    );
  const groups = state.myGroups.filter((group) => state.myGroupsSelected.has(group.id));
  if (!groups.length) return;
  const button = $("import-my-groups");
  button.disabled = true;
  let imported = 0;
  try {
    notice("my-groups-message", "Registrando seu perfil do Facebook no OfZap…");
    await api("/v1/facebook/heartbeat", {
      method: "POST",
      body: JSON.stringify({ fb_user_id: fbUserId }),
    });
    for (const group of groups) {
      await api("/v1/facebook/groups", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          fb_user_id: fbUserId,
          group_id: group.id,
          name: group.name,
          url: group.url,
        }),
      });
      imported++;
      state.myGroupsSelected.delete(group.id);
      notice("my-groups-message", `${imported} de ${groups.length} grupo(s) cadastrados…`);
    }
    notice(
      "my-groups-message",
      `${imported} grupo(s) cadastrados. Abra cada grupo e use “Analisar este grupo” antes de publicar.`,
    );
  } catch (error) {
    notice("my-groups-message", `${imported} grupo(s) cadastrados. ${error.message}`, true);
  } finally {
    renderMyGroups();
  }
}

async function addCandidates(groups) {
  const niche = $("niche").value.trim();
  let ranked = groups;
  if (niche && groups.length) {
    try {
      ranked = (
        await api("/v1/facebook/discover/rank", {
          method: "POST",
          body: JSON.stringify({ niche, groups }),
        })
      ).groups;
    } catch {
      notice("groups-message", "Grupos encontrados. Ligue a API para classificar e participar.");
    }
  }
  const existing = new Map(state.candidates.map((item) => [item.id, item]));
  for (const group of ranked) existing.set(group.id, group);
  state.candidates = [...existing.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  await chrome.storage.local.set({ discoverResults: state.candidates });
  renderCandidates();
  return ranked;
}

/** Apaga a busca salva: termos, grupos encontrados e seleção. */
async function clearSearch() {
  $("niche").value = "";
  $("region").value = "";
  state.candidates = [];
  state.selected = new Set();
  await chrome.storage.local.remove([
    "discoverNiche",
    "discoverLocation",
    "discoverResults",
    "discoverSelectedIds",
  ]);
  renderCandidates();
  $("groups-message").hidden = true;
  $("niche").focus();
}

function renderCandidates() {
  const box = $("group-results");
  box.replaceChildren();
  $("clear-search").hidden = !state.candidates.length && !$("niche").value && !$("region").value;
  const available = new Set(state.candidates.map((group) => group.id));
  state.selected = new Set([...state.selected].filter((id) => available.has(id)));
  $("result-count").textContent = `${state.candidates.length} grupos`;
  if (!state.candidates.length) {
    box.innerHTML = '<div class="empty">Busque um nicho para comparar grupos.</div>';
    updateSelection();
    return;
  }
  for (const group of state.candidates) {
    const groupUrl = `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/`;
    const row = document.createElement("div");
    row.className = "result";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = group.id;
    check.checked = state.selected?.has(group.id) || false;
    check.addEventListener("change", async () => {
      if (check.checked) state.selected.add(group.id);
      else state.selected.delete(group.id);
      await chrome.storage.local.set({ discoverSelectedIds: [...state.selected] });
      updateSelection();
    });
    const main = document.createElement("div");
    main.className = "result-main";
    const name = document.createElement("a");
    name.className = "result-name";
    name.href = groupUrl;
    name.target = "_blank";
    name.rel = "noopener noreferrer";
    name.textContent = group.name;
    const meta = document.createElement("span");
    meta.className = "result-meta";
    meta.textContent =
      [
        group.member_count ? `${group.member_count.toLocaleString("pt-BR")} membros` : null,
        group.posts_per_day ? `${group.posts_per_day} posts/dia` : null,
        ...(group.reasons || []),
      ]
        .filter(Boolean)
        .join(" · ") || "Sem métricas visíveis";
    main.append(name, meta);
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `${group.score ?? "—"}/100`;
    const link = document.createElement("a");
    link.className = "group-link";
    link.href = groupUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Ver grupo ↗";
    link.setAttribute("aria-label", `Ver grupo ${group.name} no Facebook`);
    row.append(check, main, score, link);
    box.append(row);
  }
  updateSelection();
}

function updateSelection() {
  const count = state.selected?.size || 0;
  $("selected-count").textContent = `${count} selecionado(s) · máximo 10 por rodada`;
  $("join-groups").disabled = count === 0 || count > 10;
}

async function joinGroups() {
  const groups = state.candidates
    .filter((group) => state.selected.has(group.id))
    .map(({ id, name }) => ({ id, name }));
  if (!groups.length || groups.length > 10) return;
  const result = await chrome.runtime.sendMessage({ type: "ofz-fb-join-batch", groups });
  if (!result?.ok)
    return notice(
      "groups-message",
      result?.reason || "Não foi possível iniciar as entradas.",
      true,
    );
  state.selected.clear();
  await chrome.storage.local.set({ discoverSelectedIds: [] });
  renderCandidates();
  await refreshJoins();
  notice(
    "groups-message",
    `${groups.length} grupo(s) na fila de entrada. Confira perguntas e regras no Facebook.`,
  );
}

async function refreshJoins() {
  const saved = await chrome.storage.local.get(["fbJoinQueue", "fbJoinResults"]);
  const queue = saved.fbJoinQueue || [];
  const results = (saved.fbJoinResults || []).slice(-8);
  $("join-status").textContent = [
    `${queue.length} aguardando entrada.`,
    ...results.map(
      (item) => `${item.name}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`,
    ),
  ].join("\n");
}

async function restoreGroups() {
  const saved = await chrome.storage.local.get([
    "discoverNiche",
    "discoverLocation",
    "discoverResults",
    "discoverSelectedIds",
  ]);
  $("niche").value = saved.discoverNiche || "";
  $("region").value = saved.discoverLocation || "";
  state.candidates = saved.discoverResults || [];
  state.selected = new Set(saved.discoverSelectedIds || []);
  renderCandidates();
  await refreshJoins();
}

async function uploadImage(file, tags) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error("Use PNG, JPG ou WebP de até 10 MB.");
  const ticket = (
    await api("/v1/creatives/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, mime: file.type, size_bytes: file.size }),
    })
  ).result;
  const upload = await fetch(ticket.put_url, {
    method: "PUT",
    headers: ticket.headers,
    body: file,
  });
  if (!upload.ok) throw new Error(`Falha ao enviar ${file.name} (${upload.status}).`);
  return (
    await api(`/v1/creatives/uploads/${ticket.upload_id}/complete`, {
      method: "POST",
      body: JSON.stringify({ title: file.name, tags }),
    })
  ).result;
}

async function loadLibrary() {
  try {
    const [templates, creatives] = await Promise.all([
      api("/v1/message-templates"),
      api("/v1/creatives?origin=upload&limit=100"),
    ]);
    state.texts = templates.items.filter((item) => item.name.startsWith(PREFIX));
    state.images = creatives.items.filter((item) => item.tags.includes("fb_invite"));
    renderLibrary();
  } catch (error) {
    notice(
      "library-message",
      `${error.message} Se o token é antigo, gere outro com o preset da extensão.`,
      true,
    );
  }
}

function renderLibrary() {
  $("text-count").textContent = String(state.texts.length);
  $("image-count").textContent = String(state.images.length);
  const texts = $("text-list");
  texts.replaceChildren();
  if (!state.texts.length)
    texts.innerHTML = '<div class="empty">Nenhum texto cadastrado ainda.</div>';
  for (const item of state.texts) {
    const row = document.createElement("div");
    row.className = "item";
    const title = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = item.name.slice(PREFIX.length);
    const small = document.createElement("small");
    small.textContent = item.body.slice(0, 90);
    title.append(strong, small);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Editar";
    edit.addEventListener("click", () => {
      $("text-id").value = item.id;
      $("text-name").value = item.name.slice(PREFIX.length);
      $("text-body").value = item.body;
      $("text-name").focus();
    });
    row.append(title, edit);
    texts.append(row);
  }
  const images = $("image-list");
  images.replaceChildren();
  if (!state.images.length)
    images.innerHTML = '<div class="empty">Nenhuma imagem cadastrada ainda.</div>';
  for (const item of state.images) {
    const card = document.createElement("div");
    card.className = "image-item";
    const img = document.createElement("img");
    img.src = item.variants[0]?.preview_url || item.variants[0]?.url || "";
    img.alt = item.title;
    const title = document.createElement("span");
    title.textContent = item.title;
    card.append(img, title);
    images.append(card);
  }
}

async function saveText(event) {
  event.preventDefault();
  const name = $("text-name").value.trim();
  const body = $("text-body").value.trim();
  if (!name || !body) return;
  try {
    await api("/v1/message-templates", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        ...($("text-id").value ? { id: $("text-id").value } : {}),
        name: `${PREFIX}${name}`,
        body,
      }),
    });
    clearText();
    await loadLibrary();
    notice("library-message", "Texto salvo na biblioteca.");
  } catch (error) {
    notice("library-message", error.message, true);
  }
}

function clearText() {
  $("text-form").reset();
  $("text-id").value = "";
}

async function addImages() {
  const files = [...$("library-images").files];
  if (!files.length) return;
  try {
    for (const file of files) {
      notice("library-message", `Enviando ${file.name}…`);
      await uploadImage(file, ["fb_invite"]);
    }
    $("library-images").value = "";
    await loadLibrary();
    notice("library-message", `${files.length} imagem(ns) salva(s) na biblioteca.`);
  } catch (error) {
    notice("library-message", error.message, true);
  }
}

async function loadPublisher() {
  await loadLibrary();
  const { fbUserId } = await config();
  const calibration = fbUserId ? await chrome.storage.local.get(`fbCalibration:${fbUserId}`) : {};
  $("calibration").textContent = !fbUserId
    ? "Configure o ID do perfil do Facebook."
    : calibration[`fbCalibration:${fbUserId}`]
      ? "Publicação com imagem calibrada para este perfil."
      : "Calibre um post com imagem no painel de um grupo antes do horário de publicação.";
  $("calibration").className = `notice ${calibration[`fbCalibration:${fbUserId}`] ? "ok" : "warn"}`;
  await loadPublisherGroups();
  renderPublisherChoices();
}

async function loadPublisherGroups() {
  const { fbUserId } = await config();
  try {
    const [accounts, channels] = await Promise.all([
      api("/v1/facebook/accounts"),
      api("/v1/channels"),
    ]);
    if (!Array.isArray(accounts) || !Array.isArray(channels))
      throw new Error("A API retornou uma lista de grupos inválida.");
    const buckets = ofzPublisherGroups(accounts, channels, fbUserId);
    state.groups = buckets.eligible;
    state.pendingGroups = buckets.pending;
    state.blockedGroups = buckets.blocked;
    state.publisherGroupInfo = buckets;
    state.publisherGroupError = null;
    notice("publisher-groups-message", "");
    renderPublisherChoices();
  } catch (error) {
    state.groups = [];
    state.pendingGroups = [];
    state.blockedGroups = [];
    state.publisherGroupInfo = null;
    state.publisherGroupError = error.message;
    renderPublisherChoices();
    notice("publisher-groups-message", error.message, true);
  }
}

/**
 * Tira grupos do OfZap (arquiva e cancela os agendados), depois de confirmar com a pessoa.
 * Devolve false se ela desistiu ou se algo falhou (a mensagem vai para messageId).
 */
async function removeGroups(groups, messageId) {
  const names = groups.length === 1 ? `"${groups[0].name}"` : `${groups.length} grupos`;
  if (
    !confirm(
      `Remover ${names} do OfZap? Os convites agendados são cancelados. Se você voltar a um grupo, é só cadastrá-lo de novo em Meus grupos.`,
    )
  )
    return false;
  let removed = 0;
  let canceled = 0;
  try {
    for (const group of groups) {
      const res = await api(`/v1/facebook/groups/${encodeURIComponent(group.id)}`, {
        method: "DELETE",
        body: "{}",
      });
      removed++;
      canceled += res?.result?.scheduled_posts_canceled || 0;
      state.leftGroups = state.leftGroups.filter((item) => item.id !== group.id);
    }
    const what = removed === 1 ? `"${groups[0].name}" removido` : `${removed} grupos removidos`;
    notice(
      messageId,
      `${what}.${canceled ? ` ${canceled} convite(s) agendado(s) cancelado(s).` : ""}`,
    );
    return true;
  } catch (error) {
    notice(messageId, `${removed} removido(s). ${error.message}`, true);
    return false;
  } finally {
    renderLeftGroups();
    await loadPublisherGroups();
  }
}

/** Botão para tirar do OfZap um grupo do qual o perfil saiu. */
function removeGroupButton(group, messageId = "publisher-groups-message") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button remove-group";
  button.textContent = "Remover";
  button.setAttribute("aria-label", `Remover ${group.name} do OfZap`);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    if (!(await removeGroups([group], messageId))) button.disabled = false;
  });
  return button;
}

/** Cadastrados no OfZap que não estão mais em "Meus grupos". */
function renderLeftGroups() {
  const box = $("left-groups");
  box.replaceChildren();
  box.hidden = !state.leftGroups.length;
  if (!state.leftGroups.length) return;
  const head = document.createElement("div");
  head.className = "section-head";
  const intro = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = `Você não participa mais (${state.leftGroups.length})`;
  const help = document.createElement("p");
  help.className = "help";
  help.textContent =
    "Estes grupos estão cadastrados no OfZap, mas não vieram na lista do Facebook.";
  intro.append(title, help);
  const all = document.createElement("button");
  all.type = "button";
  all.className = "secondary";
  all.textContent = "Remover todos";
  all.addEventListener("click", async () => {
    all.disabled = true;
    if (!(await removeGroups([...state.leftGroups], "my-groups-message"))) all.disabled = false;
  });
  head.append(intro, all);
  box.append(head);
  for (const group of state.leftGroups) {
    const row = document.createElement("div");
    row.className = "group-status-row";
    const text = document.createElement("div");
    const link = document.createElement("a");
    link.href = `https://www.facebook.com/groups/${encodeURIComponent(group.external_id || "")}/`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = group.name;
    text.append(link);
    row.append(text, removeGroupButton(group, "my-groups-message"));
    box.append(row);
  }
}

/** Compara "Meus grupos" com os grupos cadastrados neste perfil. */
async function detectLeftGroups(result) {
  state.leftGroups = [];
  if (!result.partial) {
    try {
      const { fbUserId } = await config();
      const [accounts, channels] = await Promise.all([
        api("/v1/facebook/accounts"),
        api("/v1/channels"),
      ]);
      if (Array.isArray(accounts) && Array.isArray(channels)) {
        const { mine } = ofzPublisherGroups(accounts, channels, fbUserId);
        state.leftGroups = ofzLeftGroups(mine, state.myGroups, false);
      }
    } catch {
      /* sem API: só não aponta os grupos que saíram */
    }
  }
  renderLeftGroups();
}

function choice(container, item, label, imageUrl = null, extra = null) {
  const row = document.createElement("label");
  row.className = "choice";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = item.id;
  input.checked = state.publisherChoices?.[container.id]?.has(item.id) || false;
  input.addEventListener("change", publisherEdited);
  row.append(input);
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = "";
    row.append(image);
  }
  const text = document.createElement("span");
  text.className = "choice-label";
  text.textContent = label;
  row.append(text);
  if (extra) row.append(extra);
  container.append(row);
}

function renderPublisherChoices() {
  const texts = $("publisher-texts");
  const images = $("publisher-images");
  const groups = $("publisher-groups");
  state.publisherChoices = Object.fromEntries(
    [texts, images, groups].map((box) => [
      box.id,
      new Set(
        [...box.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value),
      ),
    ]),
  );
  for (const box of [texts, images, groups]) box.replaceChildren();
  for (const item of state.texts) choice(texts, item, item.name.slice(PREFIX.length));
  for (const item of state.images)
    choice(images, item, item.title, item.variants[0]?.preview_url || item.variants[0]?.url);
  const policyLabels = {
    allowed: "divulgação permitida",
    approval: "post sujeito à aprovação",
    restricted: "confira as condições",
  };
  for (const item of state.groups)
    choice(
      groups,
      item,
      `${item.name} · ${policyLabels[item.posting_policy] || item.posting_policy}${item.posting_policy === "restricted" && item.policy_notes ? `: ${item.policy_notes.slice(0, 120)}` : ""}`,
      null,
      removeGroupButton(item),
    );
  if (!state.texts.length) texts.textContent = "Cadastre textos na Biblioteca.";
  if (!state.images.length) images.textContent = "Cadastre imagens na Biblioteca.";
  const info = state.publisherGroupInfo;
  const status = $("publisher-groups-status");
  status.textContent = !info
    ? state.publisherGroupError
      ? "Não foi possível carregar os grupos cadastrados."
      : "Carregando grupos cadastrados…"
    : !info.account
      ? `Perfil ${$("fb-user-id").value || "configurado"} não encontrado nesta API. Confira a Configuração e carregue seus grupos.`
      : !info.mine.length
        ? info.otherProfiles
          ? `Há ${info.otherProfiles} grupo(s) vinculado(s) a outro perfil. Confira o ID em Configuração.`
          : "Nenhum grupo cadastrado neste perfil. Use “Meus grupos” em Encontrar grupos."
        : `${info.mine.length} cadastrado(s) · ${info.eligible.length} apto(s) · ${info.pending.length} aguardando análise · ${info.blocked.length} indisponível(is).`;
  if (!state.groups.length && info?.account)
    groups.textContent = "Nenhum grupo apto para publicar no momento.";
  renderGroupStatusList(
    "publisher-pending",
    "Aguardando análise",
    state.pendingGroups,
    () => "Abra o grupo e clique em “Analisar este grupo” no painel do OfZap.",
  );
  renderGroupStatusList("publisher-blocked", "Indisponíveis", state.blockedGroups, (group) =>
    group.status !== "active" ? "Canal pausado" : group.policy_notes || "Divulgação proibida",
  );
  renderPreview();
}

function renderGroupStatusList(id, heading, groups, description) {
  const box = $(id);
  box.replaceChildren();
  if (!groups.length) return;
  const title = document.createElement("h3");
  title.textContent = `${heading} (${groups.length})`;
  box.append(title);
  for (const group of groups) {
    const row = document.createElement("div");
    row.className = "group-status-row";
    const text = document.createElement("div");
    const link = document.createElement("a");
    link.href = `https://www.facebook.com/groups/${encodeURIComponent(group.external_id || "")}/`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = group.name;
    const small = document.createElement("small");
    small.textContent = description(group);
    text.append(link, small);
    row.append(text, removeGroupButton(group));
    box.append(row);
  }
}

const selected = (id) =>
  [...$(id).querySelectorAll('input[type="checkbox"]:checked')].map((item) => item.value);
const mode = () => document.querySelector('input[name="post-mode"]:checked').value;

function publisherEdited() {
  state.scheduled = false;
  $("schedule").textContent = "Agendar publicações";
  renderPreview();
}

function content() {
  if (mode() === "single") {
    const text = $("single-text").value.trim();
    const file = $("single-image").files[0];
    return {
      texts: text ? [text] : [],
      images: file ? [{ id: "pending", title: file.name }] : [],
      file,
    };
  }
  return {
    texts: state.texts
      .filter((item) => selected("publisher-texts").includes(item.id))
      .map((item) => item.body),
    images: state.images.filter((item) => selected("publisher-images").includes(item.id)),
  };
}

function renderPreview() {
  const { texts, images } = content();
  const groups = selected("publisher-groups");
  const pairs = texts.flatMap((text, textIndex) =>
    images.map((image, imageIndex) => ({ text, image, textIndex, imageIndex })),
  );
  $("combination-summary").textContent = pairs.length
    ? `${texts.length} texto(s) × ${images.length} imagem(ns) = ${pairs.length} combinação(ões). ${groups.length} grupo(s) receberão um post cada.`
    : "Escolha texto e imagem para ver as combinações.";
  const box = $("combinations");
  box.replaceChildren();
  for (const [index, pair] of pairs.slice(0, 24).entries()) {
    const row = document.createElement("div");
    row.className = "combination";
    const link = $("invite-link").value.trim();
    row.textContent = `${index + 1}. Texto ${pair.textIndex + 1} + imagem ${pair.imageIndex + 1} (${pair.image.title})\n${pair.text.slice(0, 90)}${link && !pair.text.includes(link) ? `\n${link}` : ""}`;
    box.append(row);
  }
  if (pairs.length > 24) {
    const more = document.createElement("div");
    more.className = "help";
    more.textContent = `Mais ${pairs.length - 24} combinações seguem a mesma ordem.`;
    box.append(more);
  }
  $("schedule").disabled =
    state.scheduled || !pairs.length || !groups.length || !$("invite-link").value.trim();
}

async function schedule() {
  const link = $("invite-link").value.trim();
  if (!ofzValidInviteLink(link))
    return notice(
      "publisher-message",
      "Use um convite https://chat.whatsapp.com/... ou https://go.ofzap.com.br/entrar/...",
      true,
    );
  const { texts, images, file } = content();
  const channelIds = selected("publisher-groups");
  if (!texts.length || !images.length || !channelIds.length)
    return notice("publisher-message", "Escolha texto, imagem e pelo menos um grupo.", true);
  if (texts.length > 20 || images.length > 20 || channelIds.length > 100)
    return notice("publisher-message", "Escolha até 20 textos, 20 imagens e 100 grupos.", true);
  const gap = Number($("post-gap").value);
  if (!Number.isInteger(gap) || gap < 3 || gap > 240)
    return notice("publisher-message", "Use um intervalo de 3 a 240 minutos.", true);
  const start = $("post-start").value ? new Date($("post-start").value) : new Date();
  if (Number.isNaN(start.getTime()))
    return notice("publisher-message", "Confira a data de início.", true);
  const button = $("schedule");
  button.disabled = true;
  let scheduled = 0;
  const skipped = [];
  try {
    let creativeIds = images.map((item) => item.id);
    if (file) {
      notice("publisher-message", "Enviando a imagem…");
      creativeIds = [(await uploadImage(file, [])).id];
    }
    const finalTexts = texts.map((text) => (text.includes(link) ? text : `${text}\n\n${link}`));
    const plan = await api("/v1/facebook/posts/plan", {
      method: "POST",
      body: JSON.stringify({
        channel_ids: channelIds,
        texts: finalTexts,
        creative_ids: creativeIds,
      }),
    });
    for (const [index, item] of plan.assignments.entries()) {
      const result = (
        await api("/v1/posts", {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({
            text: item.text,
            channel_ids: [item.channel_id],
            creative_id: item.creative_id,
            auto_publish: true,
            at: new Date(start.getTime() + index * gap * 60_000).toISOString(),
          }),
        })
      ).result;
      scheduled += result.scheduled.length;
      skipped.push(...result.skipped.map((item) => item.reason));
      notice("publisher-message", `${scheduled} de ${channelIds.length} grupo(s) agendados…`);
      await sleep(50);
    }
    state.scheduled = scheduled > 0;
    notice(
      "publisher-message",
      skipped.length
        ? `${scheduled} convite(s) agendado(s); ${skipped.length} recusado(s). ${skipped[0]}`
        : `${scheduled} convite(s) agendado(s). Confira a fila de publicações no OfZap.`,
      skipped.length > 0,
    );
  } catch (error) {
    if (scheduled) state.scheduled = true;
    notice(
      "publisher-message",
      scheduled
        ? `${scheduled} convite(s) agendado(s). Confira a fila antes de tentar novamente. ${error.message}`
        : error.message,
      true,
    );
  } finally {
    button.disabled = state.scheduled;
    button.textContent = state.scheduled ? "Confira a fila de publicações" : "Agendar publicações";
  }
}

for (const button of document.querySelectorAll("nav button"))
  button.addEventListener("click", () => view(button.dataset.view));
$("settings-form").addEventListener("submit", saveSettings);
$("build-searches").addEventListener("click", searchFacebook);
$("load-my-groups").addEventListener("click", loadMyGroups);
$("import-my-groups").addEventListener("click", importMyGroups);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "ofz-fb-my-groups-progress" && $("load-my-groups").disabled)
    notice(
      "my-groups-message",
      `${message.count} grupo(s) encontrados até agora. Consultando as próximas páginas…`,
    );
});
$("join-groups").addEventListener("click", joinGroups);
$("refresh-joins").addEventListener("click", refreshJoins);
$("text-form").addEventListener("submit", saveText);
$("clear-text").addEventListener("click", clearText);
$("clear-search").addEventListener("click", clearSearch);
$("library-images").addEventListener("change", addImages);
$("go-library").addEventListener("click", () => view("library"));
$("refresh-groups").addEventListener("click", loadPublisherGroups);
$("schedule").addEventListener("click", schedule);
for (const input of document.querySelectorAll('input[name="post-mode"]'))
  input.addEventListener("change", () => {
    $("single-fields").hidden = mode() !== "single";
    $("library-fields").hidden = mode() !== "library";
    publisherEdited();
  });
for (const id of ["invite-link", "single-text", "single-image", "post-start", "post-gap"])
  $(id).addEventListener("input", publisherEdited);

const current = await config();
$("api-url").value = current.apiUrl;
$("api-token").value = current.token;
$("fb-user-id").value = current.fbUserId;
$("connection").textContent =
  current.apiUrl && current.token ? "API configurada" : "Configure a API para começar";
view(
  current.apiUrl && current.token
    ? ["groups", "library", "publisher", "settings"].includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : "groups"
    : "settings",
);
