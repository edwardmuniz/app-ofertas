// Dados de busca extraídos das respostas JSON do Facebook. Sem DOM e sem credenciais persistidas.
function fbzSearchCalibration(body) {
  let params;
  try {
    params = body instanceof URLSearchParams ? body : new URLSearchParams(body);
  } catch {
    return null;
  }
  const friendlyName = params.get("fb_api_req_friendly_name") || "";
  if (!/searchcometresults/i.test(friendlyName) || !/query/i.test(friendlyName)) return null;
  let variables;
  try {
    variables = JSON.parse(params.get("variables") || "");
  } catch {
    return null;
  }
  const query = variables?.args?.text;
  if (
    !params.get("doc_id") ||
    typeof query !== "string" ||
    !query.trim() ||
    !String(variables?.args?.callsite || "").includes("groups_search")
  )
    return null;
  return { params, variables, query };
}

function fbzSearchPortable(calibration) {
  const safeKeys = new Set(["fb_api_req_friendly_name", "fb_api_caller_class", "doc_id"]);
  return {
    params: Object.fromEntries([...calibration.params].filter(([key]) => safeKeys.has(key))),
    variables: calibration.variables,
    query: calibration.query,
  };
}

function fbzSearchRequest(calibration, query, cursor) {
  const params = new URLSearchParams(calibration.params);
  const variables = structuredClone(calibration.variables);
  const replaceQuery = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && child === calibration.query) value[key] = query;
      else replaceQuery(child);
    }
  };
  replaceQuery(variables);
  variables.args.text = query;
  if (cursor) {
    let replaced = false;
    const walk = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (/^(after|cursor)$/i.test(key)) {
          value[key] = cursor;
          replaced = true;
        } else walk(child);
      }
    };
    walk(variables);
    if (!replaced) variables.args.cursor = cursor;
  }
  params.set("variables", JSON.stringify(variables));
  return params;
}

function fbzSearchPage(raw) {
  const groups = new Map();
  let cursor = null;
  let error = null;
  const memberCount = (rawText) => {
    const match = /([\d.,]+)\s*(mil|mi|milh[oõ]es|million)?\s*(?:membros|members)/i.exec(
      rawText || "",
    );
    if (!match) return null;
    const scale = match[2] ? (/^(mi$|milh|million)/i.test(match[2]) ? 1_000_000 : 1_000) : 1;
    const normalized =
      scale > 1 ? match[1].replace(",", ".") : match[1].replace(/\./g, "").replace(",", ".");
    return Math.round(Number(normalized) * scale) || null;
  };
  const postsPerDay = (rawText) => {
    const match = /(\d+)\+?\s*(?:posts?|publica[cç][oõ]es)\s*(?:por|per)\s*(?:dia|day)/i.exec(
      rawText || "",
    );
    return match ? Number(match[1]) : null;
  };
  const add = (profile, view) => {
    const id = String(profile?.id || "");
    const name = typeof profile?.name === "string" ? profile.name.trim() : "";
    if (!/^\d{5,25}$/.test(id) || !name || name.length > 200) return;
    const snippets = [
      view?.primary_snippet_text_with_entities?.text,
      view?.snippet_with_facepile?.simple_text_with_entities?.text,
    ]
      .filter((part) => typeof part === "string")
      .join(" · ");
    const previous = groups.get(id);
    groups.set(id, {
      id,
      name,
      url: `https://www.facebook.com/groups/${id}/`,
      member_count: memberCount(snippets) ?? previous?.member_count ?? null,
      posts_per_day: postsPerDay(snippets) ?? previous?.posts_per_day ?? null,
    });
  };
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (value.page_info?.has_next_page && value.page_info.end_cursor)
      cursor = value.page_info.end_cursor;
    const profile = value.rendering_strategy?.view_model?.profile;
    if (profile?.__typename === "Group" || profile?.__isEntity === "Group")
      add(profile, value.rendering_strategy.view_model);
    else if (value.__typename === "Group" || value.__isEntity === "Group") add(value, null);
    for (const child of Object.values(value)) walk(child);
  };
  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.errors?.length && !error) error = parsed.errors[0]?.message || "Busca recusada.";
      walk(parsed);
    } catch {
      // Algumas linhas da resposta não são JSON.
    }
  }
  return { groups: [...groups.values()], cursor, error };
}

function fbzMyGroupsPage(raw) {
  for (const line of String(raw || "").split("\n")) {
    const text = line.trim().replace(/^for \(;;\);/, "");
    if (!text || text.startsWith("<")) continue;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      continue;
    }
    const list = payload?.data?.viewer?.groups_tab?.tab_groups_list;
    if (Array.isArray(list?.edges)) {
      const groups = list.edges
        .map((edge) => edge?.node)
        .filter((node) => /^\d{5,25}$/.test(String(node?.id || "")) && node?.name)
        .map((node) => ({
          id: String(node.id),
          name: String(node.name).slice(0, 200),
          url: `https://www.facebook.com/groups/${node.id}/`,
        }));
      return {
        groups,
        cursor: list.page_info?.has_next_page ? list.page_info?.end_cursor || null : null,
        error: null,
      };
    }
    if (payload.errors?.length)
      return { groups: [], cursor: null, error: payload.errors[0]?.message || "Busca recusada." };
  }
  return { groups: [], cursor: null, error: "O Facebook não retornou a lista de grupos." };
}
