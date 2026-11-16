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

  const DEFAULT_ARM_MS = 10 * 60 * 1000;
  let armTimer = null;
  // Último arquivo enviado que não pareceu foto (só para explicar uma calibração recusada).
  let lastFileSeen = null;

  function disarm() {
    armed = false;
    upload = null;
    lastFileSeen = null;
    clearTimeout(armTimer);
    armTimer = null;
  }

  function arm(until) {
    const deadline = Number(until) > Date.now() ? Number(until) : Date.now() + DEFAULT_ARM_MS;
    armed = true;
    upload = null;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      disarm();
      emit("calibration_timeout", {});
    }, deadline - Date.now());
    emit("armed", { until: deadline });
  }

  function inspect(url, method, body) {
    if (!armed || replaying || !body) return;
    try {
      if (body instanceof FormData) {
        const file = [...body.values()].find((v) => v instanceof Blob);
        if (file) {
          let host = "?";
          try {
            host = new URL(url, location.href).hostname;
          } catch {}
          lastFileSeen = `${file.type || "sem tipo"} para ${host}`;
        }
      }
      const target = fbzFacebookUrl(url);
      if (!target) return;
      const photo = fbzCapturePhotoUpload(target.href, method, body);
      if (photo) {
        upload = photo;
        lastFileSeen = null;
        emit("upload_seen", {});
        return;
      }
      if (!target.pathname.includes("/api/graphql/")) return;
      let encoded = body;
      if (body instanceof FormData)
        encoded = new URLSearchParams([...body.entries()].filter(([, v]) => typeof v === "string"));
      encoded = String(encoded);
      const composer = fbzCaptureComposer(encoded);
      if (!composer) {
        const diagnosis = fbzComposerDiagnosis(encoded);
        if (diagnosis) {
          disarm();
          const missing = diagnosis.missing.length ? diagnosis.missing.join(", ") : "formato";
          emit("calibration_rejected", {
            reason: `Vi a publicação (${diagnosis.friendlyName}), mas não encontrei: ${missing}. Confira se o post tinha texto e foto; se tinha, o Facebook mudou o fluxo.`,
          });
        }
        return;
      }
      if (!upload) {
        const seen = lastFileSeen;
        disarm();
        emit("calibration_rejected", {
          reason: seen
            ? `Vi a publicação, mas o arquivo enviado não foi reconhecido como foto (${seen}). Me envie esta mensagem para ajustar.`
            : "Vi a publicação, mas não o envio da imagem. Clique em Calibrar e só depois anexe a foto.",
        });
        return;
      }
      const issue = fbzCalibrationIssue(composer);
      const captured = upload;
      disarm();
      if (issue) {
        emit("calibration_rejected", { reason: issue });
        return;
      }
      emit("calibration", {
        composer,
        upload: captured,
        fbUserId: session().userId,
        capturedAt: Date.now(),
      });
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

  /** Erro de rede com o nome da etapa, para a mensagem dizer onde parou. */
  async function step(label, run) {
    try {
      return await run();
    } catch (error) {
      throw new Error(`Falha de rede no ${label}: ${error?.message || error}`);
    }
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
    const blob = fbzDataUrlToBlob(image);
    if (!blob?.type.startsWith("image/"))
      return { ok: false, reason: "Arquivo do convite não é uma imagem." };
    const form = new FormData();
    for (const [key, value] of Object.entries(calibration.upload.fields)) {
      // Só troca o campo que é exatamente o texto de teste; os demais seguem como capturados.
      form.append(key, String(value) === calibration.composer.sampleText ? text : value);
    }
    // Campos e parâmetros de sessão: os mesmos nomes vistos na calibração, com os valores de agora.
    const sessionValues = fbzSessionValues(current.params, current.userId);
    const keys = calibration.upload.sessionKeys || {
      url: [],
      fields: ["fb_dtsg", "jazoest", "lsd", "__spin_r", "__spin_b", "__spin_t", "__rev", "__hsi"],
    };
    for (const key of keys.fields)
      if (sessionValues.has(key)) form.set(key, sessionValues.get(key));
    form.append(
      calibration.upload.fileField,
      blob,
      blob.type === "image/png" ? "convite.png" : "convite.jpg",
    );
    const uploadUrl = fbzFacebookUrl(calibration.upload.url);
    if (!uploadUrl) return { ok: false, reason: "Calibração inválida. Calibre de novo." };
    for (const key of keys.url)
      if (sessionValues.has(key)) uploadUrl.searchParams.set(key, sessionValues.get(key));
    replaying = true;
    try {
      const uploaded = await step("envio da imagem", () =>
        nativeFetch(uploadUrl.href, {
          method: calibration.upload.method,
          credentials: "include",
          body: form,
        }),
      );
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
      const response = await step("publicação", () =>
        nativeFetch(`${location.origin}/api/graphql/`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        }),
      );
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
    if (event.data.type === "arm") arm(event.data.until);
    if (event.data.type === "disarm") disarm();
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
