import {
  PlanFacebookPostsInput,
  type RankedFacebookGroup,
  RankFacebookGroupsInput,
} from "@ofertas/contracts";
import { requireScope } from "./authz";
import type { Ctx } from "./context";

const STOP_WORDS = new Set(["de", "da", "do", "dos", "das", "para", "com", "e", "em"]);
const words = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

/** Ordena somente sinais visíveis da busca; a pessoa ainda confere regras e participação. */
export function rankFacebookGroups(ctx: Ctx, raw: unknown) {
  requireScope(ctx.actor, "channels:read");
  const input = RankFacebookGroupsInput.parse(raw);
  const tokens = [...new Set(words(input.niche))];
  const groups: RankedFacebookGroup[] = input.groups.map((group) => {
    const name = new Set(words(group.name));
    const matches = tokens.filter((token) => name.has(token));
    const relevance = tokens.length ? Math.round((matches.length / tokens.length) * 60) : 0;
    const activity = group.posts_per_day
      ? Math.min(25, Math.round(8 * Math.log2(group.posts_per_day + 1)))
      : 0;
    const size = group.member_count
      ? Math.min(15, Math.round(3 * Math.log10(group.member_count + 1)))
      : 0;
    const reasons = [
      ...(matches.length ? [`${matches.length} termo(s) do nicho no nome`] : []),
      ...(group.posts_per_day ? [`${group.posts_per_day} posts/dia visíveis na busca`] : []),
      ...(group.member_count ? [`${group.member_count} membros informados na busca`] : []),
    ];
    return { ...group, score: Math.min(100, relevance + activity + size), reasons };
  });
  groups.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "pt-BR"));
  return { groups };
}

/** Texto 1 × imagem 1, texto 1 × imagem 2, etc.; uma combinação por grupo. */
export function planFacebookPosts(ctx: Ctx, raw: unknown) {
  requireScope(ctx.actor, "posts:read");
  const input = PlanFacebookPostsInput.parse(raw);
  const combinations = input.texts.flatMap((text) =>
    input.creative_ids.map((creative_id) => ({ text, creative_id })),
  );
  const first = combinations[0];
  if (!first) throw new Error("É necessário ao menos um texto e uma imagem.");
  const assignments = input.channel_ids.map((channel_id, index) => ({
    channel_id,
    ...(combinations[index % combinations.length] ?? first),
  }));
  return { combinations, assignments };
}
