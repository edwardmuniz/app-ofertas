// Service worker (MV3) do modo Facebook. Conversa só com a API do OfZap: avisa que a extensão
// está online, pega o próximo trabalho da fila, baixa a imagem (pela API, com o token) e registra
// o resultado. Ele NÃO fala com o Facebook nem publica: quem prepara e confirma o post é o content
// script na aba do grupo, com a pessoa clicando em Publicar. Um trabalho de cada vez.

const TICK_ALARM = "ofz-fb-tick";
const JOIN_ALARM = "ofz-fb-join";
let joining = false;

async function cfg() {
  const s = await chrome.storage.local.get(["apiUrl", "token", "fbUserId"]);
  return {
    apiUrl: (s.apiUrl || "").replace(/\/+$/, ""),
    token: s.token || "",
    fbUserId: s.fbUserId || "",
  };
}

/** Chama a API do OfZap com o token. Devolve { ok, status, body }. */
async function api(path, init = {}) {
  const { apiUrl, token } = await cfg();
  if (!apiUrl || !token) return { ok: false, status: 0, body: null, reason: "not_configured" };
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, reason: String(err) };
  }
}

async function getActiveJob() {
  const s = await chrome.storage.local.get("fbActiveJob");
  const job = s.fbActiveJob || null;
  if (job?.lease_until && new Date(job.lease_until).getTime() <= Date.now()) {
    await chrome.storage.local.remove("fbActiveJob");
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    return null;
  }
  return job;
}
async function setActiveJob(job) {
  if (job) await chrome.storage.local.set({ fbActiveJob: job });
  else await chrome.storage.local.remove("fbActiveJob");
}

/** Blob → data URL (sem FileReader no service worker). */
async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
}

/** Baixa a imagem do trabalho pela API (nunca direto da loja) e devolve como data URL. */
async function fetchJobImage(jobId) {
  const { apiUrl, token } = await cfg();
  try {
    const res = await fetch(`${apiUrl}/v1/facebook/jobs/${jobId}/image`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await blobToDataUrl(await res.blob());
  } catch {
    return null;
  }
}

/**
 * Uma rodada: diz que está online e, se nada estiver em andamento, pega o próximo trabalho.
 * Pega só 1 por vez — o próximo só depois que a pessoa confirmar ou marcar erro.
 */
async function tick() {
  const { fbUserId } = await cfg();
  if (!fbUserId) return { state: "no_profile" };

  const beat = await api("/v1/facebook/heartbeat", {
    method: "POST",
    body: JSON.stringify({ fb_user_id: fbUserId }),
  });
  if (!beat.ok) return { state: "offline", detail: beat.reason || beat.status };
  if (beat.body?.paused_until) return { state: "paused", until: beat.body.paused_until };

  if (await getActiveJob()) return { state: "busy" };

  const claim = await api("/v1/facebook/jobs/claim", {
    method: "POST",
    body: JSON.stringify({ fb_user_id: fbUserId }),
  });
  if (claim.status === 204 || !claim.body?.id) return { state: "idle" };

  const job = claim.body;
  job.image = job.has_image ? await fetchJobImage(job.id) : null;
  await setActiveJob(job);
  await notifyJob(job);
  return { state: "claimed", job };
}

/** Marca o badge e tenta avisar a aba do grupo (se estiver aberta). */
async function notifyJob(job) {
  try {
    chrome.action.setBadgeText({ text: "1" });
    chrome.action.setBadgeBackgroundColor({ color: "#ff7a38" });
  } catch {
    /* badge é só um aviso */
  }
  const tabs = await chrome.tabs.query({ url: "*://*.facebook.com/groups/*" });
  let matchingTab = false;
  for (const t of tabs) {
    if (t.url && new URL(t.url).pathname.split("/")[2] === job.group_id) matchingTab = true;
    if (t.id) chrome.tabs.sendMessage(t.id, { type: "ofz-fb-job", job }).catch(() => {});
  }
  if (job.auto_publish && !matchingTab) {
    await chrome.tabs.create({
      url: `https://www.facebook.com/groups/${encodeURIComponent(job.group_id)}/`,
      active: false,
    });
  }
}

/** Devolve o resultado do trabalho para a API e libera a fila para o próximo. */
async function reportResult(jobId, result) {
  const res = await api(`/v1/facebook/jobs/${jobId}/result`, {
    method: "POST",
    body: JSON.stringify(result),
  });
  if (res.ok || res.status === 409) {
    await setActiveJob(null);
    try {
      chrome.action.setBadgeText({ text: "" });
    } catch {
      /* badge */
    }
    // Puxa logo o próximo (respeitando os limites do servidor).
    setTimeout(() => void tick().catch(() => {}), 1500);
  }
  return res;
}

/** Um grupo por rodada. A fila persiste se o service worker do Chrome reiniciar. */
async function processJoinQueue() {
  if (joining) return;
  joining = true;
  try {
    const state = await chrome.storage.local.get(["fbJoinQueue", "fbJoinResults"]);
    const queue = state.fbJoinQueue || [];
    const group = queue[0];
    if (!group) return;
    const { fbUserId } = await cfg();
    const prepared = await api("/v1/facebook/joins/prepare", {
      method: "POST",
      headers: {
        "idempotency-key": `join-${fbUserId}-${group.id}-${new Date().toISOString().slice(0, 10)}`,
      },
      body: JSON.stringify({ fb_user_id: fbUserId, group_id: group.id, name: group.name }),
    });
    if (!prepared.ok || prepared.body?.status !== "done") {
      await chrome.storage.local.set({
        fbJoinQueue: queue.slice(1),
        fbJoinResults: [
          ...(state.fbJoinResults || []),
          {
            ...group,
            status: "failed",
            reason:
              prepared.body?.error?.message ||
              prepared.reason ||
              "Entrada não autorizada pelo OfZap.",
          },
        ].slice(-30),
      });
      return;
    }
    const tab = await chrome.tabs.create({
      url: `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/`,
      active: false,
    });
    let result = { status: "failed", reason: "A aba do Facebook não carregou." };
    if (tab.id) {
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const current = await chrome.tabs.get(tab.id);
          if (current.status !== "complete") continue;
          result = await chrome.tabs.sendMessage(tab.id, { type: "ofz-fb-join" });
          break;
        } catch {
          /* aguarda o content script */
        }
      }
    }
    if (["joined", "already"].includes(result?.status)) {
      const added = await api("/v1/facebook/groups", {
        method: "POST",
        body: JSON.stringify({ fb_user_id: fbUserId, group_id: group.id, name: group.name }),
      });
      if (!added.ok)
        result = {
          status: "failed",
          reason: added.body?.error?.message || "Não consegui cadastrar o grupo no OfZap.",
        };
    }
    await chrome.storage.local.set({
      fbJoinQueue: queue.slice(1),
      fbJoinResults: [...(state.fbJoinResults || []), { ...group, ...result }].slice(-30),
    });
  } finally {
    joining = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "ofz-fb-get-job") return sendResponse({ job: await getActiveJob() });
      if (msg?.type === "ofz-fb-analyze") {
        const { fbUserId } = await cfg();
        if (!fbUserId) return sendResponse({ ok: false, reason: "no_profile" });
        const res = await api("/v1/facebook/analyze-group", {
          method: "POST",
          body: JSON.stringify({ fb_user_id: fbUserId, ...msg.payload }),
        });
        return sendResponse({ ok: res.ok, status: res.status, body: res.body });
      }
      if (msg?.type === "ofz-fb-result") {
        const res = await reportResult(msg.jobId, msg.result);
        return sendResponse({ ok: res.ok, status: res.status, body: res.body });
      }
      if (msg?.type === "ofz-fb-join-batch") {
        const { fbUserId } = await cfg();
        if (!fbUserId)
          return sendResponse({ ok: false, reason: "Configure o perfil do Facebook." });
        const groups = Array.isArray(msg.groups) ? msg.groups : [];
        if (
          !groups.length ||
          groups.length > 10 ||
          groups.some((g) => !/^[A-Za-z0-9.]{3,60}$/.test(g.id) || !g.name || g.name.length > 200)
        ) {
          return sendResponse({ ok: false, reason: "Seleção de grupos inválida." });
        }
        const state = await chrome.storage.local.get("fbJoinQueue");
        if (state.fbJoinQueue?.length)
          return sendResponse({ ok: false, reason: "Já existe uma fila de entrada em andamento." });
        await chrome.storage.local.set({ fbJoinQueue: groups });
        chrome.alarms.create(JOIN_ALARM, { periodInMinutes: 5 });
        void processJoinQueue().catch(() => {});
        return sendResponse({ ok: true });
      }
      if (msg?.type === "ofz-fb-tick") return sendResponse(await tick());
      sendResponse({ ok: false, reason: "unknown" });
    } catch (err) {
      sendResponse({ ok: false, reason: String(err) });
    }
  })();
  return true; // resposta assíncrona
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === TICK_ALARM) void tick().catch(() => {});
  if (a.name === JOIN_ALARM) void processJoinQueue().catch(() => {});
});

function ensureAlarm() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(JOIN_ALARM, { periodInMinutes: 5 });
  void tick().catch(() => {});
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
