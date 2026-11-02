import { describe, expect, it } from "vitest";
import {
  type CopyFacts,
  CopyWriterError,
  cleanCopy,
  copyPrompt,
  GEMINI_DEFAULT_MODEL,
  GeminiCopyWriter,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_URL,
  OpenRouterCopyWriter,
} from "../src";

const FACTS: CopyFacts = {
  title: "Grand Theft Auto VI - PlayStation 5",
  platform: "Amazon",
  price: "R$ 449,90",
  originalPrice: null,
  discountPct: null,
  pixPrice: "R$ 395,91",
  installments: "12x de R$ 37,51 sem juros",
  coupon: null,
  category: "Games",
  shop: null,
  tone: "animado, fala com gamers",
  hint: null,
};

describe("texto por IA", () => {
  it("o pedido manda não escrever preço nem link e leva o tom de voz", () => {
    const prompt = copyPrompt(FACTS);
    expect(prompt).toContain("NÃO escreva preços");
    expect(prompt).toContain("animado, fala com gamers");
    expect(prompt).toContain("Preço no Pix: R$ 395,91");
  });

  it("limpa links e marcação e exige chamada e descrição", () => {
    expect(
      cleanCopy({
        headline: " *Garanta o GTA VI!* ",
        body: "Reserve já https://amzn.to/x  agora",
        extra: "",
      }),
    ).toEqual({ headline: "Garanta o GTA VI!", body: "Reserve já agora", extra: null });
    expect(() => cleanCopy({ headline: "", body: "x" })).toThrow(CopyWriterError);
  });

  it("Gemini: chama generateContent com a chave no cabeçalho e lê o JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    headline: "Garanta o tão esperado GTA VI para PS5!",
                    body: "Prepare-se para Vice City!",
                    extra: "Oferta especial antes do lançamento.",
                  }),
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const w = new GeminiCopyWriter("chave-teste", { fetch: fetchMock });
    const out = await w.write(FACTS);
    expect(out.headline).toBe("Garanta o tão esperado GTA VI para PS5!");
    expect(calls[0]?.url).toContain(`/models/${GEMINI_DEFAULT_MODEL}:generateContent`);
    expect(new Headers(calls[0]?.init.headers).get("x-goog-api-key")).toBe("chave-teste");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("Gemini: chave inválida vira AUTH; limite vira RATE_LIMIT", async () => {
    const respond = (status: number, message: string) =>
      (async () =>
        Response.json(
          { error: { message, status: "INVALID_ARGUMENT" } },
          { status },
        )) as unknown as typeof fetch;
    await expect(
      new GeminiCopyWriter("x", {
        fetch: respond(400, "API key not valid. Please pass a valid API key."),
      }).write(FACTS),
    ).rejects.toMatchObject({ code: "AUTH" });
    await expect(
      new GeminiCopyWriter("x", { fetch: respond(429, "quota") }).write(FACTS),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    await expect(
      new GeminiCopyWriter("x", {
        fetch: respond(429, "Your prepayment credits are depleted."),
      }).write(FACTS),
    ).rejects.toMatchObject({ code: "BILLING" });
  });

  it("OpenRouter: chama chat/completions com o modelo e schema e lê o JSON (mesmo entre crases)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        choices: [
          {
            message: {
              content:
                '```json\n{"headline":"GTA VI chegando!","body":"Vice City te espera.","extra":""}\n```',
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const out = await new OpenRouterCopyWriter("chave", { fetch: fetchMock }).write(FACTS);
    expect(out).toEqual({
      headline: "GTA VI chegando!",
      body: "Vice City te espera.",
      extra: null,
    });
    expect(calls[0]?.url).toBe(OPENROUTER_URL);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer chave");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe(OPENROUTER_DEFAULT_MODEL);
    expect(body.response_format.type).toBe("json_schema");
  });

  it("OpenRouter: sem créditos vira BILLING; chave errada vira AUTH", async () => {
    const respond = (status: number, message: string) =>
      (async () =>
        Response.json({ error: { message, code: status } }, { status })) as unknown as typeof fetch;
    await expect(
      new OpenRouterCopyWriter("x", { fetch: respond(402, "Insufficient credits") }).write(FACTS),
    ).rejects.toMatchObject({ code: "BILLING" });
    await expect(
      new OpenRouterCopyWriter("x", { fetch: respond(401, "No auth credentials found") }).write(
        FACTS,
      ),
    ).rejects.toMatchObject({ code: "AUTH" });
  });
});
