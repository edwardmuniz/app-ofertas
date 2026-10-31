import { z } from "zod";

export const CREATIVE_FORMATS = ["wa_image", "feed_4x5", "story_9x16"] as const;
export const CREATIVE_TEMPLATES = ["card_preco", "cupom_destaque"] as const;
export const UPLOAD_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use cor hexadecimal, ex.: #E11D48");

export const BrandKit = z.object({
  name: z.string(),
  primary_color: z.string(),
  secondary_color: z.string(),
  text_color: z.string(),
  cta: z.string(),
});
export type BrandKit = z.infer<typeof BrandKit>;

export const UpdateBrandKitInput = z.object({
  name: z.string().trim().min(1).max(40).optional().describe("Nome exibido nos criativos."),
  primary_color: hexColor.optional().describe("Cor de destaque (preço, selos)."),
  secondary_color: hexColor.optional().describe("Cor de fundo."),
  text_color: hexColor.optional(),
  cta: z.string().trim().min(1).max(40).optional().describe("Chamada, ex.: Link na legenda."),
});
export type UpdateBrandKitInput = z.infer<typeof UpdateBrandKitInput>;

export const CreativeTemplateInfo = z.object({
  key: z.enum(CREATIVE_TEMPLATES),
  name: z.string(),
  description: z.string(),
  formats: z.array(
    z.object({
      key: z.enum(CREATIVE_FORMATS),
      width: z.number(),
      height: z.number(),
      label: z.string(),
    }),
  ),
  params: z.record(z.string(), z.string()).describe("Parâmetros opcionais aceitos e o que fazem."),
});

const ValidationIssue = z.object({ code: z.string(), message: z.string(), hint: z.string() });

export const CreativeVariant = z.object({
  format: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  url: z.string().describe("Imagem em tamanho cheio (URL assinada)."),
  preview_url: z.string().nullable().describe("Miniatura para conferir o resultado."),
  validation: z.array(ValidationIssue).describe("Problemas para este formato (vazio = ok)."),
});

export const Creative = z.object({
  id: z.string(),
  offer_id: z.string().nullable(),
  title: z.string(),
  origin: z.enum(["template", "upload", "import"]),
  template: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  rendered_price: z.number().nullable(),
  status: z.enum(["ready", "archived"]),
  tags: z.array(z.string()),
  ai_generated: z.boolean(),
  variants: z.array(CreativeVariant),
  created_by: z.string(),
  created_at: z.string(),
});
export type Creative = z.infer<typeof Creative>;

export const GenerateCreativeInput = z.object({
  offer_id: z.uuid(),
  template: z.enum(CREATIVE_TEMPLATES).default("card_preco"),
  formats: z.array(z.enum(CREATIVE_FORMATS)).min(1).max(3).default(["wa_image"]),
  headline: z.string().max(40).optional().describe("Texto no topo direito (padrão: plataforma)."),
  cta: z.string().max(40).optional().describe("Chamada no botão (padrão: brand kit)."),
  accent_color: hexColor.optional().describe("Sobrescreve a cor de destaque."),
});
export type GenerateCreativeInput = z.input<typeof GenerateCreativeInput>;

export const RequestUploadInput = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.enum(UPLOAD_MIME),
  size_bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});
export type RequestUploadInput = z.infer<typeof RequestUploadInput>;

export const UploadTicket = z.object({
  upload_id: z.string(),
  put_url: z.string(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expires_at: z.string(),
  curl: z.string().describe("Comando pronto para enviar o arquivo."),
});
export type UploadTicket = z.infer<typeof UploadTicket>;

const CreativeMeta = {
  offer_id: z.uuid().optional(),
  title: z.string().max(200).optional(),
  tags: z.array(z.string().max(30)).max(20).optional(),
  ai_generated: z
    .boolean()
    .optional()
    .describe("Marque true se a imagem foi gerada por IA (rótulo exigido em anúncios)."),
};

export const CompleteUploadInput = z.object({ upload_id: z.uuid(), ...CreativeMeta });
export type CompleteUploadInput = z.infer<typeof CompleteUploadInput>;

export const ImportMediaInput = z.object({
  url: z.url({ protocol: /^https?$/ }),
  ...CreativeMeta,
});
export type ImportMediaInput = z.infer<typeof ImportMediaInput>;

export const ListCreativesQuery = z.object({
  offer_id: z.uuid().optional(),
  origin: z.enum(["template", "upload", "import"]).optional(),
  include_archived: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListCreativesQuery = z.input<typeof ListCreativesQuery>;

export const CreativePage = z.object({
  items: z.array(Creative),
  next_cursor: z.string().nullable(),
});

export const ValidateCreativeInput = z.object({
  creative_id: z.uuid(),
  format: z.enum(CREATIVE_FORMATS).describe("Formato de destino a conferir."),
});
export type ValidateCreativeInput = z.infer<typeof ValidateCreativeInput>;
