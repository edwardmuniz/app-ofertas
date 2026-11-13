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

function fbzCaptureComposer(body) {
  const params = new URLSearchParams(body);
  const docId = params.get("doc_id");
  const friendlyName = params.get("fb_api_req_friendly_name") || "";
  if (
    !/^\d+$/.test(docId || "") ||
    !/composer.*(?:create|publish|story)|(?:create|publish).*composer/i.test(friendlyName)
  )
    return null;
  let variables;
  try {
    variables = JSON.parse(params.get("variables") || "");
  } catch {
    return null;
  }
  const sampleGroupId =
    variables?.input?.audience?.to_id || fbzFirstField(variables, ["to_id", "group_id"], true);
  const sampleText = variables?.input?.message?.text || fbzFirstField(variables, ["text"]);
  const samplePhotoId =
    variables?.input?.attachments?.find((a) => a?.photo)?.photo?.id ||
    fbzFirstField(variables?.input?.attachments, ["id", "fbid", "photo_id"], true);
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

function fbzCapturePhotoUpload(url, method, body) {
  if (!(body instanceof FormData)) return null;
  let fileField = null;
  const fields = {};
  for (const [key, value] of body.entries()) {
    if (value instanceof Blob) {
      if (value.type.startsWith("image/")) fileField = key;
    } else if (!fbzSensitiveField(key)) fields[key] = value;
  }
  if (!fileField) return null;
  const target = new URL(url, location.href);
  if (target.origin !== location.origin) return null;
  for (const key of [...target.searchParams.keys()])
    if (fbzSensitiveField(key)) target.searchParams.delete(key);
  return { url: target.toString(), method: method || "POST", fields, fileField };
}

function fbzReplaceDeep(value, replacements) {
  if (typeof value === "string") {
    let result = value;
    for (const [from, to] of replacements) if (from) result = result.split(from).join(to);
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
    [calibration.sampleGroupId, groupId],
    [calibration.sampleText, text],
    [calibration.samplePhotoId, photoId],
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
  return fbzFirstField(data, ["photoID", "photo_id", "photoFbid", "id"], true);
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
    fbzCapturePhotoUpload,
    fbzReplaceDeep,
    fbzSessionParams,
    fbzComposerBody,
    fbzPhotoId,
    fbzGraphResult,
  };
