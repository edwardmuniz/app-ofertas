import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const context = {
  module: { exports: {} },
  URL,
  URLSearchParams,
  FormData,
  Blob,
  File,
  atob,
  TextEncoder,
  location: { href: "https://www.facebook.com/groups/654321/", origin: "https://www.facebook.com" },
};
runInNewContext(readFileSync(new URL("../fb-replay-core.js", import.meta.url), "utf8"), context);
const {
  fbzCaptureComposer,
  fbzCalibrationIssue,
  fbzComposerDiagnosis,
  fbzCapturePhotoUpload,
  fbzFacebookUrl,
  fbzSessionValues,
  fbzDataUrlToBlob,
  fbzComposerBody,
  fbzPhotoId,
  fbzGraphResult,
} = context.module.exports;

const variables = {
  input: {
    actor_id: "123456",
    audience: { to_id: "654321" },
    message: { text: "Texto de teste" },
    attachments: [{ photo: { id: "999999" } }],
  },
};

describe("calibração local do post com imagem", () => {
  it("guarda a operação sem tokens de sessão", () => {
    const params = new URLSearchParams({
      doc_id: "123456789",
      fb_api_req_friendly_name: "ComposerCreateStoryMutation",
      variables: JSON.stringify(variables),
      fb_dtsg: "segredo",
      lsd: "segredo2",
      request_token: "segredo3",
      __user: "123456",
      fb_api_caller_class: "RelayModern",
    });
    const captured = fbzCaptureComposer(params.toString());
    expect(captured).toMatchObject({
      sampleGroupId: "654321",
      sampleText: "Texto de teste",
      samplePhotoId: "999999",
    });
    expect(captured.params.fb_dtsg).toBeUndefined();
    expect(captured.params.lsd).toBeUndefined();
    expect(captured.params.request_token).toBeUndefined();
    expect(captured.params.fb_api_caller_class).toBe("RelayModern");
  });

  it("troca grupo, texto e foto e usa o token atual", () => {
    const captured = fbzCaptureComposer(
      new URLSearchParams({
        doc_id: "123456789",
        fb_api_req_friendly_name: "ComposerCreateStoryMutation",
        variables: JSON.stringify(variables),
      }).toString(),
    );
    const body = fbzComposerBody(captured, "777777", "Convite novo", "888888", "123456", {
      fb_dtsg: "atual",
    });
    expect(body.get("fb_dtsg")).toBe("atual");
    const updated = JSON.parse(body.get("variables"));
    expect(updated.input.audience.to_id).toBe("777777");
    expect(updated.input.message.text).toBe("Convite novo");
    expect(updated.input.attachments[0].photo.id).toBe("888888");
  });

  it("captura upload de imagem e lê confirmação", () => {
    const form = new FormData();
    form.set("fb_dtsg", "segredo");
    form.set("csrf_nonce", "segredo2");
    form.set("caption", "Texto de teste");
    form.set("file", new Blob(["imagem"], { type: "image/png" }));
    const upload = fbzCapturePhotoUpload(
      "https://www.facebook.com/ajax/photo/upload?session_token=segredo",
      "POST",
      form,
    );
    expect(upload.fileField).toBe("file");
    expect(upload.fields.fb_dtsg).toBeUndefined();
    expect(upload.fields.csrf_nonce).toBeUndefined();
    expect(upload.url).not.toContain("segredo");
    expect(fbzPhotoId('for (;;);{"payload":{"photoID":"888888"}}')).toBe("888888");
    expect(fbzGraphResult('{"data":{"create":{"post_id":"777777"}}}')).toEqual({
      ok: true,
      postId: "777777",
    });
    expect(fbzGraphResult('{"errors":[{"message":"bloqueado"}]}').ok).toBe(false);
  });

  it("troca o texto de teste só onde ele é o valor inteiro", () => {
    const vars = {
      input: {
        audience: { to_id: "654321" },
        message: { text: "Texto de teste" },
        attachments: [{ photo: { id: "999999" } }],
        tracking: ["Texto de teste extra", "prefixo Texto de teste"],
      },
    };
    const captured = fbzCaptureComposer(
      new URLSearchParams({
        doc_id: "123456789",
        fb_api_req_friendly_name: "ComposerCreateStoryMutation",
        variables: JSON.stringify(vars),
      }).toString(),
    );
    const body = fbzComposerBody(captured, "777777", "Convite novo", "888888", "123456", {});
    const updated = JSON.parse(body.get("variables"));
    expect(updated.input.message.text).toBe("Convite novo");
    expect(updated.input.tracking).toEqual(["Texto de teste extra", "prefixo Texto de teste"]);
  });

  it("recusa texto de teste curto demais", () => {
    expect(fbzCalibrationIssue({ sampleText: "teste" })).toMatch(/12 caracteres/);
    expect(fbzCalibrationIssue({ sampleText: "Teste OfZap 4821" })).toBeNull();
  });

  it("só a mutação do composer conta como publicação", () => {
    const query = new URLSearchParams({
      doc_id: "1",
      fb_api_req_friendly_name: "ComposerStoryCreatePrefetchQuery",
      variables: JSON.stringify(variables),
    }).toString();
    expect(fbzCaptureComposer(query)).toBeNull();
    expect(fbzComposerDiagnosis(query)).toBeNull();
    expect(fbzComposerDiagnosis("fb_api_req_friendly_name=CometFeedQuery&doc_id=1")).toBeNull();
  });

  it("diz o que faltou na mutação não reconhecida", () => {
    const body = new URLSearchParams({
      doc_id: "1",
      fb_api_req_friendly_name: "ComposerStoryCreateMutation",
      variables: JSON.stringify({
        input: { audience: { to_id: "654321" }, message: { text: "" } },
      }),
    }).toString();
    expect(fbzCaptureComposer(body)).toBeNull();
    expect(fbzComposerDiagnosis(body)).toEqual({
      friendlyName: "ComposerStoryCreateMutation",
      missing: ["texto", "foto"],
    });
  });

  it("captura upload feito em upload.facebook.com e guarda só os nomes da sessão", () => {
    const form = new FormData();
    form.set("fb_dtsg", "segredo");
    form.set("__user", "123456");
    form.set("source", "8");
    form.set("farr", new File(["img"], "foto.jpg"));
    const upload = fbzCapturePhotoUpload(
      "https://upload.facebook.com/ajax/react_composer/attachments/photo/upload?av=123456&__user=123456&fb_dtsg=segredo&profile_id=123456",
      "POST",
      form,
    );
    expect(upload.fileField).toBe("farr");
    expect(upload.url).toBe(
      "https://upload.facebook.com/ajax/react_composer/attachments/photo/upload?profile_id=123456",
    );
    expect(upload.fields).toEqual({ source: "8" });
    expect([...upload.sessionKeys.url]).toEqual(["av", "__user", "fb_dtsg"]);
    expect([...upload.sessionKeys.fields]).toEqual(["fb_dtsg", "__user"]);
    const values = fbzSessionValues({ fb_dtsg: "atual" }, "777");
    expect(values.get("__user")).toBe("777");
    expect(values.get("av")).toBe("777");
    expect(values.get("jazoest")).toMatch(/^2\d+$/);
  });

  it("converte a imagem data: em Blob sem fetch", async () => {
    const blob = fbzDataUrlToBlob("data:image/png;base64,iVBORw0K");
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
    ]);
    expect(fbzDataUrlToBlob("https://x/y.png")).toBeNull();
  });

  it("aceita só URLs https do Facebook", () => {
    expect(fbzFacebookUrl("https://upload.facebook.com/x")).not.toBeNull();
    expect(fbzFacebookUrl("/api/graphql/")).not.toBeNull();
    expect(fbzFacebookUrl("https://evilfacebook.com/x")).toBeNull();
    expect(fbzFacebookUrl("http://upload.facebook.com/x")).toBeNull();
  });

  it("prefere photoID ao id genérico na resposta do upload", () => {
    expect(fbzPhotoId('for (;;);{"id":"111111111","payload":{"photoID":"888888"}}')).toBe("888888");
    expect(fbzPhotoId('{"payload":{"fbid":"555555","id":"111111"}}')).toBe("555555");
    expect(fbzPhotoId('{"payload":{"id":"222222"}}')).toBe("222222");
  });
});
