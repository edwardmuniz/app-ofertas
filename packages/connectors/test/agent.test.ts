import { describe, expect, it } from "vitest";
import { FakeToolAgent, OPENROUTER_URL, OpenRouterToolAgent } from "../src";

const TOOLS = [
  {
    name: "search_offers",
    description: "Busca",
    parameters: { type: "object", properties: { keyword: { type: "string" } } },
  },
];

function fetchSeq(responses: Response[]) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    if (!next) throw new Error("sem resposta");
    return next;
  }) as unknown as typeof fetch;
  return { fn, bodies, urls };
}

describe("OpenRouterToolAgent", () => {
  it("executa as ferramentas pedidas, devolve o resultado ao modelo e termina no texto", async () => {
    const { fn, bodies, urls } = fetchSeq([
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "search_offers", arguments: '{"keyword":"panela"}' },
                },
                { id: "c2", type: "function", function: { name: "boom", arguments: "{" } },
              ],
            },
          },
        ],
      }),
      Response.json({ choices: [{ message: { content: "Escolhi 2 ofertas." } }] }),
    ]);
    const calls: unknown[] = [];
    const agent = new OpenRouterToolAgent("chave", { model: "m", fetch: fn });
    const out = await agent.run({
      system: "s",
      prompt: "p",
      tools: TOOLS,
      maxTurns: 5,
      callTool: async (c) => {
        calls.push(c);
        if (c.name === "boom") throw new Error("falhou");
        return { results: [1] };
      },
    });

    expect(out).toEqual({ text: "Escolhi 2 ofertas.", turns: 2, toolCalls: 2 });
    expect(calls).toEqual([
      { name: "search_offers", args: { keyword: "panela" } },
      { name: "boom", args: {} },
    ]);
    expect(urls[0]).toBe(OPENROUTER_URL);
    expect(bodies[0]).toMatchObject({
      model: "m",
      tool_choice: "auto",
      provider: { sort: "price", require_parameters: true },
    });
    const second = bodies[1]?.messages as { role: string; content: string }[];
    expect(second.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content))).toEqual([
      { results: [1] },
      { error: "falhou" },
    ]);
  });

  it("na última ida não oferece ferramentas; sem créditos vira BILLING", async () => {
    const loop = Response.json({
      choices: [
        {
          message: {
            content: "buscando",
            tool_calls: [
              { id: "c", type: "function", function: { name: "search_offers", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    const { fn, bodies } = fetchSeq([
      loop,
      Response.json({ choices: [{ message: { content: "fim" } }] }),
    ]);
    const agent = new OpenRouterToolAgent("chave", { model: "m", fetch: fn });
    const out = await agent.run({
      system: "s",
      prompt: "p",
      tools: TOOLS,
      maxTurns: 2,
      callTool: async () => ({}),
    });
    expect(out.text).toBe("fim");
    expect(bodies[1]).toMatchObject({ tool_choice: "none" });

    const broke = fetchSeq([
      Response.json({ error: { code: 402, message: "Insufficient credits" } }, { status: 402 }),
    ]);
    await expect(
      new OpenRouterToolAgent("chave", { model: "m", fetch: broke.fn }).run({
        system: "s",
        prompt: "p",
        tools: TOOLS,
        maxTurns: 2,
        callTool: async () => ({}),
      }),
    ).rejects.toMatchObject({ code: "BILLING" });
  });

  it("agente simulado roda o roteiro", async () => {
    const agent = new FakeToolAgent(async (call) => {
      const r = await call("search_offers", { keyword: "x" });
      return JSON.stringify(r);
    });
    const out = await agent.run({
      system: "s",
      prompt: "p",
      tools: TOOLS,
      maxTurns: 3,
      callTool: async (c) => ({ got: c.args }),
    });
    expect(out.text).toBe('{"got":{"keyword":"x"}}');
    expect(out.toolCalls).toBe(1);
  });
});
