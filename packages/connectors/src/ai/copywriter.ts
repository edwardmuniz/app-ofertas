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

/** Consumo de uma ou mais chamadas à IA (para mostrar o gasto). */
export type AiUsage = {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Custo em dólar informado pelo provedor (OpenRouter); null quando ele não informa. */
  costUsd: number | null;
};

/** Soma consumos (o custo fica null só se nenhuma parte informou). */
export function addUsage(a: AiUsage | null | undefined, b: AiUsage): AiUsage {
  if (!a) return { ...b };
  return {
    provider: b.provider,
    model: b.model,
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

export type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
};

/** Lê o `usage` da resposta do OpenRouter (vem com o custo em dólar). */
export function openRouterUsage(model: string, u: OpenRouterUsage | undefined): AiUsage {
  return {
    provider: "openrouter",
    model,
    requests: 1,
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    costUsd: typeof u?.cost === "number" ? u.cost : null,
  };
}

export type CopyWriterErrorCode = "AUTH" | "BILLING" | "RATE_LIMIT" | "UNAVAILABLE" | "INVALID";

export class CopyWriterError extends Error {
  readonly code: CopyWriterErrorCode;
  /** O que já foi gasto antes do erro (ex.: agente que falhou no meio da rodada). */
  usage?: AiUsage;
  constructor(code: CopyWriterErrorCode, message: string) {
    super(message);
    this.name = "CopyWriterError";
    this.code = code;
  }
}

/** Texto gerado e o consumo da chamada. */
export type WrittenCopy = OfferCopyText & { usage?: AiUsage };

export interface CopyWriter {
  readonly provider: string;
  write(facts: CopyFacts): Promise<WrittenCopy>;
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
  // Sem nenhuma palavra (ex.: o modelo devolveu só "}") conta como vazio.
  const words = (s: string) => (/\p{L}{2}/u.test(s) ? s : "");
  const headline = words(tidy(raw.headline, LIMITS.headline));
  const body = words(tidy(raw.body, LIMITS.body));
  if (!headline || !body) throw new CopyWriterError("INVALID", "A IA devolveu um texto vazio.");
  return { headline, body, extra: words(tidy(raw.extra, LIMITS.extra)) || null };
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

  async write(facts: CopyFacts): Promise<WrittenCopy> {
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
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
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
    return {
      ...cleanCopy(parsed as Record<string, unknown>),
      usage: {
        provider: "gemini",
        model,
        requests: 1,
        inputTokens: data?.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
        costUsd: null,
      },
    };
  }
}

/** Modelo padrão no OpenRouter (escolhido pelo usuário; troque em OPENROUTER_MODEL). */
export const OPENROUTER_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const COPY_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    body: { type: "string" },
    extra: { type: "string" },
  },
  required: ["headline", "body", "extra"],
  additionalProperties: false,
};

/** Texto via OpenRouter (API no formato da OpenAI), com saída em JSON pelo schema. */
export class OpenRouterCopyWriter implements CopyWriter {
  readonly provider = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly opts: { model?: string; fetch?: typeof fetch } = {},
  ) {
    if (!apiKey) throw new CopyWriterError("AUTH", "OPENROUTER_API_KEY não configurada.");
  }

  async write(facts: CopyFacts): Promise<WrittenCopy> {
    const model = this.opts.model || OPENROUTER_DEFAULT_MODEL;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "x-title": "OfZap",
        },
        body: JSON.stringify({
          model,
          temperature: 0.9,
          messages: [{ role: "user", content: copyPrompt(facts) }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "oferta", strict: true, schema: COPY_SCHEMA },
          },
          // Provedor mais barato primeiro, entre os que aceitam saída em JSON por schema.
          provider: { sort: "price", require_parameters: true },
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      throw new CopyWriterError("UNAVAILABLE", `OpenRouter indisponível: ${String(err)}`);
    }
    const data = (await res.json().catch(() => null)) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: OpenRouterUsage;
      error?: { message?: string; code?: number };
    } | null;
    if (!res.ok || data?.error) {
      const status = data?.error?.code ?? res.status;
      const msg = data?.error?.message ?? `respondeu ${res.status}`;
      const code: CopyWriterErrorCode =
        status === 402 || /credits|insufficient|balance/i.test(msg)
          ? "BILLING"
          : status === 429
            ? "RATE_LIMIT"
            : status === 401 || status === 403
              ? "AUTH"
              : status >= 500
                ? "UNAVAILABLE"
                : "INVALID";
      throw new CopyWriterError(code, `OpenRouter: ${msg}`);
    }
    // Alguns modelos embrulham o JSON em ```json ... ```.
    const text = (data?.choices?.[0]?.message?.content ?? "")
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CopyWriterError("INVALID", "A IA devolveu um texto fora do formato.");
    }
    return {
      ...cleanCopy(parsed as Record<string, unknown>),
      usage: openRouterUsage(data?.model ?? model, data?.usage),
    };
  }
}

/** Gerador simulado (testes e demonstração): previsível, sem rede. */
export class FakeCopyWriter implements CopyWriter {
  readonly provider = "fake";
  readonly calls: CopyFacts[] = [];

  async write(facts: CopyFacts): Promise<WrittenCopy> {
    this.calls.push(facts);
    const name = facts.title.split(/[,|-]/)[0]?.trim() ?? facts.title;
    return {
      ...cleanCopy({
        headline: `Garanta já: ${name}!`,
        body: `${name} com desconto na ${facts.platform}. Ótima escolha para o dia a dia.`,
        extra: facts.hint ? `Dica: ${facts.hint}.` : "Corre que o estoque é limitado.",
      }),
      usage: {
        provider: "fake",
        model: "fake",
        requests: 1,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.0001,
      },
    };
  }
}
