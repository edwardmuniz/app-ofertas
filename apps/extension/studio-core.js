// Regras puras do Studio. O servidor continua decidindo se pode agendar cada post.
function ofzPublisherGroups(accounts, channels, fbUserId) {
  const account = accounts.find((item) => item.fb_user_id === fbUserId) || null;
  const facebookGroups = channels.filter((item) => item.type === "fb_group");
  const mine = account
    ? facebookGroups.filter((item) => item.facebook_account_id === account.id)
    : [];
  return {
    account,
    mine,
    eligible: mine.filter(
      (item) =>
        item.status === "active" &&
        ["allowed", "approval", "restricted"].includes(item.posting_policy),
    ),
    pending: mine.filter(
      (item) =>
        item.status === "active" &&
        (item.posting_policy === null || item.posting_policy === "unknown"),
    ),
    blocked: mine.filter((item) => item.status !== "active" || item.posting_policy === "forbidden"),
    otherProfiles: facebookGroups.length - mine.length,
  };
}

/**
 * Grupos cadastrados neste perfil que não vieram em "Meus grupos" (a pessoa saiu deles).
 * Só compara quando a lista do Facebook veio completa, e só grupos cadastrados pelo id
 * numérico: um cadastrado pelo nome do endereço não dá para conferir com a lista.
 */
function ofzLeftGroups(registered, myGroups, partial) {
  if (partial || !Array.isArray(myGroups) || !myGroups.length) return [];
  const current = new Set(myGroups.map((group) => String(group.id)));
  return registered.filter(
    (item) =>
      item.status !== "archived" &&
      /^\d+$/.test(String(item.external_id || "")) &&
      !current.has(String(item.external_id)),
  );
}

function ofzValidInviteLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.hostname === "chat.whatsapp.com") return /^\/[A-Za-z0-9]+\/?$/.test(url.pathname);
    return url.hostname === "go.ofzap.com.br" && /^\/entrar\/[A-Za-z0-9-]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}
