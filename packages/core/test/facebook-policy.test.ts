import { describe, expect, it } from "vitest";
import { classifyGroupPolicy, policyAllowsPosting } from "../src/facebook-policy";

describe("política de divulgação do grupo", () => {
  it("proibição nas regras vence tudo", () => {
    const v = classifyGroupPolicy({
      rules_text: "Regra 1: É proibida a divulgação de links. Quem divulgar será removido.",
      post_texts: ["compre na shopee r$ 10", "oferta amazon cupom", "achadinho mercado livre"],
    });
    expect(v.policy).toBe("forbidden");
    expect(v.evidence[0]).toMatch(/proibid/i);
  });

  it("muitos posts de membros com link = aceita divulgação", () => {
    const v = classifyGroupPolicy({
      rules_text: "Grupo de achadinhos e promoções.",
      post_texts: [
        "Air fryer na shopee por R$ 199 🔥",
        "Cupom amazon: 10% off",
        "meli.la/abc oferta do dia",
        "olá pessoal, bom dia",
      ],
    });
    expect(v.policy).toBe("allowed");
  });

  it("liberação explícita nas regras", () => {
    const v = classifyGroupPolicy({
      rules_text: "Divulgação liberada para todos.",
      post_texts: [],
    });
    expect(v.policy).toBe("allowed");
  });

  it("condição vira restricted com a nota", () => {
    const v = classifyGroupPolicy({
      rules_text: "Dia de divulgação: somente às sextas.",
      post_texts: [],
    });
    expect(v.policy).toBe("restricted");
    expect(v.notes).toMatch(/divulga/i);
  });

  it("sem sinais vira unknown", () => {
    const v = classifyGroupPolicy({
      rules_text: "Grupo de bate-papo da vizinhança.",
      post_texts: ["bom dia", "alguém viu meu gato?"],
    });
    expect(v.policy).toBe("unknown");
  });

  it("só allowed/approval/restricted liberam post", () => {
    expect(policyAllowsPosting("allowed")).toBe(true);
    expect(policyAllowsPosting("approval")).toBe(true);
    expect(policyAllowsPosting("restricted")).toBe(true);
    expect(policyAllowsPosting("forbidden")).toBe(false);
    expect(policyAllowsPosting("unknown")).toBe(false);
    expect(policyAllowsPosting(null)).toBe(false);
  });
});
