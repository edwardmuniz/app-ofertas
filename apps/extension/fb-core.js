// Regras puras do modo Facebook (spec 19), sem DOM nem rede: URLs de grupos, métricas visíveis,
// texto do trabalho e links de posts. Script comum para a página e para os testes.

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

/** Só links para a página principal de um grupo são candidatos da busca. */
function fbzGroupCandidateFromLink(url, name) {
  const id = fbzGroupIdFromUrl(url);
  const label = String(name || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!id || !label || label.length > 200) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^\/(?:groups)\/[^/]+\/?$/i.test(parsed.pathname)) return null;
  return { id, name: label, url: `https://www.facebook.com/groups/${encodeURIComponent(id)}/` };
}

/** Números apresentados junto ao resultado de busca; são pistas, não dados confirmados. */
function fbzVisibleMetrics(raw) {
  const text = String(raw || "").toLowerCase();
  const count = (value, scale) => {
    const normalized =
      scale > 1 ? value.replace(",", ".") : value.replace(/\./g, "").replace(",", ".");
    const number = Number(normalized);
    return Number.isFinite(number) ? Math.round(number * scale) : null;
  };
  const members = /([\d.,]+)\s*(mil|mi|million|milh[ãõ]o)?\s*(?:membros|members)/i.exec(text);
  const posts = /([\d.,]+)\+?\s*(?:posts?|publica[çc][õo]es)\s*(?:por|per)\s*(?:dia|day)/i.exec(
    text,
  );
  const scale = members?.[2] ? (/^(mi$|million|milh)/i.test(members[2]) ? 1_000_000 : 1_000) : 1;
  return {
    member_count: members ? count(members[1], scale) : null,
    posts_per_day: posts ? count(posts[1], 1) : null,
  };
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

// ── Análise do grupo: limpeza do texto visível (o servidor classifica) ──

/** Domínio de destino de um link do post (desembrulha l.facebook.com/l.php?u=…). */
function fbzOutboundHost(href) {
  let url;
  try {
    url = new URL(String(href || ""));
  } catch {
    return null;
  }
  if (/(^|\.)facebook\.com$/i.test(url.hostname) && url.pathname === "/l.php") {
    try {
      url = new URL(url.searchParams.get("u") || "");
    } catch {
      return null;
    }
  }
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (!host || /(^|\.)(facebook\.com|fbcdn\.net|fb\.com|fb\.me)$/.test(host)) return null;
  return host;
}

// Linhas de interface do Facebook que não dizem nada sobre o grupo.
const FBZ_UI_LINE =
  /^(facebook|classificar feed do grupo por|mais relevantes|novos posts|atividade recente|curtir|comentar|compartilhar|responder|seguir|enviar|ver mais|ver menos|ver tradução|traduzir|editado|autor|fã destaque|todas as reações:?|like|comment|share|reply|follow|see more|see translation|·|\d+|\d+\s*(min|h|d|sem|s|m|a)|\d+\s*(comentários?|compartilhamentos?|comments?|shares?))$/i;

/** Texto de um post sem a interface, com os domínios dos links no começo. Até 1000 caracteres. */
function fbzCleanPostText(text, hosts = []) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !FBZ_UI_LINE.test(line));
  const unique = [...new Set(hosts.filter(Boolean))];
  const head = unique.length ? `Links: ${unique.join(", ")}\n` : "";
  return (head + lines.join("\n")).slice(0, 1000);
}

/** Nome do grupo a partir do título da aba ("(3) Nome | Facebook" → "Nome"). */
function fbzGroupName(title) {
  return String(title || "")
    .replace(/^\(\d+\+?\)\s*/, "")
    .replace(/\s*[|·].*$/, "")
    .trim()
    .slice(0, 200);
}

/**
 * Junta o que foi lido em páginas diferentes do mesmo grupo (feed e aba Sobre),
 * sem repetir trechos. Respeita os limites da API (regras 8000, 40 posts).
 */
function fbzMergeCollected(prev, next) {
  const rules = [
    ...new Set(
      [prev?.rules_text, next?.rules_text]
        .flatMap((t) => String(t || "").split(/\n{2,}/))
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ]
    .join("\n\n")
    .slice(0, 8000);
  const posts = [...new Set([...(next?.post_texts || []), ...(prev?.post_texts || [])])].slice(
    0,
    40,
  );
  return { rules_text: rules, post_texts: posts };
}

// Carregável tanto na página (globais) quanto nos testes (module.exports).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    fbzGroupIdFromUrl,
    fbzIsGroupPage,
    fbzGroupCandidateFromLink,
    fbzVisibleMetrics,
    fbzJobMatchesPage,
    fbzComposerText,
    fbzPickVariation,
    fbzNormalizePostUrl,
    fbzFirstUrl,
    fbzOutboundHost,
    fbzCleanPostText,
    fbzGroupName,
    fbzMergeCollected,
  };
}
