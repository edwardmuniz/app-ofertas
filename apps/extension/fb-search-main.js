// Roda no contexto da página do Facebook. Os tokens ficam somente nesta aba.
(() => {
  if (window.__ofzFbSearchMain) return;
  window.__ofzFbSearchMain = true;
  const channel = "ofz-fb-search";
  const endpoint = "https://www.facebook.com/api/graphql/";
  const myGroupsQuery = "GroupsLeftRailYourGroupsPaginatedQuery";
  const fallbackMyGroupsDocId = "9658982227546884";
  let calibration = null;
  const nativeFetch = window.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const emit = (type, data) => window.postMessage({ channel, type, data }, location.origin);

  function capture(url, body) {
    try {
      const target = new URL(url, location.href);
      if (target.origin !== location.origin || target.pathname !== "/api/graphql/") return;
      const params = body instanceof URLSearchParams ? body : new URLSearchParams(body);
      if (
        params.get("fb_api_req_friendly_name") === myGroupsQuery &&
        /^\d+$/.test(params.get("doc_id") || "")
      )
        emit("groups_calibration", { docId: params.get("doc_id") });
      const found = fbzSearchCalibration(body);
      if (!found) return;
      calibration = found;
      emit("ready", { calibration: fbzSearchPortable(found) });
    } catch {
      // Outras chamadas do Facebook não fazem parte da busca de grupos.
    }
  }

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.body) capture(url, init.body);
    else if (input instanceof Request)
      void input
        .clone()
        .text()
        .then((body) => capture(url, body))
        .catch(() => {});
    return nativeFetch.call(this, input, init);
  };
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ofzSearchUrl = String(url);
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (body && this.__ofzSearchUrl) capture(this.__ofzSearchUrl, body);
    return nativeSend.call(this, body);
  };

  function activeSession() {
    const module = (name) => {
      try {
        return window.require?.(name);
      } catch {
        return null;
      }
    };
    const dtsg =
      module("DTSGInitialData")?.token || document.querySelector('input[name="fb_dtsg"]')?.value;
    const lsd = module("LSD")?.token || document.querySelector('input[name="lsd"]')?.value;
    const site = module("SiteData") || {};
    const userId = String(
      module("CurrentUser")?.getID?.() ||
        document.querySelector('input[name="__user"]')?.value ||
        "",
    );
    return {
      dtsg,
      lsd,
      userId,
      siteParams: {
        __spin_r: site.__spin_r,
        __spin_b: site.__spin_b,
        __spin_t: site.__spin_t,
        __rev: site.client_revision,
        __hsi: site.hsi,
      },
    };
  }

  function withCurrentSession(template) {
    const { dtsg, lsd, userId, siteParams } = activeSession();
    const params = new URLSearchParams(template.params);
    const token = dtsg || params.get("fb_dtsg");
    const actor = userId || params.get("__user");
    if (!token || !/^\d{5,25}$/.test(actor || "")) return null;
    params.set("fb_dtsg", token);
    params.set("jazoest", `2${[...token].reduce((sum, char) => sum + char.charCodeAt(0), 0)}`);
    params.set("__user", actor);
    params.set("av", actor);
    params.set("__a", "1");
    if (lsd || params.get("lsd")) params.set("lsd", lsd || params.get("lsd"));
    for (const [key, value] of Object.entries(siteParams))
      if (value !== undefined && value !== null) params.set(key, String(value));
    return { params, variables: template.variables, query: template.query };
  }

  function restore(saved) {
    if (calibration || !saved?.params || !saved?.variables || !saved?.query) return;
    calibration = withCurrentSession(saved);
    if (!calibration) return;
    emit("ready", {});
  }

  async function search({ query, limit }) {
    if (!calibration) return { ok: false, error: "calibration_missing" };
    const current = withCurrentSession(calibration);
    if (!current) return { ok: false, error: "Sessão do Facebook indisponível nesta aba." };
    const groups = new Map();
    let cursor = null;
    const seenCursors = new Set();
    for (let page = 0; page < 30 && groups.size < limit; page++) {
      const body = fbzSearchRequest(current, query, cursor);
      const response = await nativeFetch.call(window, endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const result = fbzSearchPage(await response.text());
      if (!response.ok || result.error)
        return {
          ok: false,
          groups: [...groups.values()],
          error: result.error || `Facebook respondeu ${response.status}.`,
        };
      const before = groups.size;
      for (const group of result.groups) groups.set(group.id, group);
      emit("progress", { page: page + 1, count: groups.size });
      if (!result.cursor || seenCursors.has(result.cursor) || groups.size === before) break;
      seenCursors.add(result.cursor);
      cursor = result.cursor;
    }
    return { ok: true, groups: [...groups.values()].slice(0, limit) };
  }

  async function myGroups(docId) {
    const current = withCurrentSession({ params: new URLSearchParams(), variables: {}, query: "" });
    if (!current) return { ok: false, error: "Sessão do Facebook indisponível nesta aba." };
    const documentId = /^\d+$/.test(String(docId || "")) ? String(docId) : fallbackMyGroupsDocId;
    const groups = new Map();
    const started = Date.now();
    for (const listType of ["ADMIN_MODERATOR_GROUPS", "NON_ADMIN_MODERATOR_GROUPS"]) {
      let cursor = null;
      const seen = new Set();
      for (let page = 0; page < 50; page++) {
        if (Date.now() - started > 55_000)
          return {
            ok: groups.size > 0,
            partial: groups.size > 0,
            groups: [...groups.values()],
            fbUserId: activeSession().userId,
            error: groups.size
              ? null
              : "A consulta dos seus grupos excedeu um minuto. Tente novamente.",
          };
        const params = new URLSearchParams(current.params);
        params.set("__comet_req", "15");
        params.set("fb_api_caller_class", "RelayModern");
        params.set("fb_api_req_friendly_name", myGroupsQuery);
        params.set("server_timestamps", "true");
        params.set("doc_id", documentId);
        params.set("variables", JSON.stringify({ count: 10, cursor, listType, scale: 2 }));
        const controller = new AbortController();
        let timeout;
        let response;
        let raw;
        try {
          ({ response, raw } = await Promise.race([
            nativeFetch
              .call(window, endpoint, {
                method: "POST",
                credentials: "same-origin",
                signal: controller.signal,
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  "X-FB-Friendly-Name": myGroupsQuery,
                  ...(params.get("lsd") ? { "X-FB-LSD": params.get("lsd") } : {}),
                },
                body: params.toString(),
              })
              .then(async (response) => ({ response, raw: await response.text() })),
            new Promise((_, reject) => {
              timeout = setTimeout(() => {
                controller.abort();
                reject(new Error("O Facebook demorou demais para responder."));
              }, 12_000);
            }),
          ]));
        } catch (error) {
          return {
            ok: groups.size > 0,
            partial: groups.size > 0,
            groups: [...groups.values()],
            fbUserId: activeSession().userId,
            error: groups.size ? null : String(error?.message || error),
          };
        } finally {
          clearTimeout(timeout);
        }
        const result = fbzMyGroupsPage(raw);
        if (!response.ok || result.error)
          return {
            ok: groups.size > 0,
            partial: groups.size > 0,
            groups: [...groups.values()],
            fbUserId: activeSession().userId,
            error: groups.size
              ? null
              : `${result.error || `Facebook respondeu ${response.status}.`} Abra a área Grupos no Facebook, atualize a página e tente novamente.`,
          };
        const before = groups.size;
        for (const group of result.groups) groups.set(group.id, group);
        emit("my_groups_progress", { count: groups.size, page: page + 1, listType });
        if (!result.cursor || seen.has(result.cursor) || groups.size === before) break;
        seen.add(result.cursor);
        cursor = result.cursor;
      }
    }
    return { ok: true, groups: [...groups.values()], fbUserId: activeSession().userId };
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== channel
    )
      return;
    if (event.data.type === "probe") {
      if (!calibration) restore(event.data.calibration);
      if (calibration) emit("ready", { calibration: fbzSearchPortable(calibration) });
      return;
    }
    if (event.data.type === "my_groups") {
      const requestId = event.data.requestId;
      void myGroups(event.data.docId)
        .then((result) => emit("result", { requestId, ...result }))
        .catch((error) => emit("result", { requestId, ok: false, error: String(error) }));
      return;
    }
    if (event.data.type !== "search") return;
    const requestId = event.data.requestId;
    const query = String(event.data.query || "")
      .trim()
      .slice(0, 160);
    const limit = Math.min(100, Math.max(1, Number(event.data.limit) || 100));
    if (!query)
      return emit("result", { requestId, ok: false, error: "Informe um termo de busca." });
    void search({ query, limit })
      .then((result) => emit("result", { requestId, ...result }))
      .catch((error) => emit("result", { requestId, ok: false, error: String(error) }));
  });
})();
