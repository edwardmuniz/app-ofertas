import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const context = {
  module: { exports: {} },
  URL,
  URLSearchParams,
  FormData,
  Blob,
  location: { href: "https://www.facebook.com/groups/654321/", origin: "https://www.facebook.com" },
};
runInNewContext(readFileSync(new URL("../fb-replay-core.js", import.meta.url), "utf8"), context);
const { fbzCaptureComposer, fbzCapturePhotoUpload, fbzComposerBody, fbzPhotoId, fbzGraphResult } =
  context.module.exports;

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
});
