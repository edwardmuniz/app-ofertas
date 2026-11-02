import { type CopyFacts, CopyWriterError } from "@ofertas/connectors";
import { GenerateOfferCopyInput, SetOfferCopyInput } from "@ofertas/contracts";
import { type OfferCopy, offers, workspaces } from "@ofertas/db";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { requireHuman } from "./authz";
import { type Ctx, type Deps, now, systemActor } from "./context";
import { AppError } from "./errors";
import { type MutationOptions, runMutation } from "./mutation";
import { loadOffer, toOffer } from "./offers";
import { offerVars } from "./templates";

/** Converte falhas da IA no erro padrão. */
const COPY_HINTS: Record<string, Record<string, string>> = {
  openrouter: {
    AUTH: "Confira a OPENROUTER_API_KEY no .env (openrouter.ai › Keys).",
    BILLING: "A conta do OpenRouter está sem créditos: adicione em openrouter.ai › Credits.",
    RATE_LIMIT: "Limite de uso do OpenRouter atingido. Tente de novo em alguns minutos.",
    UNAVAILABLE: "O modelo no OpenRouter está fora do ar ou lento. Tente de novo em instantes.",
    INVALID: "Tente gerar de novo. Se repetir, confira o OPENROUTER_MODEL.",
  },
  gemini: {
    AUTH: "Confira a GOOGLE_API_KEY no .env (chave do Google AI Studio com a Gemini API ativa).",
    BILLING:
      "O projeto no Google AI Studio está sem créditos: adicione em ai.studio/projects (Billing).",
    RATE_LIMIT: "Limite de uso do Gemini atingido. Tente de novo em alguns minutos.",
    UNAVAILABLE: "O Gemini está fora do ar ou lento. Tente de novo em instantes.",
    INVALID: "Tente gerar de novo.",
  },
};

function copyError(err: unknown, provider: string): AppError {
  if (err instanceof CopyWriterError) {
    return new AppError("PROVIDER_ERROR", err.message, {
      hint: COPY_HINTS[provider]?.[err.code] ?? "Tente gerar de novo.",
      details: { provider, provider_code: err.code },
    });
  }
  return err instanceof AppError ? err : new AppError("PROVIDER_ERROR", String(err));
}

/**
 * Gera o texto da oferta com IA (chamada, descrição e fechamento). Só pelo painel: agentes
 * conectados escrevem o próprio texto com `set_offer_copy`. Preço, parcelas e link nunca vêm da
 * IA. `dry_run` só mostra o texto, sem salvar.
 */
export async function generateOfferCopy(
  ctx: Ctx,
  offerId: string,
  raw: GenerateOfferCopyInput = {},
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Gerar texto com IA");
  return writeAiCopy(ctx, offerId, GenerateOfferCopyInput.parse(raw), opts);
}

/** Núcleo da geração (painel e preenchimento automático). `onlyIfEmpty` não sobrescreve texto. */
async function writeAiCopy(
  ctx: Ctx,
  offerId: string,
  input: { hint?: string },
  opts: MutationOptions & { onlyIfEmpty?: boolean } = {},
) {
  const writer = ctx.copywriter;
  if (!writer) {
    throw new AppError("NOT_CONFIGURED", "Geração de texto por IA não configurada.", {
      hint: "Defina OPENROUTER_API_KEY (ou GOOGLE_API_KEY) no .env e reinicie a API.",
    });
  }
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "offers.generate_copy",
    scope: "offers:write",
    input: { offer_id: offerId, hint: input.hint },
    opts,
    target: (i) => ({ type: "offer", id: i.offer_id }),
    preview: async (c, i) => {
      const { offer, product } = await loadOffer(c.db, wsId, i.offer_id);
      const [ws] = await c.db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, wsId));
      const tone = ws?.settings.preferences?.tone_of_voice;
      const v = offerVars(offer, product, "");
      const facts: CopyFacts = {
        title: product.title,
        platform: v.plataforma ?? product.platform,
        price: v.preco ?? "",
        originalPrice: v.preco_original ?? null,
        discountPct: offer.discountPct,
        pixPrice: v.preco_pix ?? null,
        installments: v.parcelas ?? null,
        coupon: offer.couponCode,
        category: product.categoryName,
        shop: product.shopName,
        tone: typeof tone === "string" && tone.trim() ? tone : null,
        hint: i.hint ?? null,
      };
      let text: Awaited<ReturnType<typeof writer.write>>;
      try {
        text = await writer.write(facts);
      } catch (err) {
        throw copyError(err, writer.provider);
      }
      const copy: OfferCopy = { ...text, source: "ai", updated_at: now(c).toISOString() };
      return { offer_id: offer.id, copy };
    },
    execute: async (tx, _i, p) => {
      const [row] = await tx.db
        .update(offers)
        .set({ copy: p.copy })
        .where(
          opts.onlyIfEmpty
            ? and(eq(offers.id, p.offer_id), isNull(offers.copy))
            : eq(offers.id, p.offer_id),
        )
        .returning();
      if (!row && opts.onlyIfEmpty) {
        // Alguém escreveu o texto enquanto a IA gerava: fica o de quem escreveu.
        const { offer, product } = await loadOffer(tx.db, wsId, p.offer_id);
        return toOffer(offer, product);
      }
      if (!row) throw new AppError("NOT_FOUND", "Oferta não encontrada.");
      const { product } = await loadOffer(tx.db, wsId, row.id);
      return toOffer(row, product);
    },
  });
}

/**
 * Salva (ou remove, com null) o texto da oferta. Humanos editam no painel; agentes escrevem o
 * texto deles aqui. Com texto, o envio usa o formato chamada + descrição + preço + fechamento.
 */
export async function setOfferCopy(
  ctx: Ctx,
  offerId: string,
  raw: SetOfferCopyInput,
  opts: MutationOptions = {},
) {
  const input = SetOfferCopyInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  const source: OfferCopy["source"] = ctx.actor.type === "user" ? "human" : "agent";
  return runMutation(ctx, {
    action: "offers.set_copy",
    scope: "offers:write",
    input: { offer_id: offerId, copy: input.copy },
    opts,
    target: (i) => ({ type: "offer", id: i.offer_id }),
    preview: async (c, i) => {
      const { offer } = await loadOffer(c.db, wsId, i.offer_id);
      if (
        i.copy &&
        /https?:\/\/|R\$\s*\d/i.test(`${i.copy.headline} ${i.copy.body} ${i.copy.extra ?? ""}`)
      ) {
        throw new AppError("VALIDATION_ERROR", "O texto não deve ter preço nem link.", {
          hint: "Preço, parcelas, cupom e link entram sozinhos na mensagem, sempre atualizados.",
        });
      }
      const copy: OfferCopy | null = i.copy
        ? {
            headline: i.copy.headline,
            body: i.copy.body,
            extra: i.copy.extra || null,
            source,
            updated_at: now(c).toISOString(),
          }
        : null;
      return { offer_id: offer.id, copy };
    },
    execute: async (tx, _i, p) => {
      const [row] = await tx.db
        .update(offers)
        .set({ copy: p.copy })
        .where(eq(offers.id, p.offer_id))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Oferta não encontrada.");
      const { product } = await loadOffer(tx.db, wsId, row.id);
      return toOffer(row, product);
    },
  });
}

export type FillCopiesResult = {
  generated: string[];
  failed: { offer_id: string; code: string; message: string }[];
  /** Erro que vale para todas (sem créditos, chave errada): o worker espera antes de tentar de novo. */
  stopped: string | null;
};

/**
 * Preferência `auto_copy`: gera o texto das ofertas aprovadas que ainda não têm texto. Roda no
 * worker, em lotes pequenos; nunca substitui texto escrito por pessoas ou agentes.
 */
export async function fillMissingCopies(
  deps: Deps,
  opts: { limit?: number; skip?: string[] } = {},
): Promise<FillCopiesResult> {
  const out: FillCopiesResult = { generated: [], failed: [], stopped: null };
  if (!deps.copywriter) return out;
  const enabled = await deps.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(sql`(${workspaces.settings} -> 'preferences' ->> 'auto_copy') = 'true'`);
  if (enabled.length === 0) return out;
  const conds = [
    inArray(
      offers.workspaceId,
      enabled.map((w) => w.id),
    ),
    eq(offers.status, "approved"),
    isNull(offers.copy),
  ];
  if (opts.skip?.length) conds.push(notInArray(offers.id, opts.skip));
  const pending = await deps.db
    .select({ id: offers.id, workspaceId: offers.workspaceId })
    .from(offers)
    .where(and(...conds))
    .orderBy(desc(offers.createdAt))
    .limit(opts.limit ?? 10);

  for (const o of pending) {
    const ctx: Ctx = { ...deps, actor: systemActor(o.workspaceId, "auto-copy") };
    try {
      await writeAiCopy(
        ctx,
        o.id,
        {},
        { onlyIfEmpty: true, reason: "Texto automático ao aprovar" },
      );
      out.generated.push(o.id);
    } catch (err) {
      const code =
        err instanceof AppError
          ? String(
              (err.details as { provider_code?: string } | undefined)?.provider_code ?? err.code,
            )
          : "ERROR";
      out.failed.push({ offer_id: o.id, code, message: String((err as Error).message ?? err) });
      if (code === "AUTH" || code === "BILLING" || code === "NOT_CONFIGURED") {
        out.stopped = code;
        break;
      }
    }
  }
  return out;
}
