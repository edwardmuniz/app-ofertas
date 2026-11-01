// Texto de divulgação gerado por IA (Gemini). Só escreve a chamada, a descrição e o fechamento:
// preço, parcelas e link entram pelo sistema, sempre atualizados.

/** Fatos do produto passados ao modelo (nada além disso deve aparecer no texto). */
export type CopyFacts = {
  title: string;
  platform: string;
  price: string;
  originalPrice: string | null;
  discountPct: number | null;
  pixPrice: string | null;
  installments: string | null;
  coupon: string | null;
  category: string | null;
  shop: string | null;
  /** Tom de voz do workspace (Preferências) */
  tone: string | null;
  /** Instrução extra de quem pediu, ex.: "foque em quem joga" */
  hint: string | null;
};

export type OfferCopyText = {
  /** Frase de impacto (vai em negrito no topo) */
  headline: string;
  /** 1 ou 2 frases sobre o produto */
  body: string;
  /** Fechamento: urgência, condição especial ou dica (opcional) */
  extra: string | null;
};

export type CopyWriterErrorCode = "AUTH" | "BILLING" | "RATE_LIMIT" | "UNAVAILABLE" | "INVALID";

export class CopyWriterError extends Error {
  readonly code: CopyWriterErrorCode;
  constructor(code: CopyWriterErrorCode, message: string) {
    super(message);
    this.name = "CopyWriterError";
    this.code = code;
  }
}

export interface CopyWriter {
  readonly provider: string;
  write(facts: CopyFacts): Promise<OfferCopyText>;
}

/** Apelido que sempre aponta para o Flash atual (modelos antigos saem do ar para contas novas). */
export const GEMINI_DEFAULT_MODEL = "gemini-flash-latest";

const LIMITS = { headline: 90, body: 320, extra: 200 };

/** Corta e limpa o que o modelo devolveu (sem links, sem asteriscos soltos). */
export function cleanCopy(raw: Partial<Record<keyof OfferCopyText, unknown>>): OfferCopyText {
  const tidy = (v: unknown, max: number) =>
    typeof v === "string"
      ? v
          .replace(/https?:\/\/\S+/g, "")
          .replace(/[*_~]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, max)
      : "";
  const headline = tidy(raw.headline, LIMITS.headline);
  const body = tidy(raw.body, LIMITS.body);
  if (!headline || !body) throw new CopyWriterError("INVALID", "A IA devolveu um texto vazio.");
  return { headline, body, extra: tidy(raw.extra, LIMITS.extra) || null };
}

export function copyPrompt(f: CopyFacts): string {
  const facts = [
    `Produto: ${f.title}`,
    `Loja: ${f.platform}${f.shop ? ` (vendedor: ${f.shop})` : ""}`,
    f.category ? `Categoria: ${f.category}` : null,
    `Preço: ${f.price}${f.originalPrice ? ` (antes ${f.originalPrice})` : ""}`,
    f.discountPct ? `Desconto: ${f.discountPct}%` : null,
    f.pixPrice ? `Preço no Pix: ${f.pixPrice}` : null,
    f.installments ? `Parcelamento: ${f.installments}` : null,
    f.coupon ? `Cupom: ${f.coupon}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `Você escreve mensagens de ofertas para grupos de WhatsApp no Brasil.
Escreva em português do Brasil, natural e animado, sem exageros nem promessas falsas.
${f.tone ? `Tom de voz da marca: ${f.tone}\n` : ""}${f.hint ? `Pedido de quem vai publicar: ${f.hint}\n` : ""}
Dados do produto:
${facts}

Devolva JSON com:
- "headline": uma frase curta de impacto (até 70 caracteres), pode ter 1 emoji.
- "body": 1 ou 2 frases sobre por que vale a pena (até 240 caracteres).
- "extra": uma frase de fechamento com urgência ou dica de uso (até 140 caracteres), ou vazio.

Regras: NÃO escreva preços, valores, parcelas, porcentagens, cupons nem links (o sistema coloca).
Não invente características que não estejam no nome do produto. Sem hashtags. Sem asteriscos.`;
}

export class GeminiCopyWriter implements CopyWriter {
  readonly provider = "gemini";

  constructor(
    private readonly apiKey: string,
    private readonly opts: { model?: string; fetch?: typeof fetch } = {},
  ) {
    if (!apiKey) throw new CopyWriterError("AUTH", "GOOGLE_API_KEY não configurada.");
  }

  async write(facts: CopyFacts): Promise<OfferCopyText> {
    const model = this.opts.model || GEMINI_DEFAULT_MODEL;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: copyPrompt(facts) }] }],
            generationConfig: {
              temperature: 0.9,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  headline: { type: "STRING" },
                  body: { type: "STRING" },
                  extra: { type: "STRING" },
                },
                required: ["headline", "body"],
              },
            },
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (err) {
      throw new CopyWriterError("UNAVAILABLE", `Gemini indisponível: ${String(err)}`);
    }
    const data = (await res.json().catch(() => null)) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string; status?: string };
    } | null;
    if (!res.ok) {
      const msg = data?.error?.message ?? `respondeu ${res.status}`;
      const code: CopyWriterErrorCode = /credits|billing|prepay/i.test(msg)
        ? "BILLING"
        : res.status === 429
          ? "RATE_LIMIT"
          : res.status === 401 ||
              res.status === 403 ||
              /API key/i.test(msg) ||
              data?.error?.status === "PERMISSION_DENIED"
            ? "AUTH"
            : res.status >= 500
              ? "UNAVAILABLE"
              : "INVALID";
      throw new CopyWriterError(code, `Gemini: ${msg}`);
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CopyWriterError("INVALID", "A IA devolveu um texto fora do formato.");
    }
    return cleanCopy(parsed as Record<string, unknown>);
  }
}

/** Gerador simulado (testes e demonstração): previsível, sem rede. */
export class FakeCopyWriter implements CopyWriter {
  readonly provider = "fake";
  readonly calls: CopyFacts[] = [];

  async write(facts: CopyFacts): Promise<OfferCopyText> {
    this.calls.push(facts);
    const name = facts.title.split(/[,|-]/)[0]?.trim() ?? facts.title;
    return cleanCopy({
      headline: `Garanta já: ${name}!`,
      body: `${name} com desconto na ${facts.platform}. Ótima escolha para o dia a dia.`,
      extra: facts.hint ? `Dica: ${facts.hint}.` : "Corre que o estoque é limitado.",
    });
  }
}
