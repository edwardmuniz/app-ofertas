// Regras puras da calibração de um post com imagem. Não guarda tokens de sessão.
const FBZ_SESSION_FIELDS = new Set([
  "fb_dtsg",
  "jazoest",
  "lsd",
  "__user",
  "av",
  "__spin_r",
  "__spin_b",
  "__spin_t",
  "__rev",
  "__hsi",
]);
const fbzSensitiveField = (key) =>
  FBZ_SESSION_FIELDS.has(key) || /(?:token|csrf|session|cookie|secret|nonce)/i.test(key);

function fbzWalk(value, visit, path = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const next = [...path, key];
    visit(key, child, next);
    fbzWalk(child, visit, next);
  }
}

function fbzFirstField(value, names, numeric = false) {
  let found = null;
  fbzWalk(value, (key, child) => {
    if (found || !names.includes(key)) return;
    if (typeof child !== "string" && typeof child !== "number") return;
    const text = String(child);
    if (numeric && !/^\d{5,}$/.test(text)) return;
    if (text) found = text;
  });
  return found;
}

const FBZ_MIN_SAMPLE_TEXT = 12;
const FBZ_COMPOSER_NAME = /composer.*(?:create|publish|story)|(?:create|publish).*composer/i;

/**
 * A publicação é uma mutação GraphQL do composer. Consultas com nome parecido (prévia,
 * menções, público) disparam enquanto o composer está aberto e não são a publicação.
 */
function fbzComposerMutation(params) {
  const docId = params.get("doc_id");
  const friendlyName = params.get("fb_api_req_friendly_name") || "";
  if (!/^\d+$/.test(docId || "")) return null;
  if (!FBZ_COMPOSER_NAME.test(friendlyName) || !/mutation/i.test(friendlyName)) return null;
  return { docId, friendlyName };
}

function fbzComposerSamples(variables) {
  return {
    sampleGroupId:
      variables?.input?.audience?.to_id || fbzFirstField(variables, ["to_id", "group_id"], true),
    sampleText: variables?.input?.message?.text || fbzFirstField(variables, ["text"]),
    samplePhotoId:
      variables?.input?.attachments?.find((a) => a?.photo)?.photo?.id ||
      fbzFirstField(variables?.input?.attachments, ["id", "fbid", "photo_id"], true),
  };
}

/**
 * Para uma mutação do composer que não deu para capturar, diz o que faltou
 * (para a mensagem ao usuário). Devolve null se não é a publicação.
 */
function fbzComposerDiagnosis(body) {
  let params;
  try {
    params = new URLSearchParams(body);
  } catch {
    return null;
  }
  const mutation = fbzComposerMutation(params);
  if (!mutation) return null;
  let variables;
  try {
    variables = JSON.parse(params.get("variables") || "");
  } catch {
    return { friendlyName: mutation.friendlyName, missing: ["variáveis"] };
  }
  const samples = fbzComposerSamples(variables);
  const missing = [];
  if (!samples.sampleGroupId) missing.push("grupo");
  if (!samples.sampleText) missing.push("texto");
  if (!samples.samplePhotoId) missing.push("foto");
  return { friendlyName: mutation.friendlyName, missing };
}

/** Motivo para recusar uma calibração capturada, ou null se ela pode ser usada. */
function fbzCalibrationIssue(composer) {
  const text = String(composer?.sampleText || "").trim();
  if (text.length < FBZ_MIN_SAMPLE_TEXT)
    return `Use um texto de teste com pelo menos ${FBZ_MIN_SAMPLE_TEXT} caracteres (ex.: "Teste OfZap 4821") e publique de novo.`;
  return null;
}

function fbzCaptureComposer(body) {
  const params = new URLSearchParams(body);
  const mutation = fbzComposerMutation(params);
  if (!mutation) return null;
  const { docId, friendlyName } = mutation;
  let variables;
  try {
    variables = JSON.parse(params.get("variables") || "");
  } catch {
    return null;
  }
  const { sampleGroupId, sampleText, samplePhotoId } = fbzComposerSamples(variables);
  if (!sampleGroupId || !sampleText || !samplePhotoId) return null;
  const safeParams = {};
  for (const [key, value] of params) {
    if (
      !fbzSensitiveField(key) &&
      !["doc_id", "variables", "fb_api_req_friendly_name"].includes(key)
    )
      safeParams[key] = value;
  }
  return {
    docId,
    friendlyName,
    variables,
    params: safeParams,
    sampleGroupId: String(sampleGroupId),
    sampleText: String(sampleText),
    samplePhotoId: String(samplePhotoId),
  };
}

/** URL https do Facebook (inclui subdomínios como upload.facebook.com, usado nas fotos). */
function fbzFacebookUrl(url) {
  let target;
  try {
    target = new URL(url, location.href);
  } catch {
    return null;
  }
  if (target.protocol !== "https:") return null;
  if (!/(^|\.)facebook\.com$/i.test(target.hostname)) return null;
  return target;
}

function fbzImageBlob(value) {
  if (!(value instanceof Blob)) return false;
  if (value.type.startsWith("image/")) return true;
  return !value.type && /\.(jpe?g|png|webp|gif|heic)$/i.test(value.name || "");
}

function fbzCapturePhotoUpload(url, method, body) {
  if (!(body instanceof FormData)) return null;
  const target = fbzFacebookUrl(url);
  if (!target) return null;
  let fileField = null;
  const fields = {};
  const fieldSessionKeys = [];
  for (const [key, value] of body.entries()) {
    if (value instanceof Blob) {
      if (fbzImageBlob(value)) fileField = key;
    } else if (fbzSensitiveField(key)) fieldSessionKeys.push(key);
    else fields[key] = value;
  }
  if (!fileField) return null;
  // Guarda só os nomes dos campos de sessão, para preencher com os valores atuais na hora.
  const urlSessionKeys = [];
  for (const key of [...target.searchParams.keys()])
    if (fbzSensitiveField(key)) {
      urlSessionKeys.push(key);
      target.searchParams.delete(key);
    }
  return {
    url: target.toString(),
    method: method || "POST",
    fields,
    fileField,
    sessionKeys: { url: [...new Set(urlSessionKeys)], fields: [...new Set(fieldSessionKeys)] },
  };
}

/**
 * data: URL → Blob sem fetch. A política de segurança (CSP) do Facebook bloqueia fetch de
 * data: nos scripts da página ("Failed to fetch").
 */
function fbzDataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!m) return null;
  const [, type, base64, payload] = m;
  let bytes;
  if (base64) {
    const bin = atob(payload);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return new Blob([bytes], { type });
}

/** Valores atuais da sessão por nome de campo (inclui __user/av e jazoest). */
function fbzSessionValues(session, userId) {
  const values = fbzSessionParams({}, session);
  if (userId) {
    values.set("__user", String(userId));
    values.set("av", String(userId));
  }
  return values;
}

/**
 * Troca valores de amostra em toda a estrutura. Cada troca é [de, para, exata]:
 * exata=true só troca strings idênticas (texto do post), para não corromper outros campos.
 */
function fbzReplaceDeep(value, replacements) {
  if (typeof value === "string") {
    for (const [from, to, exact] of replacements) if (exact && from && value === from) return to;
    let result = value;
    for (const [from, to, exact] of replacements)
      if (!exact && from) result = result.split(from).join(to);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => fbzReplaceDeep(item, replacements));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, fbzReplaceDeep(child, replacements)]),
    );
  return value;
}

function fbzSessionParams(params, session) {
  const out = new URLSearchParams(params);
  for (const [key, value] of Object.entries(session)) if (value) out.set(key, String(value));
  if (session.fb_dtsg)
    out.set("jazoest", `2${[...session.fb_dtsg].reduce((sum, c) => sum + c.charCodeAt(0), 0)}`);
  return out;
}

function fbzComposerBody(calibration, groupId, text, photoId, userId, session) {
  const replacements = [
    [calibration.sampleGroupId, groupId, false],
    [calibration.sampleText, text, true],
    [calibration.samplePhotoId, photoId, false],
  ];
  const vars = fbzReplaceDeep(calibration.variables, replacements);
  if (vars?.input?.audience) vars.input.audience.to_id = groupId;
  if (vars?.input?.message) vars.input.message.text = text;
  const params = fbzSessionParams(calibration.params, session);
  params.set("doc_id", calibration.docId);
  params.set("fb_api_req_friendly_name", calibration.friendlyName);
  params.set("variables", JSON.stringify(vars));
  if (userId) {
    params.set("__user", userId);
    params.set("av", userId);
  }
  return params;
}

function fbzPhotoId(responseText) {
  let data;
  try {
    data = JSON.parse(
      String(responseText)
        .replace(/^for\s*\(;;\);/, "")
        .trim(),
    );
  } catch {
    return null;
  }
  // Nomes específicos primeiro; "id" genérico só se nenhum deles aparecer.
  for (const name of ["photoID", "photo_id", "photoFbid", "photo_fbid", "fbid"]) {
    const found = fbzFirstField(data, [name], true);
    if (found) return found;
  }
  return fbzFirstField(data, ["id"], true);
}

function fbzGraphResult(responseText) {
  let data;
  try {
    data = JSON.parse(String(responseText).trim().split("\n")[0]);
  } catch {
    return { ok: false, reason: "Resposta inválida do Facebook." };
  }
  if (data.errors?.length)
    return { ok: false, reason: String(data.errors[0]?.message || "Facebook recusou o post.") };
  const postId = fbzFirstField(
    data.data || data,
    ["post_id", "postId", "story_id", "storyId"],
    true,
  );
  return postId
    ? { ok: true, postId }
    : { ok: false, reason: "O Facebook não confirmou o id do post." };
}

if (typeof module !== "undefined" && module.exports)
  module.exports = {
    fbzCaptureComposer,
    fbzCalibrationIssue,
    fbzComposerDiagnosis,
    fbzCapturePhotoUpload,
    fbzFacebookUrl,
    fbzSessionValues,
    fbzDataUrlToBlob,
    fbzReplaceDeep,
    fbzSessionParams,
    fbzComposerBody,
    fbzPhotoId,
    fbzGraphResult,
  };
