import { type AgentTool, CopyWriterError } from "@ofertas/connectors";
import {
  type CuratorPick,
  type CuratorRun,
  type CuratorStatus,
  Preferences,
  SearchOffersInput,
} from "@ofertas/contracts";
import { affiliateAccounts, type DbOrTx, offers, products, workspaces } from "@ofertas/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now, systemActor } from "./context";
import { AppError, isAppError } from "./errors";
import { type MutationOptions, runMutation } from "./mutation";
import { type Candidate, runSearch } from "./offers";
import { productFamilyKey } from "./product-family";
import { alreadyCurated } from "./saved-searches";

/**
 * Curador automático: um agente de IA (OpenRouter) faz várias buscas na Shopee e na Amazon,
 * guiado pelos nichos, proibidos e notas das Preferências e pelo que foi aprovado ou recusado,
 * e manda as melhores ofertas para a curadoria (status new) com o motivo da escolha.
 */

const DEFAULT_EVERY_HOURS = 6;
const DEFAULT_MAX_OFFERS = 8;
const MAX_SEARCHES = 10;
const MAX_TURNS = 16;
const RESULTS_PER_SEARCH = 12;
/** Só roda de dia (horário do workspace): as ofertas chegam para quem revisa. */
const DAY_START = 7;
const DAY_END = 23;

const CURATOR_SORTS = ["relevance", "sales", "discount", "price_asc"] as const;

const TOOLS: AgentTool[] = [
  {
    name: "search_offers",
    description:
      "Busca produtos nas lojas conectadas. Devolve até 12 resultados com ref, preço, desconto, nota (0-100), avaliação, vendas e sinais de qualidade. Varie os termos: específicos funcionam melhor que genéricos.",
    parameters: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Termo de busca em português, ex.: 'air fryer 4l'.",
        },
        platform: {
          type: "string",
          enum: ["shopee", "amazon"],
          description: "Só esta loja. Omita para buscar em todas.",
        },
        min_discount: { type: "integer", description: "Desconto mínimo em %." },
        price_max: { type: "number", description: "Preço máximo em reais." },
        sort: { type: "string", enum: [...CURATOR_SORTS] },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "pick_offers",
    description:
      "Manda ofertas para a curadoria humana. Use as refs devolvidas por search_offers e explique em uma frase curta por que cada uma vale a pena.",
    parameters: {
      type: "object",
      properties: {
        picks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              reason: { type: "string", description: "Motivo em até 140 caracteres." },
            },
            required: ["ref", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["picks"],
      additionalProperties: false,
    },
  },
];

type Settings = { enabled: boolean; everyHours: number; maxOffers: number };

function settingsOf(prefs: Preferences): Settings {
  return {
    enabled: prefs.auto_curator === true,
    everyHours: prefs.auto_curator_every_hours ?? DEFAULT_EVERY_HOURS,
    maxOffers: prefs.auto_curator_max_offers ?? DEFAULT_MAX_OFFERS,
  };
}

async function loadWorkspace(deps: Deps, workspaceId: string) {
  const [ws] = await deps.db
    .select({ settings: workspaces.settings, tz: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw new AppError("NOT_FOUND", "Workspace não encontrado.");
  return { ...ws, prefs: Preferences.parse(ws.settings.preferences ?? {}) };
}

/** O que foi aprovado e recusado por último: ensina o agente o gosto de quem revisa. */
async function recentDecisions(deps: Deps, workspaceId: string) {
  const rows = await deps.db
    .select({ status: offers.status, title: products.title, reason: offers.rejectReason })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(
      and(eq(offers.workspaceId, workspaceId), inArray(offers.status, ["approved", "rejected"])),
    )
    .orderBy(desc(offers.updatedAt))
    .limit(40);
  const cut = (t: string) => (t.length > 90 ? `${t.slice(0, 90)}…` : t);
  return {
    approved: rows.filter((r) => r.status === "approved").map((r) => cut(r.title)),
    rejected: rows
      .filter((r) => r.status === "rejected")
      .map((r) => (r.reason ? `${cut(r.title)} (motivo: ${r.reason})` : cut(r.title))),
  };
}

async function searchablePlatforms(deps: Deps, workspaceId: string) {
  const rows = await deps.db
    .selectDistinct({ platform: affiliateAccounts.platform })
    .from(affiliateAccounts)
    .where(
      and(eq(affiliateAccounts.workspaceId, workspaceId), ne(affiliateAccounts.status, "disabled")),
    );
  return rows.map((r) => r.platform);
}

function systemPrompt(maxOffers: number) {
  return [
    "Você é o curador de ofertas de um canal de promoções no WhatsApp (Brasil).",
    "Seu trabalho: buscar produtos com search_offers e mandar para a curadoria humana, com pick_offers, só as ofertas que valem a pena divulgar.",
    "",
    "Como trabalhar:",
    `- Faça buscas variadas (até ${MAX_SEARCHES}), cobrindo os nichos e as lojas disponíveis. Prefira termos específicos de produtos que vendem bem.`,
    "- Prefira desconto real (preço abaixo do histórico), boa avaliação (4+), muitas vendas e nota alta.",
    "- Nunca escolha itens com o sinal fake_discount, unavailable ou low_rating, nem o que estiver em 'Nunca publicar'.",
    "- lowest_30d / lowest_90d indicam o menor preço do período: é um bom sinal.",
    "- Itens com in_curation=true já estão na fila: não escolha de novo.",
    "- Não escolha o mesmo produto em cores ou anúncios diferentes.",
    `- Escolha no máximo ${maxOffers} ofertas no total. Qualidade vale mais que quantidade: se nada for bom, não escolha nada.`,
    "- Aprenda com as decisões recentes: evite o que foi recusado e o motivo da recusa.",
    "- Ao terminar, responda com um resumo de uma ou duas frases em português.",
  ].join("\n");
}

function userPrompt(input: {
  prefs: Preferences;
  platforms: string[];
  decisions: { approved: string[]; rejected: string[] };
  maxOffers: number;
  today: string;
}) {
  const { prefs, decisions } = input;
  const list = (items: string[] | undefined, empty: string) =>
    items?.length ? items.map((i) => `- ${i}`).join("\n") : empty;
  return [
    `Hoje: ${input.today}. Lojas disponíveis: ${input.platforms.join(", ") || "nenhuma"}.`,
    `Escolha até ${input.maxOffers} ofertas.`,
    "",
    "Nichos foco:",
    list(prefs.niches, "- (não definidos: escolha categorias populares e variadas)"),
    "",
    "Nunca publicar:",
    list(prefs.forbidden, "- (nada definido)"),
    prefs.notes ? `\nOrientações do dono do canal:\n${prefs.notes}` : "",
    "",
    "Aprovadas recentemente:",
    list(decisions.approved, "- (nenhuma ainda)"),
    "",
    "Recusadas recentemente:",
    list(decisions.rejected, "- (nenhuma ainda)"),
  ].join("\n");
}

type Found = Candidate & { ref: string; family: string | null };

/** Roda o agente e devolve as escolhas (sem gravar nada). */
async function planRun(deps: Deps, workspaceId: string): Promise<CuratorRun & { found: Found[] }> {
  const agent = deps.curatorAgent;
  if (!agent) {
    throw new AppError("NOT_CONFIGURED", "O curador automático precisa da IA do OpenRouter.", {
      hint: "Configure OPENROUTER_API_KEY no .env do servidor (openrouter.ai › Keys).",
    });
  }
  const ws = await loadWorkspace(deps, workspaceId);
  const { maxOffers } = settingsOf(ws.prefs);
  const platforms = await searchablePlatforms(deps, workspaceId);
  if (platforms.length === 0) {
    throw new AppError("NOT_CONFIGURED", "Nenhuma conta de afiliado conectada.", {
      hint: "Conecte a Shopee ou a Amazon em Afiliados.",
    });
  }
  const curated = await alreadyCurated(deps, workspaceId);
  const found = new Map<string, Found>();
  const searches: string[] = [];
  const errors: string[] = [];
  const picks: (CuratorPick & { candidate: Found })[] = [];
  const pickedFamilies = new Set<string>();
  let seq = 0;

  const isCurated = (c: Found) =>
    curated.productIds.has(c.product.id) || (c.family !== null && curated.families.has(c.family));

  async function search(args: Record<string, unknown>) {
    if (searches.length >= MAX_SEARCHES) {
      return { error: `Limite de ${MAX_SEARCHES} buscas atingido. Escolha agora com pick_offers.` };
    }
    const keyword = String(args.keyword ?? "")
      .trim()
      .slice(0, 100);
    if (!keyword) return { error: "Informe keyword." };
    const platform =
      args.platform === "shopee" || args.platform === "amazon" ? args.platform : null;
    const sort = CURATOR_SORTS.find((s) => s === args.sort) ?? "relevance";
    searches.push(platform ? `${keyword} (${platform})` : keyword);
    const q = SearchOffersInput.parse({
      keyword,
      platforms: platform ? [platform] : undefined,
      min_discount:
        typeof args.min_discount === "number" ? Math.round(args.min_discount) : undefined,
      price_max: typeof args.price_max === "number" ? args.price_max : undefined,
      sort,
      limit: RESULTS_PER_SEARCH,
    });
    try {
      const res = await runSearch(deps, workspaceId, q);
      for (const e of res.errors) errors.push(`${e.platform}: ${e.message}`);
      return {
        results: res.candidates.map((c) => {
          const known = [...found.values()].find((f) => f.product.id === c.product.id);
          const item: Found = known ?? {
            ...c,
            ref: `p${++seq}`,
            family: productFamilyKey(c.item.platform, c.item.title),
          };
          found.set(item.ref, item);
          return {
            ref: item.ref,
            platform: c.item.platform,
            title: c.item.title.slice(0, 140),
            price: c.item.price,
            original_price: c.item.originalPrice,
            discount_pct: c.item.discountPct,
            rating: c.item.rating,
            sold: c.item.soldCount,
            score: c.score,
            flags: c.flags,
            in_curation: isCurated(item),
          };
        }),
        errors: res.errors,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      return { error: msg };
    }
  }

  function pick(args: Record<string, unknown>) {
    const list = Array.isArray(args.picks) ? args.picks : [];
    const accepted: string[] = [];
    const refused: { ref: string; why: string }[] = [];
    for (const raw of list as { ref?: unknown; reason?: unknown }[]) {
      const ref = String(raw?.ref ?? "");
      const c = found.get(ref);
      const why = !c
        ? "ref desconhecida"
        : picks.length >= maxOffers
          ? `limite de ${maxOffers} ofertas atingido`
          : picks.some((p) => p.candidate.ref === ref)
            ? "já escolhida"
            : isCurated(c)
              ? "já está na curadoria"
              : c.family && pickedFamilies.has(c.family)
                ? "mesmo produto de outra escolha"
                : c.flags.includes("fake_discount") || !c.item.available
                  ? "desconto falso ou indisponível"
                  : null;
      if (!c || why) {
        refused.push({ ref, why: why ?? "inválida" });
        continue;
      }
      if (c.family) pickedFamilies.add(c.family);
      picks.push({
        candidate: c,
        offer_id: null,
        product_id: c.product.id,
        platform: c.item.platform,
        title: c.item.title,
        price: c.item.price,
        discount_pct: c.item.discountPct,
        score: c.score,
        reason:
          String(raw?.reason ?? "")
            .trim()
            .slice(0, 200) || "Escolhida pelo curador.",
      });
      accepted.push(ref);
    }
    return { accepted, refused, remaining: maxOffers - picks.length };
  }

  const decisions = await recentDecisions(deps, workspaceId);
  let summary: string;
  try {
    const out = await agent.run({
      system: systemPrompt(maxOffers),
      prompt: userPrompt({
        prefs: ws.prefs,
        platforms,
        decisions,
        maxOffers,
        today: new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone: ws.tz }).format(
          now(deps),
        ),
      }),
      tools: TOOLS,
      maxTurns: MAX_TURNS,
      callTool: async ({ name, args }) =>
        name === "search_offers"
          ? search(args)
          : name === "pick_offers"
            ? pick(args)
            : { error: `Ferramenta desconhecida: ${name}` },
    });
    summary = out.text.trim().slice(0, 600);
  } catch (err) {
    throw curatorError(err);
  }
  return {
    picks: picks.map(({ candidate: _c, ...p }) => p),
    searches,
    summary,
    errors: [...new Set(errors)],
    found: picks.map((p) => p.candidate),
  };
}

const AI_HINTS: Record<string, string> = {
  AUTH: "Confira a OPENROUTER_API_KEY no .env (openrouter.ai › Keys).",
  BILLING: "A conta do OpenRouter está sem créditos: adicione em openrouter.ai › Credits.",
  RATE_LIMIT: "Limite de uso do OpenRouter atingido. A próxima rodada tenta de novo.",
  UNAVAILABLE: "O modelo no OpenRouter está fora do ar ou lento. A próxima rodada tenta de novo.",
  INVALID:
    "O modelo recusou o pedido. Confira se o OPENROUTER_AGENT_MODEL aceita ferramentas (tool calling).",
};

function curatorError(err: unknown): AppError {
  if (err instanceof CopyWriterError) {
    return new AppError("PROVIDER_ERROR", err.message, {
      hint: AI_HINTS[err.code],
      details: { provider: "openrouter", provider_code: err.code },
    });
  }
  return isAppError(err) ? err : new AppError("PROVIDER_ERROR", String(err));
}

async function saveState(db: DbOrTx, workspaceId: string, state: NonNullable<WsState>) {
  await db
    .update(workspaces)
    .set({
      settings: sql`jsonb_set(${workspaces.settings}, '{auto_curator}', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(eq(workspaces.id, workspaceId));
}
type WsState = Awaited<ReturnType<typeof loadWorkspace>>["settings"]["auto_curator"];

/**
 * Roda o curador agora. `dry_run` mostra o que ele escolheria, sem gravar (mas gasta a IA).
 * Sem `dry_run`, as escolhas entram na curadoria como "new", com o motivo nas notas.
 */
export async function runAutoCurator(ctx: Ctx, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "offers.auto_curate",
    scope: "offers:write",
    input: {},
    opts,
    target: () => ({ type: "workspace", id: wsId }),
    preview: async (c) => {
      const { found, ...run } = await planRun(c, wsId);
      const candidates = run.picks.flatMap((p, i) => {
        const c = found[i];
        return c ? [{ ...toInsert(c), notes: `Curador: ${p.reason}` }] : [];
      });
      return { ...run, candidates };
    },
    execute: async (tx, _i, plan): Promise<CuratorRun> => {
      const rows = plan.candidates.length
        ? await tx.db
            .insert(offers)
            .values(
              plan.candidates.map((c) => ({ ...c, workspaceId: wsId, status: "new" as const })),
            )
            .returning({ id: offers.id, productId: offers.productId })
        : [];
      const ids = new Map(rows.map((r) => [r.productId, r.id]));
      const picks = plan.picks.map((p) => ({ ...p, offer_id: ids.get(p.product_id) ?? null }));
      await saveState(tx.db, wsId, {
        last_run_at: now(ctx).toISOString(),
        added: picks.length,
        searches: plan.searches,
        summary: plan.summary,
        error: null,
      });
      return { picks, searches: plan.searches, summary: plan.summary, errors: plan.errors };
    },
  });
}

/** Colunas da oferta a gravar (vai na prévia, para a aprovação poder gravar depois). */
function toInsert(c: Found) {
  return {
    productId: c.product.id,
    affiliateAccountId: c.account.id,
    price: c.item.price,
    originalPrice: c.item.originalPrice,
    discountPct: c.item.discountPct,
    commissionRate: c.item.commissionRate,
    commissionValue: c.item.commissionValue,
    affiliateUrl: c.item.affiliateUrl,
    validUntil: c.item.validUntil,
    score: c.score,
    qualityFlags: c.flags,
    notes: null as string | null,
  };
}

/** Situação do curador para o painel e os agentes. */
export async function getAutoCuratorStatus(ctx: Ctx): Promise<CuratorStatus> {
  requireScope(ctx.actor, "offers:read");
  const ws = await loadWorkspace(ctx, ctx.actor.workspaceId);
  const s = settingsOf(ws.prefs);
  const state = ws.settings.auto_curator;
  const requested = pendingRequest(state);
  const next = requested
    ? new Date(requested)
    : s.enabled && state?.last_run_at
      ? new Date(new Date(state.last_run_at).getTime() + s.everyHours * 3_600_000)
      : s.enabled
        ? now(ctx)
        : null;
  return {
    enabled: s.enabled,
    configured: Boolean(ctx.curatorAgent),
    every_hours: s.everyHours,
    max_offers: s.maxOffers,
    last_run_at: state?.last_run_at ?? null,
    next_run_at: next?.toISOString() ?? null,
    requested_at: requested,
    last_result: state?.last_run_at
      ? {
          added: state.added ?? 0,
          searches: state.searches ?? [],
          summary: state.summary ?? "",
          error: state.error ?? null,
        }
      : null,
  };
}

function localHour(at: Date, tz: string) {
  return Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(
      at,
    ),
  );
}

/** Pedido de rodada ainda não atendido (feito depois da última rodada). */
function pendingRequest(state: WsState): string | null {
  const req = state?.requested_at;
  if (!req) return null;
  return !state.last_run_at || req > state.last_run_at ? req : null;
}

/**
 * Pede uma rodada em segundo plano: o worker roda em até 1 minuto, mesmo com o curador
 * desligado ou fora do horário. Para o painel (a rodada passa do tempo de uma requisição).
 */
export async function requestAutoCuratorRun(ctx: Ctx, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "offers.auto_curate_request",
    scope: "offers:write",
    input: {},
    opts,
    target: () => ({ type: "workspace", id: wsId }),
    preview: async (c) => {
      if (!c.curatorAgent) {
        throw new AppError("NOT_CONFIGURED", "O curador automático precisa da IA do OpenRouter.", {
          hint: "Configure OPENROUTER_API_KEY no .env do servidor (openrouter.ai › Keys).",
        });
      }
      return { requested_at: now(c).toISOString() };
    },
    execute: async (tx, _i, p) => {
      await tx.db
        .update(workspaces)
        .set({
          settings: sql`${workspaces.settings} || jsonb_build_object('auto_curator', coalesce(${workspaces.settings} -> 'auto_curator', '{}'::jsonb) || jsonb_build_object('requested_at', ${p.requested_at}::text))`,
        })
        .where(eq(workspaces.id, wsId));
      return p;
    },
  });
}

/**
 * Roda o curador dos workspaces que ligaram e cujo intervalo venceu, e os pedidos de
 * "rodar agora". Chamado pelo worker.
 */
export async function runDueAutoCurators(deps: Deps) {
  if (!deps.curatorAgent) return [];
  const list = await deps.db
    .select({ id: workspaces.id, tz: workspaces.timezone, settings: workspaces.settings })
    .from(workspaces)
    .where(
      sql`(${workspaces.settings} -> 'preferences' ->> 'auto_curator') = 'true' or (${workspaces.settings} -> 'auto_curator' ->> 'requested_at') is not null`,
    );
  const at = now(deps);
  const results: { workspace_id: string; added?: number; error?: string }[] = [];
  for (const ws of list) {
    const requested = pendingRequest(ws.settings.auto_curator);
    if (!requested) {
      const prefs = Preferences.parse(ws.settings.preferences ?? {});
      if (prefs.auto_curator !== true) continue;
      const hour = localHour(at, ws.tz);
      if (hour < DAY_START || hour >= DAY_END) continue;
      const { everyHours } = settingsOf(prefs);
      const last = ws.settings.auto_curator?.last_run_at;
      if (last && at.getTime() - new Date(last).getTime() < everyHours * 3_600_000) continue;
    }
    // Uma rodada por vez por workspace (a rodada leva minutos; o worker roda a cada 60 s).
    if (!(await deps.cache.setIfAbsent(`curator:lock:${ws.id}`, "1", 15 * 60))) continue;
    const ctx: Ctx = { ...deps, actor: systemActor(ws.id, "auto-curator") };
    try {
      const res = await runAutoCurator(ctx, { reason: "Curador automático" });
      if (res.status !== "done") {
        // Política pede aprovação: conta como rodada (não pede de novo a cada minuto).
        await saveState(deps.db, ws.id, {
          last_run_at: at.toISOString(),
          added: 0,
          searches: res.preview.searches,
          summary: "Escolhas aguardando aprovação no painel.",
          error: null,
        });
      }
      results.push({
        workspace_id: ws.id,
        added: res.status === "done" ? res.result.picks.length : 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Grava o erro como rodada: espera o intervalo antes de tentar de novo (não gasta IA à toa).
      await saveState(deps.db, ws.id, {
        last_run_at: at.toISOString(),
        added: 0,
        searches: [],
        summary: "",
        error: msg,
      });
      results.push({ workspace_id: ws.id, error: msg });
    } finally {
      await deps.cache.del(`curator:lock:${ws.id}`);
    }
  }
  return results;
}
