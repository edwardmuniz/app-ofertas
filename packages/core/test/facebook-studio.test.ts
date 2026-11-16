import { describe, expect, it } from "vitest";
import type { Ctx } from "../src/context";
import { planFacebookPosts, rankFacebookGroups } from "../src/facebook-studio";

const ctx = {
  actor: { scopes: new Set(["channels:read", "posts:read"]) },
} as unknown as Ctx;
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];

describe("estúdio de grupos do Facebook", () => {
  it("prioriza grupos do nicho com atividade visível", () => {
    const ranked = rankFacebookGroups(ctx, {
      niche: "achadinhos tecnologia",
      groups: [
        {
          id: "123456",
          name: "Grupo geral",
          url: "https://www.facebook.com/groups/123456/",
          member_count: 100000,
        },
        {
          id: "234567",
          name: "Achadinhos tecnologia",
          url: "https://www.facebook.com/groups/234567/",
          member_count: 3000,
          posts_per_day: 15,
        },
      ],
    });
    expect(ranked.groups[0]?.id).toBe("234567");
    expect(ranked.groups[0]?.score ?? 0).toBeGreaterThan(ranked.groups[1]?.score ?? 0);
  });

  it("distribui produto cartesiano na ordem dos textos e imagens", () => {
    const plan = planFacebookPosts(ctx, {
      channel_ids: ids,
      texts: ["Texto 1", "Texto 2"],
      creative_ids: ids.slice(0, 2),
    });
    expect(plan.combinations).toEqual([
      { text: "Texto 1", creative_id: ids[0] },
      { text: "Texto 1", creative_id: ids[1] },
      { text: "Texto 2", creative_id: ids[0] },
      { text: "Texto 2", creative_id: ids[1] },
    ]);
    expect(plan.assignments.map((item) => item.creative_id)).toEqual([ids[0], ids[1], ids[0]]);
  });

  it("recusa planejamento sem escopo", () => {
    expect(() =>
      planFacebookPosts({ actor: { scopes: new Set() } } as unknown as Ctx, {
        channel_ids: ids,
        texts: ["Convite"],
        creative_ids: ids.slice(0, 1),
      }),
    ).toThrow();
  });
});
