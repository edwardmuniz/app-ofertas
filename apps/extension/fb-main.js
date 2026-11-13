// Mundo MAIN: observa uma publicação manual com foto e repete o formato capturado.
// A calibração fica somente no armazenamento local da extensão; tokens são lidos de novo na hora.
(() => {
  const CHANNEL = "ofz-facebook-main";
  let armed = false;
  let upload = null;
  let replaying = false;
  let publishing = false;
  const emit = (type, data) =>
    window.postMessage({ channel: CHANNEL, type, data }, location.origin);

  function inspect(url, method, body) {
    if (!armed || replaying || !body) return;
    try {
      const target = new URL(url, location.href);
      if (target.origin !== location.origin) return;
      const photo = fbzCapturePhotoUpload(target.href, method, body);
      if (photo) {
        upload = photo;
        emit("upload_seen", {});
        return;
      }
      if (!target.pathname.includes("/api/graphql/")) return;
      let encoded = body;
      if (body instanceof FormData)
        encoded = new URLSearchParams([...body.entries()].filter(([, v]) => typeof v === "string"));
      const composer = fbzCaptureComposer(String(encoded));
      if (composer && upload) {
        armed = false;
        emit("calibration", { composer, upload, capturedAt: Date.now() });
      }
    } catch {
      /* outras requisições do Facebook não pertencem à calibração */
    }
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method || (input instanceof Request ? input.method : "POST");
    if (init?.body) inspect(url, method, init.body);
    else if (input instanceof Request && armed) {
      void input
        .clone()
        .formData()
        .then((body) => inspect(url, method, body))
        .catch(() =>
          input
            .clone()
            .text()
            .then((body) => inspect(url, method, body))
            .catch(() => {}),
        );
    }
    return nativeFetch.call(this, input, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ofzCapture = { method, url: String(url) };
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__ofzCapture) inspect(this.__ofzCapture.url, this.__ofzCapture.method, body);
    return nativeSend.call(this, body);
  };

  function session() {
    const requireModule = (name) => {
      try {
        return window.require?.(name);
      } catch {
        return null;
      }
    };
    const dtsg =
      requireModule("DTSGInitialData")?.token ||
      document.querySelector('input[name="fb_dtsg"]')?.value;
    const lsd = requireModule("LSD")?.token || document.querySelector('input[name="lsd"]')?.value;
    const site = requireModule("SiteData") || {};
    const userId = String(
      requireModule("CurrentUser")?.getID?.() ||
        document.querySelector('input[name="__user"]')?.value ||
        "",
    );
    return {
      userId,
      params: {
        fb_dtsg: dtsg,
        lsd,
        __spin_r: site.__spin_r,
        __spin_b: site.__spin_b,
        __spin_t: site.__spin_t,
        __rev: site.client_revision,
        __hsi: site.hsi,
      },
    };
  }

  async function publish(data) {
    const { calibration, groupId, text, image, fbUserId } = data;
    if (location.pathname.split("/")[2] !== String(groupId))
      return { ok: false, reason: "Abra o grupo de destino antes de publicar." };
    if (typeof image !== "string" || !image.startsWith("data:image/"))
      return { ok: false, reason: "A imagem do convite não está disponível." };
    if (!calibration?.composer || !calibration?.upload)
      return { ok: false, reason: "Calibre uma publicação com foto primeiro." };
    const current = session();
    if (!current.params.fb_dtsg || !current.userId)
      return { ok: false, reason: "Sessão do Facebook indisponível. Recarregue a aba." };
    if (fbUserId && fbUserId !== current.userId)
      return { ok: false, reason: "O perfil ativo não é o perfil do trabalho." };
    const blob = await (await nativeFetch(image)).blob();
    if (!blob.type.startsWith("image/"))
      return { ok: false, reason: "Arquivo do convite não é uma imagem." };
    const form = new FormData();
    for (const [key, value] of Object.entries(calibration.upload.fields)) {
      const replaced = String(value).split(calibration.composer.sampleText).join(text);
      form.append(key, replaced);
    }
    const uploadParams = fbzSessionParams({}, current.params);
    for (const [key, value] of uploadParams)
      if (
        [
          "fb_dtsg",
          "jazoest",
          "lsd",
          "__spin_r",
          "__spin_b",
          "__spin_t",
          "__rev",
          "__hsi",
        ].includes(key)
      )
        form.set(key, value);
    form.append(
      calibration.upload.fileField,
      blob,
      blob.type === "image/png" ? "convite.png" : "convite.jpg",
    );
    const uploadUrl = new URL(calibration.upload.url);
    for (const [key, value] of uploadParams)
      if (uploadUrl.searchParams.has(key)) uploadUrl.searchParams.set(key, value);
    replaying = true;
    try {
      const uploaded = await nativeFetch(uploadUrl.href, {
        method: calibration.upload.method,
        credentials: "include",
        body: form,
      });
      const uploadedText = await uploaded.text();
      const photoId = fbzPhotoId(uploadedText);
      if (!uploaded.ok || !photoId)
        return { ok: false, reason: "O Facebook não confirmou o upload da imagem." };
      const body = fbzComposerBody(
        calibration.composer,
        groupId,
        text,
        photoId,
        current.userId,
        current.params,
      );
      const response = await nativeFetch(`${location.origin}/api/graphql/`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const result = fbzGraphResult(await response.text());
      if (!response.ok || !result.ok)
        return {
          ok: false,
          reason: result.reason || `Facebook respondeu ${response.status}.`,
          blocked: /block|restrict|checkpoint|limit/i.test(result.reason || ""),
        };
      return { ok: true, postId: result.postId };
    } finally {
      replaying = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== CHANNEL
    )
      return;
    if (event.data.type === "arm") {
      armed = true;
      upload = null;
      emit("armed", {});
    }
    if (event.data.type === "publish") {
      const requestId = event.data.requestId;
      if (publishing) {
        emit("publish_result", {
          requestId,
          ok: false,
          reason: "Já existe uma publicação em andamento.",
        });
        return;
      }
      publishing = true;
      void publish(event.data.data)
        .then((result) => emit("publish_result", { requestId, ...result }))
        .catch((error) => emit("publish_result", { requestId, ok: false, reason: String(error) }))
        .finally(() => {
          publishing = false;
        });
    }
  });
})();
