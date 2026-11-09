// Executado somente quando a pessoa pede para ler os resultados visíveis da aba de busca.
// Não consulta APIs internas, não percorre páginas e não entra em grupos.
(() => {
  if (!/^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\/search\/groups\/?/i.test(location.href)) {
    return { error: "Abra uma busca de grupos do Facebook nesta aba." };
  }
  const found = new Map();
  for (const anchor of document.querySelectorAll('a[href*="/groups/"]')) {
    if (anchor.closest("#ofz-fb-dock")) continue;
    const name = (anchor.innerText || anchor.getAttribute("aria-label") || "").trim();
    const candidate = fbzGroupCandidateFromLink(anchor.href, name);
    if (candidate && !found.has(candidate.id)) found.set(candidate.id, candidate);
    if (found.size >= 40) break;
  }
  return { groups: [...found.values()] };
})();
