// Ponte isolada: o Studio pede a busca; a sessão e as requisições ficam na aba do Facebook.
(() => {
  if (globalThis.__ofzFbSearchBridge) return;
  globalThis.__ofzFbSearchBridge = true;
  const channel = "ofz-fb-search";
  let ready = false;
  let savedCalibration = null;
  let myGroupsDocId = null;
  const pending = new Map();
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== channel
    )
      return;
    const { type, data } = event.data;
    if (type === "ready") {
      ready = true;
      if (data?.calibration) {
        savedCalibration = data.calibration;
        void chrome.storage.local.set({ fbSearchCalibration: savedCalibration });
      }
    }
    if (type === "groups_calibration" && /^\d+$/.test(data?.docId || "")) {
      myGroupsDocId = data.docId;
      void chrome.storage.local.set({ fbMyGroupsDocId: myGroupsDocId });
    }
    if (type === "my_groups_progress")
      void chrome.runtime
        .sendMessage({ type: "ofz-fb-my-groups-progress", count: data.count })
        .catch(() => {});
    if (type === "result" && pending.has(data?.requestId)) {
      pending.get(data.requestId)(data);
      pending.delete(data.requestId);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (!["ofz-fb-search", "ofz-fb-my-groups"].includes(message?.type)) return;
    const isMyGroups = message.type === "ofz-fb-my-groups";
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const wait = () => {
      if (!ready && !isMyGroups) {
        window.postMessage(
          { channel, type: "probe", calibration: savedCalibration },
          location.origin,
        );
        if (Date.now() - started > 10000)
          return reply({
            ok: false,
            error:
              "Busca não calibrada. Faça uma busca normal de grupos no Facebook uma vez e tente novamente.",
          });
        setTimeout(wait, 250);
        return;
      }
      const timeout = setTimeout(
        () => {
          pending.delete(requestId);
          reply({ ok: false, error: "A consulta do Facebook demorou demais. Tente novamente." });
        },
        isMyGroups ? 65_000 : 90_000,
      );
      pending.set(requestId, (result) => {
        clearTimeout(timeout);
        reply(result);
      });
      window.postMessage(
        isMyGroups
          ? { channel, type: "my_groups", requestId, docId: myGroupsDocId }
          : { channel, type: "search", requestId, query: message.query, limit: message.limit },
        location.origin,
      );
    };
    void chrome.storage.local
      .get(["fbSearchCalibration", "fbMyGroupsDocId"])
      .then((state) => {
        savedCalibration = state.fbSearchCalibration || null;
        myGroupsDocId = state.fbMyGroupsDocId || null;
        wait();
      })
      .catch(() => reply({ ok: false, error: "Não consegui ler a calibração local." }));
    return true;
  });
})();
