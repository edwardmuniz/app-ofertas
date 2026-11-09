// Regras puras do modo Facebook (spec 19), sem DOM nem rede: casar a aba do grupo com o
// trabalho da fila, escolher uma variação de texto livre e validar/normalizar o link do post
// que o usuário cola depois de publicar. Script comum (sem import/export): roda na página e é
// carregado pelos testes. A extensão NÃO publica sozinha: ela prepara o post e a pessoa confirma
// no próprio Facebook. Nada aqui lê tokens de sessão nem chama endpoints internos do Facebook.

/** Id (ou vanity) do grupo a partir da URL da aba. `/groups/123/...` → "123". */
function fbzGroupIdFromUrl(url) {
  const m = /^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/groups\/([^/?#]+)/i.exec(
    String(url || ""),
  );
  if (!m) return null;
  const seg = decodeURIComponent(m[1]);
  // "user/..." e afins não são um grupo.
  return seg && seg !== "feed" && seg !== "joins" && seg !== "discover" ? seg : null;
}

/** A aba está numa página de grupo do Facebook? */
function fbzIsGroupPage(url) {
  return fbzGroupIdFromUrl(url) !== null;
}

/**
 * O trabalho é para o grupo que está aberto nesta aba? O grupo pode vir como id numérico ou
 * como nome (vanity), então aceitamos o casamento quando qualquer um dos lados bate.
 */
function fbzJobMatchesPage(job, pageUrl) {
  const page = fbzGroupIdFromUrl(pageUrl);
  if (!page) return { ok: false, reason: "not_group" };
  const target = String(job?.group_id ? job.group_id : "");
  if (!target) return { ok: false, reason: "no_target" };
  if (page === target) return { ok: true };
  return { ok: false, reason: "other_group" };
}

/**
 * Texto a preencher no composer. O backend já monta o texto final (com preço, cupom e link
 * rastreado). Se, mesmo assim, vier um texto livre com variações separadas por uma linha "---",
 * escolhe uma de forma estável pelo id do trabalho (não sorteia a cada abertura).
 */
function fbzComposerText(job) {
  const raw = job && typeof job.text === "string" ? job.text : "";
  return fbzPickVariation(raw, job?.id ? String(job.id) : "");
}

function fbzPickVariation(text, seed) {
  const parts = String(text || "")
    .split(/\r?\n-{3,}\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return String(text || "").trim();
  let h = 0;
  for (const ch of String(seed || "x")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return parts[h % parts.length];
}

const FBZ_POST_PATHS = [
  /\/groups\/[^/]+\/(?:posts|permalink)\/(\d+)/i,
  /\/permalink\.php\?story_fbid=([\w.]+)/i,
  /\/groups\/[^/]+\/\?(?:multi_permalinks|comment_id)=/i,
];

/** A pessoa pode colar o link junto com outro texto: pega a primeira URL do Facebook. */
function fbzFirstUrl(raw) {
  const m = /(https?:\/\/[^\s"'<>]+)/i.exec(String(raw || ""));
  return m ? m[1] : null;
}

/**
 * Valida e limpa o link do post publicado que a pessoa cola. Aceita os formatos de post de grupo
 * do Facebook, confere (quando dá) que é do grupo certo e remove a querystring de rastreamento.
 * Devolve { ok, url } ou { ok:false, reason }.
 */
function fbzNormalizePostUrl(raw, groupId) {
  const found = fbzFirstUrl(raw);
  if (!found) return { ok: false, reason: "empty" };
  let u;
  try {
    u = new URL(found);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return { ok: false, reason: "not_facebook" };
  const path = `${u.pathname}${u.search}`;
  const isPost = FBZ_POST_PATHS.some((re) => re.test(path));
  if (!isPost) return { ok: false, reason: "not_a_post" };
  if (groupId && /\/groups\/([^/?#]+)/i.test(u.pathname)) {
    const gid = decodeURIComponent(RegExp.$1);
    if (gid !== String(groupId)) return { ok: false, reason: "other_group" };
  }
  // permalink.php precisa dos parâmetros; nas demais, o caminho já identifica o post.
  if (/permalink\.php/i.test(u.pathname)) {
    const keep = new URLSearchParams();
    for (const k of ["story_fbid", "id"])
      if (u.searchParams.get(k)) keep.set(k, u.searchParams.get(k));
    return { ok: true, url: `https://www.facebook.com${u.pathname}?${keep.toString()}` };
  }
  return { ok: true, url: `https://www.facebook.com${u.pathname.replace(/\/+$/, "")}/` };
}

// Carregável tanto na página (globais) quanto nos testes (module.exports).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    fbzGroupIdFromUrl,
    fbzIsGroupPage,
    fbzJobMatchesPage,
    fbzComposerText,
    fbzPickVariation,
    fbzNormalizePostUrl,
    fbzFirstUrl,
  };
}
