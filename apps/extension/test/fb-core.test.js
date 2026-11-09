import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// fb-core.js é um script comum (roda na página): carrega num contexto isolado e usa as funções.
// O navegador já tem URL/URLSearchParams globais; no sandbox precisamos passá-los.
const ctx = { module: { exports: {} }, URL, URLSearchParams };
runInNewContext(readFileSync(new URL("../fb-core.js", import.meta.url), "utf8"), ctx);
const {
  fbzGroupIdFromUrl,
  fbzIsGroupPage,
  fbzGroupCandidateFromLink,
  fbzJobMatchesPage,
  fbzComposerText,
  fbzPickVariation,
  fbzNormalizePostUrl,
  fbzFirstUrl,
} = ctx.module.exports;

describe("grupo da aba", () => {
  it("extrai o id do grupo da URL", () => {
    expect(fbzGroupIdFromUrl("https://www.facebook.com/groups/123456/")).toBe("123456");
    expect(
      fbzGroupIdFromUrl("https://www.facebook.com/groups/achadinhos.sp/buy_sell_discussion"),
    ).toBe("achadinhos.sp");
    expect(fbzGroupIdFromUrl("https://m.facebook.com/groups/999?ref=x")).toBe("999");
  });
  it("ignora o que não é grupo", () => {
    expect(fbzGroupIdFromUrl("https://www.facebook.com/me")).toBeNull();
    expect(fbzGroupIdFromUrl("https://www.facebook.com/groups/feed/")).toBeNull();
    expect(fbzGroupIdFromUrl("https://example.com/groups/1")).toBeNull();
    expect(fbzIsGroupPage("https://www.facebook.com/watch")).toBe(false);
  });
});

describe("candidatos visíveis na busca", () => {
  it("aceita só a página principal de um grupo e limpa o link", () => {
    expect(
      fbzGroupCandidateFromLink(
        "https://www.facebook.com/groups/123/?ref=search",
        "  Ofertas   SP  ",
      ),
    ).toEqual({
      id: "123",
      name: "Ofertas SP",
      url: "https://www.facebook.com/groups/123/",
    });
    expect(
      fbzGroupCandidateFromLink("https://www.facebook.com/groups/123/posts/9", "Post"),
    ).toBeNull();
    expect(fbzGroupCandidateFromLink("https://example.com/groups/123", "Outro")).toBeNull();
    expect(fbzGroupCandidateFromLink("https://www.facebook.com/groups/123/", " ")).toBeNull();
  });
});

describe("casar trabalho com a aba", () => {
  it("bate quando o id do grupo é o mesmo", () => {
    expect(fbzJobMatchesPage({ group_id: "123" }, "https://www.facebook.com/groups/123/")).toEqual({
      ok: true,
    });
  });
  it("recusa grupo diferente ou página fora de grupo", () => {
    expect(fbzJobMatchesPage({ group_id: "123" }, "https://www.facebook.com/groups/456/").ok).toBe(
      false,
    );
    expect(fbzJobMatchesPage({ group_id: "123" }, "https://www.facebook.com/home").reason).toBe(
      "not_group",
    );
    expect(fbzJobMatchesPage({}, "https://www.facebook.com/groups/123/").reason).toBe("no_target");
  });
});

describe("texto do composer", () => {
  it("usa o texto pronto do backend", () => {
    expect(fbzComposerText({ id: "p1", text: "Oferta do dia" })).toBe("Oferta do dia");
  });
  it("escolhe uma variação estável quando há '---'", () => {
    const text = "Versão A\n---\nVersão B\n---\nVersão C";
    const a = fbzPickVariation(text, "p1");
    const b = fbzPickVariation(text, "p1");
    expect(a).toBe(b); // estável para o mesmo trabalho
    expect(["Versão A", "Versão B", "Versão C"]).toContain(a);
  });
  it("sem variação, devolve o texto limpo", () => {
    expect(fbzPickVariation("  só isso  ", "x")).toBe("só isso");
  });
});

describe("link do post publicado", () => {
  const gid = "123";
  it("aceita /posts/ e limpa o rastreamento", () => {
    const r = fbzNormalizePostUrl(
      "https://www.facebook.com/groups/123/posts/999/?__cft__[0]=abc&__tn__=xyz",
      gid,
    );
    expect(r).toEqual({ ok: true, url: "https://www.facebook.com/groups/123/posts/999/" });
  });
  it("aceita permalink.php mantendo os parâmetros necessários", () => {
    const r = fbzNormalizePostUrl(
      "https://www.facebook.com/permalink.php?story_fbid=888&id=123&ref=share",
      null,
    );
    expect(r.ok).toBe(true);
    expect(r.url).toContain("story_fbid=888");
    expect(r.url).toContain("id=123");
    expect(r.url).not.toContain("ref=share");
  });
  it("pega a URL mesmo colada junto com outro texto", () => {
    expect(fbzFirstUrl("veja: https://www.facebook.com/groups/123/posts/5/ 👍")).toBe(
      "https://www.facebook.com/groups/123/posts/5/",
    );
  });
  it("recusa link que não é post, de outro site ou de outro grupo", () => {
    expect(fbzNormalizePostUrl("https://www.facebook.com/groups/123/", gid).reason).toBe(
      "not_a_post",
    );
    expect(fbzNormalizePostUrl("https://google.com/x", gid).reason).toBe("not_facebook");
    expect(fbzNormalizePostUrl("https://www.facebook.com/groups/777/posts/5/", gid).reason).toBe(
      "other_group",
    );
    expect(fbzNormalizePostUrl("", gid).reason).toBe("empty");
  });
});
