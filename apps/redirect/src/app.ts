import {
  type ClickBuffer,
  type Deps,
  decideLink,
  hashIp,
  isBotUserAgent,
  loadPublicStorefront,
  now,
  resolveInvite,
  resolveLink,
  storefrontInviteHref,
  storefrontUrl,
} from "@ofertas/core";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { storefrontHtml } from "./storefront-page";

export type RedirectAppOptions = {
  deps: Deps;
  clicks: Pick<ClickBuffer, "push">;
  ipSalt: string;
  trustProxy?: boolean;
  logger?: boolean;
};

const TRACKED_PARAMS = /^(src|ref|ad|via|o|utm_[a-z]+)$/;

/** Guarda só parâmetros de rastreamento conhecidos (?src=ig_bio, ?ref=, ?ad=, utm_*). */
function trackedParams(query: unknown): Record<string, string> | null {
  if (!query || typeof query !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    if (TRACKED_PARAMS.test(k) && typeof v === "string" && Object.keys(out).length < 10) {
      out[k] = v.slice(0, 100);
    }
  }
  return Object.keys(out).length ? out : null;
}

function page(reply: FastifyReply, status: number, title: string, message: string, link?: string) {
  const action = link
    ? `<a href="${encodeURI(link)}" style="display:inline-block;margin-top:16px;padding:10px 18px;background:#059669;color:#fff;border-radius:8px;text-decoration:none">Continuar</a>`
    : "";
  return reply
    .status(status)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;background:#fafafa;color:#171717"><main style="max-width:420px;text-align:center"><h1 style="font-size:20px">${title}</h1><p style="color:#525252">${message}</p>${action}</main></body></html>`,
    );
}

function redirect(reply: FastifyReply, url: string) {
  return reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .redirect(url, 302);
}

export async function buildRedirectApp(opts: RedirectAppOptions) {
  const { deps } = opts;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });

  const visitor = (req: FastifyRequest) => {
    const ua = req.headers["user-agent"];
    return {
      ipHash: hashIp(req.ip, opts.ipSalt),
      userAgent: ua?.slice(0, 500) ?? null,
      referrer: req.headers.referer?.slice(0, 500) ?? null,
      params: trackedParams(req.query),
      // HEAD é usado por verificadores de link, não por pessoas.
      isBot: req.method === "HEAD" || isBotUserAgent(ua),
      ts: now(deps),
    };
  };

  app.get("/health", async () => ({ ok: true }));
  app.get("/robots.txt", async (_req, reply) =>
    reply.type("text/plain").send("User-agent: *\nDisallow: /\n"),
  );
  app.get("/favicon.ico", async (_req, reply) => reply.status(204).send());
  app.get("/", async (_req, reply) =>
    page(reply, 404, "Link não encontrado", "Confira se o endereço está completo."),
  );

  // Vitrine pública do workspace: /@slug (o @ não existe nos links curtos).
  app.get<{ Params: { slug: string }; Querystring: { src?: string } }>(
    "/@:slug",
    async (req, reply) => {
      const sf = await loadPublicStorefront(deps, req.params.slug);
      if (!sf) {
        return page(reply, 404, "Página não encontrada", "Confira se o endereço está completo.");
      }
      const v = visitor(req);
      opts.clicks.push({
        workspaceId: sf.workspace_id,
        kind: "page_view",
        outcome: "redirect",
        ...v,
      });
      const src = typeof req.query.src === "string" ? req.query.src.slice(0, 40) : null;
      const beacon = new URL(`${storefrontUrl(deps, sf.slug)}/c`);
      if (src) beacon.searchParams.set("src", src);
      beacon.searchParams.set("via", "vitrine");
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(
          storefrontHtml(sf, {
            inviteHref: (slug) => storefrontInviteHref(deps, slug, src),
            beaconUrl: beacon.toString(),
          }),
        );
    },
  );

  // Clique numa oferta da vitrine (aviso em segundo plano; o link vai direto para a loja).
  app.post<{ Params: { slug: string }; Querystring: { o?: string } }>(
    "/@:slug/c",
    async (req, reply) => {
      const sf = await loadPublicStorefront(deps, req.params.slug);
      const offerId = req.query.o;
      if (sf && offerId && sf.offers.some((o) => o.id === offerId)) {
        opts.clicks.push({
          workspaceId: sf.workspace_id,
          kind: "page_offer",
          outcome: "redirect",
          ...visitor(req),
        });
      }
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { slug: string } }>("/entrar/:slug", async (req, reply) => {
    const r = await resolveInvite(deps, req.params.slug);
    if (r.kind === "not_found") {
      return page(reply, 404, "Convite não encontrado", "Confira se o endereço está completo.");
    }
    const base = {
      workspaceId: r.invite.workspaceId,
      kind: "invite" as const,
      inviteLinkId: r.invite.id,
      ...visitor(req),
    };
    if (r.kind === "redirect" && r.channel.inviteUrl) {
      opts.clicks.push({ ...base, channelId: r.channel.id, outcome: "redirect" });
      return redirect(reply, r.channel.inviteUrl);
    }
    const fallback = r.invite.fallbackUrl;
    opts.clicks.push({ ...base, outcome: fallback ? "fallback" : "full" });
    if (fallback) return redirect(reply, fallback);
    return page(
      reply,
      503,
      r.kind === "inactive" ? "Convite pausado" : "Grupos lotados",
      r.kind === "inactive"
        ? "Este convite está pausado no momento. Volte em breve."
        : "Todos os grupos estão cheios agora. Estamos abrindo novas vagas, volte em breve.",
    );
  });

  app.get<{ Params: { slug: string } }>("/:slug", async (req, reply) => {
    const link = await resolveLink(deps, req.params.slug);
    if (!link) {
      return page(reply, 404, "Link não encontrado", "Confira se o endereço está completo.");
    }
    const decision = decideLink(link, now(deps));
    opts.clicks.push({
      workspaceId: link.workspaceId,
      kind: "link",
      trackedLinkId: link.id,
      channelId: link.channelId,
      outcome: decision.outcome,
      ...visitor(req),
    });
    if (decision.url) return redirect(reply, decision.url);
    return page(reply, 410, "Oferta encerrada", "Esta oferta não está mais disponível.");
  });

  return app;
}
