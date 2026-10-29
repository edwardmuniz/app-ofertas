import { trackedLinks } from "@ofertas/db";
import { eq } from "drizzle-orm";
import type { Deps } from "./context";
import { linkCacheKey } from "./links";

// ── Resolução de links rastreados (com cache) ──────────────────────

export type CachedLink = {
  id: string;
  workspaceId: string;
  destination: string;
  fallback: string | null;
  active: boolean;
  expiresAt: string | null;
  channelId: string | null;
};

const LINK_TTL_SEC = 300;
const MISSING_TTL_SEC = 60;

export async function resolveLink(deps: Deps, slug: string): Promise<CachedLink | null> {
  const key = linkCacheKey(slug);
  const cached = await deps.cache.get(key);
  if (cached !== null) return cached === "null" ? null : (JSON.parse(cached) as CachedLink);

  // Slugs personalizados são gravados em minúsculas; gerados são case-sensitive.
  let [row] = await deps.db.select().from(trackedLinks).where(eq(trackedLinks.slug, slug));
  if (!row && slug !== slug.toLowerCase()) {
    [row] = await deps.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.slug, slug.toLowerCase()));
  }
  if (!row) {
    await deps.cache.set(key, "null", MISSING_TTL_SEC);
    return null;
  }
  const link: CachedLink = {
    id: row.id,
    workspaceId: row.workspaceId,
    destination: row.destinationUrl,
    fallback: row.fallbackUrl,
    active: row.active,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    channelId: row.channelId,
  };
  await deps.cache.set(key, JSON.stringify(link), LINK_TTL_SEC);
  return link;
}

export function decideLink(
  link: CachedLink,
  at: Date,
): { outcome: "redirect" | "fallback" | "gone"; url: string | null } {
  const expired = link.expiresAt !== null && new Date(link.expiresAt) <= at;
  if (link.active && !expired) return { outcome: "redirect", url: link.destination };
  if (link.fallback) return { outcome: "fallback", url: link.fallback };
  return { outcome: "gone", url: null };
}
