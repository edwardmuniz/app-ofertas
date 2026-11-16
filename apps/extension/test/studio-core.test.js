import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../studio-core.js", import.meta.url), "utf8");
const core = runInNewContext(
  `${source}\n({ ofzPublisherGroups, ofzValidInviteLink, ofzLeftGroups })`,
  { URL },
);

describe("fluxo de grupos do Studio", () => {
  it("mostra grupos importados sem política como pendentes e só permite os analisados", () => {
    const accounts = [{ id: "account-1", fb_user_id: "123456" }];
    const channel = (id, posting_policy, status = "active", facebook_account_id = "account-1") => ({
      id,
      type: "fb_group",
      facebook_account_id,
      posting_policy,
      status,
    });
    const result = core.ofzPublisherGroups(
      accounts,
      [
        channel("new", null),
        channel("unknown", "unknown"),
        channel("allowed", "allowed"),
        channel("approval", "approval"),
        channel("forbidden", "forbidden"),
        channel("paused", "allowed", "paused"),
        channel("other", "allowed", "active", "account-2"),
      ],
      "123456",
    );
    expect(result.mine).toHaveLength(6);
    expect(result.pending.map((item) => item.id)).toEqual(["new", "unknown"]);
    expect(result.eligible.map((item) => item.id)).toEqual(["allowed", "approval"]);
    expect(result.blocked.map((item) => item.id)).toEqual(["forbidden", "paused"]);
    expect(result.otherProfiles).toBe(1);
  });

  it("aponta grupos cadastrados que sumiram de Meus grupos", () => {
    const registered = [
      { id: "a", external_id: "111111", status: "active" },
      { id: "b", external_id: "222222", status: "active" },
      { id: "c", external_id: "grupo.vanity", status: "active" },
      { id: "d", external_id: "333333", status: "paused" },
    ];
    const mine = [{ id: "111111" }, { id: "999999" }];
    expect(core.ofzLeftGroups(registered, mine, false).map((g) => g.id)).toEqual(["b", "d"]);
    // Lista parcial ou vazia: não dá para concluir que a pessoa saiu.
    expect(core.ofzLeftGroups(registered, mine, true)).toEqual([]);
    expect(core.ofzLeftGroups(registered, [], false)).toEqual([]);
  });

  it("aceita o convite direto ou o link rastreado do OfZap", () => {
    expect(core.ofzValidInviteLink("https://chat.whatsapp.com/AbC123")).toBe(true);
    expect(core.ofzValidInviteLink("https://go.ofzap.com.br/entrar/grupos-facebook")).toBe(true);
    expect(core.ofzValidInviteLink("http://go.ofzap.com.br/entrar/grupos-facebook")).toBe(false);
    expect(core.ofzValidInviteLink("https://outro.site/entrar/grupos-facebook")).toBe(false);
  });
});
