// Painel do grupo: análise, calibração e acompanhamento do convite pontual.

(() => {
  const ui = {};
  let job = null;
  let autoRunning = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const CALIBRATION_ARM_KEY = "fbCalibrationArmedUntil";
  const CALIBRATION_WINDOW_MS = 10 * 60 * 1000;

  const send = (msg) =>
    new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));

  // ── Painel (Shadow DOM, para não misturar com o CSS do Facebook) ──
  function mount() {
    if (ui.host) return;
    const host = document.createElement("div");
    host.id = "ofz-fb-dock";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
        .card { width: 340px; max-height: 80vh; overflow:auto; background:#fff; color:#111418;
          border:1px solid #dfe2e7; border-radius:14px; box-shadow:0 12px 32px rgba(0,0,0,.18); }
        .head { display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid #eef0f3; }
        .dot { width:8px; height:8px; border-radius:50%; background:#ff7a38; }
        .brand { font-weight:700; letter-spacing:-.02em; }
        .brand span { color:#ff7a38; }
        .spacer { flex:1; }
        .min { cursor:pointer; border:0; background:transparent; font-size:18px; color:#5b6270; line-height:1; }
        .body { padding:14px; display:flex; flex-direction:column; gap:12px; }
        .muted { color:#5b6270; font-size:12px; margin:0; }
        .group { font-size:12px; color:#5b6270; }
        textarea { width:100%; min-height:120px; resize:vertical; border:1px solid #dfe2e7; border-radius:10px;
          padding:10px; font-size:13px; color:#111418; background:#fff; }
        img.preview { width:100%; border-radius:10px; border:1px solid #eef0f3; display:block; }
        .row { display:flex; gap:8px; flex-wrap:wrap; }
        button.btn { flex:1; min-width:120px; cursor:pointer; border:1px solid #dfe2e7; background:#fff;
          color:#111418; border-radius:10px; padding:9px 10px; font-size:13px; font-weight:600; }
        button.btn:hover { background:#f4f5f7; }
        button.accent { background:#ff7a38; border-color:#ff7a38; color:#fff; }
        button.accent:hover { background:#f0661f; }
        button.ghost { background:transparent; border-color:transparent; color:#5b6270; font-weight:500; }
        input.link { width:100%; border:1px solid #dfe2e7; border-radius:10px; padding:9px 10px; font-size:13px; }
        .msg { font-size:12px; border-radius:8px; padding:8px 10px; display:none; }
        .msg.show { display:block; }
        .msg.ok { background:#e7f6ec; color:#0f7a3d; }
        .msg.bad { background:#fdecea; color:#b42318; }
        .msg.warn { background:#fff4e0; color:#8a5300; }
        .steps { font-size:12px; color:#5b6270; margin:0; padding-left:16px; }
        hr { border:0; border-top:1px solid #eef0f3; margin:2px 0; }
        .hidden { display:none; }
      </style>
      <div class="card">
        <div class="head">
          <span class="dot"></span><span class="brand">Of<span>Zap</span></span>
          <span class="spacer"></span>
          <button class="min" title="Minimizar">–</button>
        </div>
        <div class="body">
          <div id="empty">
            <p class="muted">Sem post na fila para este grupo agora. Deixe esta aba aberta: quando o OfZap agendar um post para aqui, ele aparece.</p>
          </div>
          <div id="analyze">
            <hr />
            <p class="muted">Este grupo aceita divulgação? Abra a aba do grupo com as regras e os
              posts à vista e clique abaixo.</p>
            <div class="row">
              <button class="btn" id="analyze-btn">Analisar este grupo</button>
            </div>
            <div class="msg" id="analyze-msg"></div>
            <hr />
            <p class="muted">Para publicar convites com imagem pela sessão do Facebook, calibre uma vez neste perfil.</p>
            <div class="row"><button class="btn" id="calibrate-btn">Calibrar publicação</button></div>
            <div class="msg" id="calibrate-msg"></div>
          </div>
          <div id="work" class="hidden">
            <p class="group" id="group-label"></p>
            <p class="muted" id="work-help"></p>
            <textarea id="text" aria-label="Texto do post"></textarea>
            <div class="row">
              <button class="btn accent" id="fill">Preencher no Facebook</button>
              <button class="btn" id="copy-text">Copiar texto</button>
            </div>
            <div id="img-wrap" class="hidden">
              <img class="preview" id="img" alt="Imagem do post" />
              <div class="row" style="margin-top:8px">
                <button class="btn" id="copy-img">Copiar imagem</button>
                <button class="btn" id="save-img">Baixar imagem</button>
              </div>
            </div>
            <hr />
            <input class="link" id="post-url" placeholder="Cole aqui o link do post publicado" />
            <div class="row">
              <button class="btn accent" id="confirm">Confirmar publicado</button>
              <button class="btn" id="fail">Não deu certo</button>
            </div>
            <div id="fail-box" class="hidden">
              <p class="muted">O que aconteceu?</p>
              <div class="row">
                <button class="btn" id="fail-group">Grupo não deixa postar</button>
                <button class="btn" id="fail-other">Outro problema</button>
              </div>
            </div>
            <div class="msg" id="msg"></div>
          </div>
          <div id="need-config" class="hidden">
            <div class="msg warn show">Configure o endereço da API, o token e o id do seu perfil do Facebook no ícone da extensão.</div>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    ui.host = host;
    ui.root = root;
    const $ = (id) => root.getElementById(id);
    ui.$ = $;
    root.querySelector(".min").addEventListener("click", () => {
      const b = root.querySelector(".body");
      b.classList.toggle("hidden");
    });
    $("analyze-btn").addEventListener("click", analyzeGroup);
    $("calibrate-btn").addEventListener("click", () => {
      const until = Date.now() + CALIBRATION_WINDOW_MS;
      void chrome.storage.local.set({ [CALIBRATION_ARM_KEY]: until });
      window.postMessage({ channel: "ofz-facebook-main", type: "arm", until }, location.origin);
      calibrationMessage(
        "warn",
        'Agora publique manualmente, em um grupo onde você possa testar, um post com uma foto e um texto de teste com pelo menos 12 caracteres (ex.: "Teste OfZap 4821"). Você tem 10 minutos.',
      );
    });
    $("fill").addEventListener("click", fillComposer);
    $("copy-text").addEventListener("click", copyText);
    $("copy-img").addEventListener("click", copyImage);
    $("save-img").addEventListener("click", saveImage);
    $("confirm").addEventListener("click", confirmPosted);
    $("fail").addEventListener("click", () => $("fail-box").classList.toggle("hidden"));
    $("fail-group").addEventListener("click", () =>
      failWith("not_member", "Grupo não deixa postar."),
    );
    $("fail-other").addEventListener("click", () => failWith("other", "Não deu certo."));
  }

  function calibrationMessage(kind, text) {
    mount();
    const msg = ui.$("calibrate-msg");
    msg.className = `msg show ${kind}`;
    msg.textContent = text;
  }

  function message(kind, text) {
    const m = ui.$("msg");
    m.className = `msg show ${kind}`;
    m.textContent = text;
  }

  // ── Analisar a política do grupo (só texto visível da página; o servidor classifica) ──
  // O que já foi lido de cada grupo nesta aba (feed + aba Sobre), para juntar na análise.
  const collectedByGroup = new Map();
  const RULE_HEADING =
    /^(regras( do grupo)?( dos administradores)?|group rules( from the admins)?|rules|sobre( este grupo)?|about( this group)?|descrição|description)$/i;

  /** Posts do feed. O Facebook usa role="article" só nos comentários, então lê o feed em si. */
  function feedUnits() {
    const feed = document.querySelector('[role="feed"]');
    let units = feed ? [...feed.children] : [];
    if (units.length < 2) units = [...document.querySelectorAll("[aria-posinset]")];
    if (!units.length)
      units = [...document.querySelectorAll('[role="article"]')].filter(
        (el) => !el.parentElement?.closest('[role="article"]'),
      );
    return units;
  }

  function postText(unit) {
    const comments = [...unit.querySelectorAll('[role="article"]')];
    let text = unit.innerText || "";
    for (const c of comments) {
      const t = c.innerText || "";
      if (t) text = text.split(t).join("\n");
    }
    const hosts = [...unit.querySelectorAll("a[href]")]
      .filter((a) => !comments.some((c) => c.contains(a)))
      .map((a) => fbzOutboundHost(a.href));
    return fbzCleanPostText(text, hosts);
  }

  /** Regras e descrição: na aba Sobre, o conteúdo principal; no feed, os cartões com esses títulos. */
  function rulesText() {
    const main = document.querySelector('[role="main"]');
    if (/^\/groups\/[^/]+\/(about|rules)/i.test(location.pathname) && main)
      return (main.innerText || "").trim().slice(0, 8000);
    const feed = document.querySelector('[role="feed"]');
    const boxes = [];
    for (const el of document.querySelectorAll('h2, h3, h4, [role="heading"], span[dir="auto"]')) {
      const label = (el.innerText || "").trim();
      if (!label || label.length > 60 || !RULE_HEADING.test(label)) continue;
      // Sobe até o maior bloco em volta do título que ainda não engloba o feed.
      let box = el;
      while (
        box.parentElement &&
        box.parentElement !== document.body &&
        (box.parentElement.innerText || "").length <= 4000 &&
        !(feed && box.parentElement.contains(feed))
      )
        box = box.parentElement;
      if (box !== el && !boxes.some((b) => b.contains(box))) {
        for (let i = boxes.length - 1; i >= 0; i--) if (box.contains(boxes[i])) boxes.splice(i, 1);
        boxes.push(box);
      }
    }
    return boxes
      .map((b) => (b.innerText || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 8000);
  }

  /** Melhor esforço: lê o nome, as regras/descrição e os últimos posts que estão na tela. */
  function collectGroup() {
    const groupId = fbzGroupIdFromUrl(location.href);
    const name = fbzGroupName(document.title) || groupId || "Grupo";
    const posts = [
      ...new Set(
        feedUnits()
          .map(postText)
          .filter((t) => t.length > 20),
      ),
    ].slice(0, 30);
    const current = { rules_text: rulesText(), post_texts: posts };
    const collected = fbzMergeCollected(collectedByGroup.get(groupId), current);
    if (groupId) collectedByGroup.set(groupId, collected);
    return { name, collected };
  }

  async function analyzeGroup() {
    const btn = ui.$("analyze-btn");
    const msg = ui.$("analyze-msg");
    const show = (kind, text) => {
      msg.className = `msg show ${kind}`;
      msg.textContent = text;
    };
    const groupId = fbzGroupIdFromUrl(location.href);
    if (!groupId) return show("bad", "Abra a página principal do grupo para analisar.");
    const { name, collected } = collectGroup();
    if (!collected.post_texts.length && !collected.rules_text) {
      return show(
        "warn",
        "Não encontrei posts nem regras na tela. Role o feed para carregar alguns posts ou abra a aba Sobre do grupo, e tente de novo.",
      );
    }
    const read = `Li ${collected.post_texts.length} post(s) e ${collected.rules_text ? "as regras" : "nenhuma regra"}.`;
    btn.disabled = true;
    show("warn", "Analisando…");
    const res = await send({
      type: "ofz-fb-analyze",
      payload: { group_id: groupId, name, collected },
    });
    btn.disabled = false;
    if (!res.ok) {
      return show("bad", `Não deu: ${res.body?.error?.message || res.reason || res.status}`);
    }
    const r = res.body?.result ?? res.body;
    const policy = r?.policy;
    const labels = {
      allowed: ["ok", "Aceita divulgação. O grupo entra na plataforma e pode receber posts."],
      approval: ["warn", "Aceita, mas o admin aprova cada post."],
      restricted: ["warn", "Aceita com condição. Confira as regras antes de divulgar."],
      forbidden: ["bad", "Não aceita divulgação. O OfZap não vai postar aqui."],
      unknown: ["warn", "Sem sinais claros. Confira as regras à mão e ajuste no painel."],
    };
    const [kind, text] = labels[policy] || ["warn", "Analisado."];
    const ev = Array.isArray(r?.evidence) && r.evidence.length ? ` (${r.evidence.join("; ")})` : "";
    let hint = "";
    if (policy === "unknown" && !collected.rules_text)
      hint =
        " Abra a aba Sobre do grupo (onde ficam as regras) e clique em Analisar de novo: o OfZap junta com o que já leu.";
    else if (policy === "unknown" && collected.post_texts.length < 4)
      hint = " Role o feed para carregar mais posts e analise de novo.";
    if (r?.kept_human) hint += " A política definida por uma pessoa no painel foi mantida.";
    show(kind, `${text}${ev} ${read}${hint}`);
  }

  function render() {
    mount();
    const $ = ui.$;
    const matches = job && fbzJobMatchesPage(job, location.href).ok;
    $("work").classList.toggle("hidden", !matches);
    $("empty").classList.toggle("hidden", Boolean(matches));
    if (!matches) return;
    $("group-label").textContent = `Post para este grupo (${fbzGroupIdFromUrl(location.href)})`;
    $("work-help").textContent = job.auto_publish
      ? "Convite pontual: o OfZap tenta publicar com a calibração deste perfil. Se houver erro, confira o grupo antes de publicar manualmente."
      : "1. Preencha o texto e cole a imagem · 2. Publique no Facebook · 3. Cole o link do post aqui.";
    $("text").value = fbzComposerText(job);
    const hasImg = Boolean(job.image);
    $("img-wrap").classList.toggle("hidden", !hasImg);
    if (hasImg) $("img").src = job.image;
    $("post-url").value = "";
    ui.$("msg").className = "msg";
    if (
      job.auto_publish &&
      !autoRunning &&
      !job.failureReported &&
      new Date(job.lease_until).getTime() > Date.now()
    ) {
      void publishWithCalibration(job);
    }
  }

  /**
   * Devolve a falha ao OfZap para o post sair de "Enviando" com o motivo. A aba costuma abrir
   * em segundo plano, então a mensagem no painel sozinha ninguém vê. Não há nova tentativa
   * automática: a pessoa confere o grupo e agenda de novo.
   */
  async function reportFailure(current, kind, reason) {
    if (current.failureReported) return;
    current.failureReported = true;
    const res = await send({
      type: "ofz-fb-result",
      jobId: current.id,
      result: { ok: false, error_kind: kind, error: String(reason).slice(0, 1000) },
    });
    if (res.ok && job?.id === current.id) job = null;
  }

  async function publishWithCalibration(current) {
    autoRunning = true;
    let confirmed = false;
    try {
      if (!current.image)
        throw new Error("A imagem do convite não foi baixada. Confira a conexão.");
      const saved = await send({ type: "ofz-fb-get-calibration" });
      if (!saved.calibration)
        throw new Error("Calibre a publicação com imagem neste perfil antes de enviar o convite.");
      message("warn", "Publicando o convite com a calibração deste perfil…");
      const requestId = crypto.randomUUID();
      const result = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener("message", onMessage);
          resolve({
            ok: false,
            reason:
              "O Facebook não respondeu em 90 segundos. Confira no grupo se o post saiu antes de agendar de novo.",
          });
        }, 90000);
        function onMessage(event) {
          if (
            event.source !== window ||
            event.origin !== location.origin ||
            event.data?.channel !== "ofz-facebook-main" ||
            event.data.type !== "publish_result" ||
            event.data.data?.requestId !== requestId
          )
            return;
          clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          resolve(event.data.data);
        }
        window.addEventListener("message", onMessage);
        window.postMessage(
          {
            channel: "ofz-facebook-main",
            type: "publish",
            requestId,
            data: {
              calibration: saved.calibration,
              groupId: current.group_id,
              text: fbzComposerText(current),
              image: current.image,
              fbUserId: saved.fbUserId,
            },
          },
          location.origin,
        );
      });
      if (!result.ok) {
        const reason =
          result.reason ||
          "O Facebook recusou o convite. Confira a publicação antes de tentar de novo.";
        await reportFailure(current, result.blocked ? "blocked" : "other", reason);
        throw new Error(reason);
      }
      confirmed = true;
      const reported = await send({
        type: "ofz-fb-result",
        jobId: current.id,
        result: { ok: true, post_id: result.postId },
      });
      if (!reported.ok)
        throw new Error(
          "O Facebook confirmou a publicação, mas o OfZap não registrou o resultado. Confira a fila.",
        );
      job = null;
      message("ok", "Convite publicado e registrado no OfZap.");
      setTimeout(refresh, 1200);
    } catch (err) {
      // Depois da confirmação do Facebook não marca falha: o post saiu.
      if (!confirmed) await reportFailure(current, "other", err.message);
      message("bad", err.message);
    } finally {
      autoRunning = false;
    }
  }

  /** Entrada pela interface visível. Perguntas e aceite de regras ficam para a pessoa. */
  async function joinGroup() {
    const analyzeVisible = async () => {
      const groupId = fbzGroupIdFromUrl(location.href);
      const { name, collected } = collectGroup();
      if (groupId && (collected.rules_text || collected.post_texts.length)) {
        await send({ type: "ofz-fb-analyze", payload: { group_id: groupId, name, collected } });
      }
    };
    const labels = () =>
      [...document.querySelectorAll('[role="button"], button')].map((el) => ({
        el,
        text: (el.innerText || el.getAttribute("aria-label") || "").trim(),
      }));
    if (labels().some(({ text }) => /^(participando|joined|membro)$/i.test(text))) {
      await analyzeVisible();
      return { status: "already" };
    }
    const join = labels().find(({ text }) =>
      /^(participar|participar do grupo|join group|join)$/i.test(text),
    );
    if (!join)
      return { status: "failed", reason: "Não encontrei o botão Participar. Confira a página." };
    join.el.click();
    await sleep(1200);
    for (let i = 0; i < 30; i++) {
      const current = labels();
      if (current.some(({ text }) => /^(participando|joined|membro)$/i.test(text))) {
        await analyzeVisible();
        return { status: "joined" };
      }
      if (
        current.some(({ text }) =>
          /^(solicitação enviada|pedido enviado|cancel request|cancelar solicitação)$/i.test(text),
        )
      ) {
        return { status: "pending" };
      }
      if (
        [...document.querySelectorAll('[role="dialog"]')].some((el) =>
          /perguntas|questions|aceitar regras|agree to the rules/i.test(el.innerText || ""),
        )
      ) {
        return { status: "needs_questions" };
      }
      await sleep(500);
    }
    return {
      status: "failed",
      reason: "Não consegui confirmar a entrada. Confira este grupo no Facebook.",
    };
  }

  // ── Ações (sempre com um gesto da pessoa) ──
  function composerBox() {
    // Melhor esforço: o campo de escrever do Facebook é um textbox editável.
    const boxes = [...document.querySelectorAll('[role="textbox"][contenteditable="true"]')];
    return boxes.find((b) => b.offsetParent !== null) || boxes[0] || null;
  }

  function fillComposer() {
    const box = composerBox();
    if (!box) {
      copyText();
      message(
        "warn",
        "Abra o campo “Escreva algo…” do grupo e cole (Ctrl+V): o texto já está copiado.",
      );
      return;
    }
    box.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, ui.$("text").value);
    message(
      "ok",
      job.image
        ? "Texto preenchido. Agora cole a imagem (Copiar imagem → Ctrl+V)."
        : "Texto preenchido. Confira e publique.",
    );
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(ui.$("text").value);
      message("ok", "Texto copiado. Cole no campo do grupo (Ctrl+V).");
    } catch {
      message("bad", "Não consegui copiar. Selecione o texto e copie à mão.");
    }
  }

  async function copyImage() {
    try {
      const blob = await (await fetch(job.image)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      message("ok", "Imagem copiada. Cole no post (Ctrl+V).");
    } catch {
      message("bad", "Não consegui copiar a imagem. Use “Baixar imagem” e anexe no post.");
    }
  }

  async function saveImage() {
    try {
      const a = document.createElement("a");
      a.href = job.image;
      a.download = `ofzap-${job.id}.jpg`;
      a.click();
      message("ok", "Imagem baixada. Anexe-a no post.");
    } catch {
      message("bad", "Não consegui baixar a imagem.");
    }
  }

  async function confirmPosted() {
    const norm = fbzNormalizePostUrl(ui.$("post-url").value, fbzGroupIdFromUrl(location.href));
    if (!norm.ok) {
      const why = {
        empty: "Cole o link do post. No Facebook: menu “…” do post → Copiar link.",
        not_a_post: "Esse link não é de um post. Copie pelo menu “…” do post.",
        other_group: "Esse link é de outro grupo.",
        not_facebook: "Cole um link do Facebook.",
      };
      message("bad", why[norm.reason] || "Link inválido.");
      return;
    }
    message("warn", "Registrando…");
    const res = await send({
      type: "ofz-fb-result",
      jobId: job.id,
      result: { ok: true, post_url: norm.url },
    });
    if (res.ok) {
      message("ok", "Publicação registrada no OfZap. ✅");
      job = null;
      setTimeout(refresh, 1200);
    } else {
      message(
        "bad",
        `Não consegui registrar: ${res.body?.error?.message || res.reason || res.status}`,
      );
    }
  }

  async function failWith(kind, label) {
    const res = await send({
      type: "ofz-fb-result",
      jobId: job.id,
      result: { ok: false, error_kind: kind, error: label },
    });
    if (res.ok) {
      message("warn", "Marcado. O OfZap não vai insistir neste grupo agora.");
      job = null;
      setTimeout(refresh, 1200);
    } else {
      message(
        "bad",
        `Não consegui registrar: ${res.body?.error?.message || res.reason || res.status}`,
      );
    }
  }

  async function refresh() {
    const r = await send({ type: "ofz-fb-get-job" });
    job = r.job || null;
    render();
  }

  // O service worker avisa quando chega um novo trabalho.
  window.addEventListener("message", async (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== "ofz-facebook-main"
    )
      return;
    const { type, data } = event.data;
    if (type === "upload_seen") {
      calibrationMessage("warn", "Imagem detectada. Agora clique em Publicar no Facebook.");
      return;
    }
    if (type === "calibration_timeout") {
      void chrome.storage.local.remove(CALIBRATION_ARM_KEY);
      calibrationMessage(
        "bad",
        "A calibração expirou sem ver uma publicação com foto. Clique em Calibrar publicação para tentar de novo.",
      );
      return;
    }
    if (type === "calibration_rejected") {
      void chrome.storage.local.remove(CALIBRATION_ARM_KEY);
      calibrationMessage("bad", data?.reason || "Não consegui usar essa publicação para calibrar.");
      return;
    }
    if (type !== "calibration") return;
    void chrome.storage.local.remove(CALIBRATION_ARM_KEY);
    const result = await send({ type: "ofz-fb-save-calibration", calibration: data });
    calibrationMessage(
      result.ok ? "ok" : "bad",
      result.ok
        ? "Publicação com imagem calibrada neste perfil. Os próximos convites podem usar esse formato."
        : result.reason || "Não consegui salvar a calibração. Tente novamente.",
    );
    if (result.ok) refresh();
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "ofz-fb-job") {
      job = msg.job;
      render();
    }
    if (msg?.type === "ofz-fb-join") {
      joinGroup()
        .then(sendResponse)
        .catch((err) => sendResponse({ status: "failed", reason: String(err) }));
      return true;
    }
  });

  /** Recarregar a aba no meio da calibração não deve perdê-la: rearma até o prazo original. */
  async function resumeCalibration() {
    const state = await chrome.storage.local.get(CALIBRATION_ARM_KEY).catch(() => ({}));
    const until = Number(state[CALIBRATION_ARM_KEY] || 0);
    if (until <= Date.now()) {
      if (until) void chrome.storage.local.remove(CALIBRATION_ARM_KEY);
      return;
    }
    window.postMessage({ channel: "ofz-facebook-main", type: "arm", until }, location.origin);
    calibrationMessage(
      "warn",
      "Calibração em andamento: publique um post com foto e texto de teste para concluir.",
    );
  }

  if (fbzIsGroupPage(location.href)) {
    refresh();
    void resumeCalibration();
    // O Facebook troca de página sem recarregar: reavalia quando a URL muda.
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        if (fbzIsGroupPage(location.href)) refresh();
      }
    }, 2000);
  }
})();
