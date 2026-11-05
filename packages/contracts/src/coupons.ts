import { z } from "zod";
import { PLATFORMS } from "./offers";

const isoDate = z.iso.datetime({ offset: true });

import { httpUrl } from "./channels";

export const StoreCoupon = z.object({
  id: z.string(),
  platform: z.enum(PLATFORMS),
  title: z.string(),
  code: z.string().nullable(),
  details: z.string().nullable(),
  url: z.string(),
  affiliate_url: z.string().nullable().describe("O link com a sua afiliação, usado no envio."),
  image_url: z.string().nullable(),
  valid_until: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  active: z.boolean().describe("Ativo e dentro da validade: pode ser divulgado."),
  posts_sent: z.number().describe("Quantos envios deste cupom já saíram."),
  created_at: z.string(),
});
export type StoreCoupon = z.infer<typeof StoreCoupon>;

export const UpsertStoreCouponInput = z.object({
  id: z.uuid().optional().describe("Para editar um cupom existente."),
  platform: z.enum(PLATFORMS),
  title: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .describe("Chamada do cupom, ex.: R$ 20 OFF acima de R$ 99."),
  code: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .nullable()
    .optional()
    .describe("Código para digitar no carrinho. Sem código: o cupom é resgatado pelo link."),
  details: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .optional()
    .describe("Regras extras, ex.: só no app, limitado aos primeiros 1.000."),
  url: httpUrl.describe(
    "Página do cupom ou da loja. Vira link de afiliado quando a conta da loja permite.",
  ),
  image_url: httpUrl.nullable().optional().describe("Imagem enviada junto (opcional)."),
  valid_until: isoDate
    .nullable()
    .optional()
    .describe("Até quando vale (ISO 8601). Vencido, os envios agendados não saem."),
});
export type UpsertStoreCouponInput = z.input<typeof UpsertStoreCouponInput>;

export const ListStoreCouponsQuery = z.object({
  status: z
    .enum(["active", "all"])
    .default("active")
    .describe("active = só os que podem ser divulgados agora."),
});
export type ListStoreCouponsQuery = z.input<typeof ListStoreCouponsQuery>;
