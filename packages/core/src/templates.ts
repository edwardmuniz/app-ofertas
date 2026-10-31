import { type MessageTemplate, UpsertMessageTemplateInput } from "@ofertas/contracts";
import { type DbOrTx, messageTemplates, type offers, type products } from "@ofertas/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { requireScope } from "./authz";
import type { Ctx } from "./context";
import { AppError } from "./errors";
import { type MutationOptions, runMutation } from "./mutation";

/** Modelo padrão. Variações separadas por "---" evitam mensagens idênticas em massa. */
export const DEFAULT_TEMPLATE_BODY = `{{selo}}
*{{titulo}}*

De ~{{preco_original}}~
🔥 Por *{{preco}}*
📉 {{desconto}} OFF
🎟️ Cupom: *{{cupom}}*

👉 {{link}}
---
{{selo}}
{{titulo}}

💰 *{{preco}}* (era {{preco_original}})
🎟️ Use o cupom *{{cupom}}*

Compre aqui: {{link}}
---
{{selo}}
🛒 *{{titulo}}*

Só *{{preco}}*
De {{preco_original}} por {{preco}} — {{desconto}} de desconto
🎟️ Cupom: {{cupom}}

🔗 {{link}}`;

const PLATFORM_NAMES: Record<string, string> = {
  shopee: "Shopee",
  amazon: "Amazon",
  mercadolivre: "Mercado Livre",
  magalu: "Magalu",
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export type TemplateVars = Record<string, string | null | undefined>;

/** Variáveis de uma oferta para o modelo. */
export function offerVars(
  offer: typeof offers.$inferSelect,
  product: typeof products.$inferSelect,
  link: string,
): TemplateVars {
  const flags = offer.qualityFlags;
  const selo = flags.includes("lowest_90d")
    ? "🏆 MENOR PREÇO EM 90 DIAS"
    : flags.includes("lowest_30d")
      ? "📉 MENOR PREÇO DO MÊS"
      : (offer.discountPct ?? 0) >= 50
        ? "⚡ SUPER OFERTA"
        : null;
  const hasOriginal = offer.originalPrice !== null && offer.originalPrice > offer.price;
  return {
    titulo: product.title,
    preco: brl.format(offer.price),
    preco_original: hasOriginal && offer.originalPrice ? brl.format(offer.originalPrice) : null,
    desconto: offer.discountPct ? `${offer.discountPct}%` : null,
    cupom: offer.couponCode,
    link,
    plataforma: PLATFORM_NAMES[product.platform] ?? product.platform,
    loja: product.shopName,
    selo,
  };
}

/**
 * Renderiza o modelo: escolhe uma variação, troca as variáveis e remove linhas
 * cujas variáveis ficaram vazias.
 */
export function renderTemplate(body: string, vars: TemplateVars, pickVariant = Math.random) {
  const variants = body
    .split(/^\s*---\s*$/m)
    .map((v) => v.trim())
    .filter(Boolean);
  const chosen = variants[Math.floor(pickVariant() * variants.length)] ?? body;
  const lines = chosen.split("\n").flatMap((line) => {
    let empty = false;
    const out = line.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
      const v = vars[name];
      if (v === null || v === undefined || v === "") empty = true;
      return v ?? "";
    });
    return empty ? [] : [out];
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const toTemplate = (r: typeof messageTemplates.$inferSelect): MessageTemplate => ({
  id: r.id,
  name: r.name,
  body: r.body,
  is_default: r.isDefault,
  created_at: r.createdAt.toISOString(),
});

/** Modelo escolhido, o padrão do workspace, ou o modelo embutido. */
export async function resolveTemplateBody(
  db: DbOrTx,
  workspaceId: string,
  templateId?: string | null,
) {
  if (templateId) {
    const [t] = await db
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.id, templateId), eq(messageTemplates.workspaceId, workspaceId)),
      );
    if (!t) throw new AppError("NOT_FOUND", "Modelo de mensagem não encontrado.");
    return t.body;
  }
  const [def] = await db
    .select()
    .from(messageTemplates)
    .where(
      and(eq(messageTemplates.workspaceId, workspaceId), eq(messageTemplates.isDefault, true)),
    );
  return def?.body ?? DEFAULT_TEMPLATE_BODY;
}

export async function listMessageTemplates(ctx: Ctx) {
  requireScope(ctx.actor, "posts:read");
  const rows = await ctx.db
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.workspaceId, ctx.actor.workspaceId))
    .orderBy(asc(messageTemplates.createdAt));
  return { builtin_default: DEFAULT_TEMPLATE_BODY, items: rows.map(toTemplate) };
}

export async function upsertMessageTemplate(
  ctx: Ctx,
  raw: UpsertMessageTemplateInput,
  opts: MutationOptions = {},
) {
  const input = UpsertMessageTemplateInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: input.id ? "templates.update" : "templates.create",
    scope: "posts:write",
    input,
    opts,
    target: (i) => ({ type: "message_template", id: i.id }),
    preview: async (_c, i) => {
      if (!i.id && (!i.name || !i.body)) {
        throw new AppError("VALIDATION_ERROR", "Informe name e body para criar o modelo.");
      }
      const sample = renderTemplate(
        i.body ?? DEFAULT_TEMPLATE_BODY,
        {
          titulo: "Air Fryer 4L Digital",
          preco: "R$ 299,90",
          preco_original: "R$ 499,90",
          desconto: "40%",
          cupom: "BF10",
          link: "https://go.exemplo/abc1234",
          plataforma: "Shopee",
          loja: "Loja Oficial",
          selo: "⚡ SUPER OFERTA",
        },
        () => 0,
      );
      return { ...i, sample };
    },
    execute: async (tx, i) => {
      if (i.is_default) {
        await tx.db
          .update(messageTemplates)
          .set({ isDefault: false })
          .where(
            and(
              eq(messageTemplates.workspaceId, wsId),
              i.id ? ne(messageTemplates.id, i.id) : eq(messageTemplates.isDefault, true),
            ),
          );
      }
      const values = {
        ...(i.name !== undefined && { name: i.name }),
        ...(i.body !== undefined && { body: i.body }),
        ...(i.is_default !== undefined && { isDefault: i.is_default }),
      };
      const [row] = i.id
        ? await tx.db
            .update(messageTemplates)
            .set(values)
            .where(and(eq(messageTemplates.id, i.id), eq(messageTemplates.workspaceId, wsId)))
            .returning()
        : await tx.db
            .insert(messageTemplates)
            .values({ ...values, name: i.name ?? "", body: i.body ?? "", workspaceId: wsId })
            .returning();
      if (!row) throw new AppError("NOT_FOUND", "Modelo não encontrado.");
      return toTemplate(row);
    },
  });
}
