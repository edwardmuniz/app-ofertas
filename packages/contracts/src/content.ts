import { z } from "zod";

// Estúdio de conteúdo (spec 18): carrosséis montados no servidor e vídeos feitos pelo agente local.

export const CONTENT_KINDS = ["video", "carousel"] as const;
export const CONTENT_STATUS = [
  "queued",
  "rendering",
  "pending_review",
  "ready",
  "rejected",
  "failed",
] as const;

export const Content = z.object({
  id: z.string(),
  kind: z.enum(CONTENT_KINDS),
  status: z
    .enum(CONTENT_STATUS)
    .describe(
      "queued/rendering = montando no servidor (segundos); pending_review = vídeo enviado, aguardando aprovação no painel; ready = aprovado e pronto para postar; rejected = recusado (veja review_note).",
    ),
  title: z.string(),
  hook: z.string(),
  subhook: z.string().nullable(),
  outro: z.string(),
  caption: z.string().describe("Legenda para colar na rede."),
  hashtags: z.array(z.string()),
  offer_ids: z.array(z.string()),
  files: z
    .array(z.object({ url: z.string(), mime: z.string(), width: z.number(), height: z.number() }))
    .describe("Vídeo (1 arquivo) ou imagens do carrossel, na ordem."),
  cover_url: z.string().nullable(),
  seconds: z.number().nullable(),
  error: z.string().nullable(),
  review_note: z.string().nullable().describe("Motivo da recusa (ou observação da aprovação)."),
  warnings: z
    .array(z.string())
    .describe("Antes de aprovar/postar: ofertas que saíram ou mudaram de preço desde o conteúdo."),
  reviewed_at: z.string().nullable(),
  posted_to: z.array(z.string()),
  posted_at: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type Content = z.infer<typeof Content>;

export const ContentKitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(12),
  max_price: z.coerce.number().positive().optional().describe("Só ofertas até este preço (R$)."),
  min_discount: z.coerce.number().int().min(0).max(95).optional(),
  platform: z.enum(["shopee", "amazon", "mercadolivre", "magalu"]).optional(),
  q: z.string().max(100).optional().describe("Palavra no título (ex.: cozinha, fone)."),
});
export type ContentKitQuery = z.input<typeof ContentKitQuery>;

export const ContentKit = z.object({
  brand: z.string().describe("Nome da marca (vitrine ou identidade visual)."),
  storefront_url: z.string().nullable().describe("Link da bio. null = crie a vitrine antes."),
  offers: z.array(
    z.object({
      offer_id: z.string(),
      title: z.string(),
      platform: z.string(),
      category: z.string().nullable(),
      price: z.number(),
      original_price: z.number().nullable(),
      discount_pct: z.number().nullable(),
      pix_price: z.number().nullable(),
      installments: z.string().nullable(),
      image_urls: z.array(z.string()),
      score: z.number(),
      recently_used: z.boolean().describe("Já entrou num conteúdo nos últimos 3 dias."),
    }),
  ),
  tips: z.array(z.string()),
  video_brief: z
    .object({
      format: z.object({
        width: z.number(),
        height: z.number(),
        fps: z.number(),
        min_seconds: z.number(),
        max_seconds: z.number(),
        max_mb: z.number(),
      }),
      safe_area: z
        .object({ top: z.number(), bottom: z.number(), right: z.number(), left: z.number() })
        .describe("Margens em px que as redes cobrem (botões, legenda): nada importante ali."),
      brand: z.object({
        name: z.string(),
        primary_color: z.string(),
        secondary_color: z.string(),
        text_color: z.string(),
        logo_url: z.string().nullable(),
        handle: z.string().nullable().describe("Endereço da vitrine para o fechamento."),
      }),
      steps: z.array(z.string()).describe("Como montar e enviar o vídeo com HyperFrames."),
    })
    .describe("Instruções para o agente local fazer o vídeo vertical e enviar para aprovação."),
});
export type ContentKit = z.infer<typeof ContentKit>;

export const CreateContentInput = z.object({
  kind: z
    .enum(["carousel"])
    .default("carousel")
    .describe("O servidor monta carrossel (Instagram 4:5). Vídeo é feito pelo agente local."),
  offer_ids: z
    .array(z.uuid())
    .min(1)
    .max(8)
    .describe("Ofertas aprovadas, na ordem em que aparecem (3 a 5 funciona melhor)."),
  title: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe("Nome interno (ex.: Achadinhos de cozinha)."),
  hook: z
    .string()
    .trim()
    .min(3)
    .max(70)
    .describe('Frase de abertura na tela, ex.: "5 achadinhos de cozinha até R$ 100".'),
  subhook: z.string().trim().max(90).nullable().optional(),
  outro: z
    .string()
    .trim()
    .max(70)
    .optional()
    .describe('Fechamento na tela. Padrão: "Entre no grupo e receba ofertas assim todo dia".'),
  caption: z
    .string()
    .trim()
    .max(2200)
    .optional()
    .describe("Legenda da postagem. Sem ela, o sistema monta uma com as ofertas e o link na bio."),
  hashtags: z.array(z.string().trim().max(40)).max(20).optional(),
});
export type CreateContentInput = z.input<typeof CreateContentInput>;

export const UpdateContentInput = z.object({
  title: z.string().trim().max(100).optional(),
  caption: z.string().trim().max(2200).optional(),
  hashtags: z.array(z.string().trim().max(40)).max(20).optional(),
});
export type UpdateContentInput = z.infer<typeof UpdateContentInput>;

export const MarkContentPostedInput = z.object({
  platforms: z
    .array(z.string().trim().min(2).max(30))
    .min(1)
    .max(8)
    .describe("Onde foi postado: tiktok, instagram, youtube, pinterest, whatsapp..."),
  undo: z.boolean().optional().describe("true = desmarcar essas redes (marcou errado)."),
});
export type MarkContentPostedInput = z.infer<typeof MarkContentPostedInput>;

export const SubmitVideoInput = z.object({
  upload_id: z
    .uuid()
    .describe("Upload do MP4 (request_upload com mime video/mp4 e PUT do arquivo)."),
  cover_upload_id: z.uuid().optional().describe("Capa opcional (PNG/JPEG enviado por upload)."),
  offer_ids: z
    .array(z.uuid())
    .min(1)
    .max(8)
    .describe("Ofertas que aparecem no vídeo, na ordem (de get_content_kit)."),
  title: z.string().trim().max(100).optional().describe("Nome interno."),
  hook: z
    .string()
    .trim()
    .min(3)
    .max(70)
    .describe("Frase de abertura usada no vídeo (vira o título se não houver)."),
  caption: z
    .string()
    .trim()
    .max(2200)
    .optional()
    .describe("Legenda da postagem. Sem ela, o sistema monta uma com as ofertas e o link na bio."),
  hashtags: z.array(z.string().trim().max(40)).max(20).optional(),
});
export type SubmitVideoInput = z.infer<typeof SubmitVideoInput>;

export const ReviewContentInput = z.object({
  decision: z
    .enum(["approve", "reject"])
    .describe("approve: aguardando ou recusado → pronto. reject: aguardando ou pronto → recusado."),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe("Na recusa: o que mudar (o agente lê e manda outro vídeo)."),
});
export type ReviewContentInput = z.infer<typeof ReviewContentInput>;

export const ListContentsQuery = z.object({
  status: z.enum(CONTENT_STATUS).optional(),
  posted: z.enum(["yes", "no"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListContentsQuery = z.input<typeof ListContentsQuery>;
