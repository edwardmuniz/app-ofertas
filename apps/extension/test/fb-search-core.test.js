import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../fb-search-core.js", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../fb-search-main.js", import.meta.url), "utf8");
const core = runInNewContext(
  `${source}\n({ fbzSearchCalibration, fbzSearchPortable, fbzSearchRequest, fbzSearchPage, fbzMyGroupsPage })`,
  {
    URLSearchParams,
    structuredClone,
  },
);

describe("busca de grupos na sessão do Facebook", () => {
  it("lê grupos dos quais o perfil participa e o cursor seguinte", () => {
    const response = JSON.stringify({
      data: {
        viewer: {
          groups_tab: {
            tab_groups_list: {
              edges: [{ node: { id: "123456", name: "Grupo atual" } }],
              page_info: { has_next_page: true, end_cursor: "next" },
            },
          },
        },
      },
    });
    expect(core.fbzMyGroupsPage(`for (;;);${response}`)).toEqual({
      groups: [
        { id: "123456", name: "Grupo atual", url: "https://www.facebook.com/groups/123456/" },
      ],
      cursor: "next",
      error: null,
    });
  });

  it("consulta grupos já participados com a sessão ativa e sem expor o token", async () => {
    const messages = [];
    const listeners = [];
    const requests = [];
    const window = {
      fetch: async (_url, init) => {
        if (init?.credentials) requests.push(new URLSearchParams(init.body));
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              data: {
                viewer: {
                  groups_tab: {
                    tab_groups_list: {
                      edges: [{ node: { id: "123456", name: "Meu grupo" } }],
                      page_info: { has_next_page: false },
                    },
                  },
                },
              },
            }),
        };
      },
      require: (name) => {
        if (name === "DTSGInitialData") return { token: "token-atual" };
        if (name === "CurrentUser") return { getID: () => "123456789" };
        return null;
      },
      addEventListener: (_name, listener) => listeners.push(listener),
      postMessage: (data) => {
        messages.push(data);
        for (const listener of listeners)
          listener({ source: window, origin: "https://www.facebook.com", data });
      },
    };
    const XMLHttpRequest = class {
      open() {}
      send() {}
    };
    runInNewContext(`${source}\n${mainSource}`, {
      URL,
      URLSearchParams,
      Request,
      AbortController,
      setTimeout,
      clearTimeout,
      XMLHttpRequest,
      structuredClone,
      document: { querySelector: () => null },
      location: { href: "https://www.facebook.com/", origin: "https://www.facebook.com" },
      window,
    });
    window.postMessage({
      channel: "ofz-fb-search",
      type: "my_groups",
      requestId: "mine",
      docId: "987654",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    expect(requests[0].get("doc_id")).toBe("987654");
    expect(requests[0].get("fb_dtsg")).toBe("token-atual");
    expect(JSON.parse(requests[1].get("variables")).listType).toBe("NON_ADMIN_MODERATOR_GROUPS");
    expect(messages.find((item) => item.type === "result")?.data.groups).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("token-atual");
  });

  it("encerra a consulta quando o Facebook não responde", async () => {
    const messages = [];
    const listeners = [];
    const window = {
      fetch: () => new Promise(() => {}),
      require: (name) => {
        if (name === "DTSGInitialData") return { token: "token-atual" };
        if (name === "CurrentUser") return { getID: () => "123456789" };
        return null;
      },
      addEventListener: (_name, listener) => listeners.push(listener),
      postMessage: (data) => {
        messages.push(data);
        for (const listener of listeners)
          listener({ source: window, origin: "https://www.facebook.com", data });
      },
    };
    const XMLHttpRequest = class {
      open() {}
      send() {}
    };
    runInNewContext(`${source}\n${mainSource}`, {
      URL,
      URLSearchParams,
      Request,
      AbortController,
      XMLHttpRequest,
      structuredClone,
      setTimeout: (callback) => setTimeout(callback, 1),
      clearTimeout,
      document: { querySelector: () => null },
      location: { href: "https://www.facebook.com/", origin: "https://www.facebook.com" },
      window,
    });
    window.postMessage({ channel: "ofz-fb-search", type: "my_groups", requestId: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = messages.find((item) => item.type === "result")?.data;
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("demorou demais");
  });

  it("preserva os grupos recebidos quando a página seguinte trava", async () => {
    const messages = [];
    const listeners = [];
    let requests = 0;
    const window = {
      fetch: () => {
        requests++;
        if (requests > 1) return new Promise(() => {});
        return Promise.resolve({
          ok: true,
          text: async () =>
            JSON.stringify({
              data: {
                viewer: {
                  groups_tab: {
                    tab_groups_list: {
                      edges: [{ node: { id: "123456", name: "Grupo recebido" } }],
                      page_info: { has_next_page: true, end_cursor: "next" },
                    },
                  },
                },
              },
            }),
        });
      },
      require: (name) =>
        name === "DTSGInitialData"
          ? { token: "token-atual" }
          : name === "CurrentUser"
            ? { getID: () => "123456789" }
            : null,
      addEventListener: (_name, listener) => listeners.push(listener),
      postMessage: (data) => {
        messages.push(data);
        for (const listener of listeners)
          listener({ source: window, origin: "https://www.facebook.com", data });
      },
    };
    const XMLHttpRequest = class {
      open() {}
      send() {}
    };
    runInNewContext(`${source}\n${mainSource}`, {
      URL,
      URLSearchParams,
      Request,
      AbortController,
      XMLHttpRequest,
      structuredClone,
      setTimeout: (callback) => setTimeout(callback, 1),
      clearTimeout,
      document: { querySelector: () => null },
      location: { href: "https://www.facebook.com/", origin: "https://www.facebook.com" },
      window,
    });
    window.postMessage({ channel: "ofz-fb-search", type: "my_groups", requestId: "partial" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = messages.find((item) => item.type === "result")?.data;
    expect(result?.ok).toBe(true);
    expect(result?.partial).toBe(true);
    expect(result?.groups[0].name).toBe("Grupo recebido");
  });

  it("reconhece só uma consulta de grupos e troca termo e cursor", () => {
    const body = new URLSearchParams({
      fb_api_req_friendly_name: "SearchCometResultsInitialResultsQuery",
      doc_id: "123456",
      variables: JSON.stringify({
        args: { text: "achadinhos", callsite: "groups_search", cursor: null },
      }),
    });
    const cal = core.fbzSearchCalibration(body);
    expect(cal?.query).toBe("achadinhos");
    const changed = core.fbzSearchRequest(cal, "tecnologia", "próxima");
    expect(JSON.parse(changed.get("variables")).args).toMatchObject({
      text: "tecnologia",
      cursor: "próxima",
    });
    expect(
      core.fbzSearchCalibration(
        new URLSearchParams({
          ...Object.fromEntries(body),
          fb_api_req_friendly_name: "OtherQuery",
        }),
      ),
    ).toBeNull();
  });

  it("lê grupos, métricas e paginação do JSON sem consultar HTML", () => {
    const page = JSON.stringify({
      data: {
        search: {
          page_info: { has_next_page: true, end_cursor: "cursor-2" },
          edges: [
            {
              node: {
                rendering_strategy: {
                  view_model: {
                    profile: {
                      __typename: "Group",
                      id: "123456",
                      name: "Achadinhos de tecnologia",
                    },
                    primary_snippet_text_with_entities: {
                      text: "Público · 4,5 mil membros · 30 posts por dia",
                    },
                  },
                },
              },
            },
          ],
        },
      },
    });
    const result = core.fbzSearchPage(page);
    expect(result.cursor).toBe("cursor-2");
    expect(result.groups).toEqual([
      {
        id: "123456",
        name: "Achadinhos de tecnologia",
        url: "https://www.facebook.com/groups/123456/",
        member_count: 4500,
        posts_per_day: 30,
      },
    ]);
  });

  it("consulta o Facebook na aba e devolve grupos ao Studio sem expor os tokens", async () => {
    const messages = [];
    const listeners = [];
    const requestBody = new URLSearchParams({
      fb_api_req_friendly_name: "SearchCometResultsInitialResultsQuery",
      doc_id: "123456",
      fb_dtsg: "token-da-sessao",
      __user: "123456789",
      variables: JSON.stringify({ args: { text: "amostra", callsite: "groups_search" } }),
    });
    const reply = JSON.stringify({
      data: { results: [{ __typename: "Group", id: "123456", name: "Grupo de tecnologia" }] },
    });
    let replayBody;
    const window = {
      fetch: async (_url, init) => {
        if (init?.credentials) replayBody = new URLSearchParams(init.body);
        return { ok: true, text: async () => reply };
      },
      addEventListener: (_name, listener) => listeners.push(listener),
      postMessage: (data) => {
        messages.push(data);
        for (const listener of listeners)
          listener({ source: window, origin: "https://www.facebook.com", data });
      },
    };
    const XMLHttpRequest = class {
      open() {}
      send() {}
    };
    runInNewContext(`${source}\n${mainSource}`, {
      URL,
      URLSearchParams,
      Request,
      XMLHttpRequest,
      structuredClone,
      document: { querySelector: () => null },
      location: {
        href: "https://www.facebook.com/search/groups/",
        origin: "https://www.facebook.com",
      },
      window,
    });
    await window.fetch("https://www.facebook.com/api/graphql/", { body: requestBody });
    window.postMessage({
      channel: "ofz-fb-search",
      type: "search",
      requestId: "r1",
      query: "tecnologia",
      limit: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replayBody.get("fb_dtsg")).toBe("token-da-sessao");
    expect(JSON.parse(replayBody.get("variables")).args.text).toBe("tecnologia");
    expect(messages.find((item) => item.type === "result")?.data.groups[0]?.name).toBe(
      "Grupo de tecnologia",
    );
    expect(JSON.stringify(messages)).not.toContain("token-da-sessao");
    const portable = messages.find((item) => item.type === "ready")?.data.calibration;
    expect(portable?.params.doc_id).toBe("123456");
    expect(JSON.stringify(portable)).not.toContain("token-da-sessao");

    const restoredMessages = [];
    const restoredListeners = [];
    let restoredBody;
    const restoredWindow = {
      fetch: async (_url, init) => {
        restoredBody = new URLSearchParams(init.body);
        return { ok: true, text: async () => reply };
      },
      require: (name) => {
        if (name === "DTSGInitialData") return { token: "token-atual" };
        if (name === "CurrentUser") return { getID: () => "123456789" };
        if (name === "SiteData") return { client_revision: 3456 };
        return null;
      },
      addEventListener: (_name, listener) => restoredListeners.push(listener),
      postMessage: (data) => {
        restoredMessages.push(data);
        for (const listener of restoredListeners)
          listener({ source: restoredWindow, origin: "https://www.facebook.com", data });
      },
    };
    runInNewContext(`${source}\n${mainSource}`, {
      URL,
      URLSearchParams,
      Request,
      XMLHttpRequest,
      structuredClone,
      document: { querySelector: () => null },
      location: { href: "https://www.facebook.com/", origin: "https://www.facebook.com" },
      window: restoredWindow,
    });
    restoredWindow.postMessage({ channel: "ofz-fb-search", type: "probe", calibration: portable });
    restoredWindow.postMessage({
      channel: "ofz-fb-search",
      type: "search",
      requestId: "r2",
      query: "casa",
      limit: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restoredBody.get("fb_dtsg")).toBe("token-atual");
    expect(restoredBody.get("av")).toBe("123456789");
    expect(restoredBody.get("__rev")).toBe("3456");
    expect(restoredMessages.find((item) => item.type === "result")?.data.ok).toBe(true);
  });
});
