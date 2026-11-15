// Agente de IA com ferramentas (tool calling): o modelo decide o que chamar, o sistema executa.
// Usado pelo curador automático de ofertas. As ferramentas ficam no core; aqui só o laço.
import { CopyWriterError, type CopyWriterErrorCode, OPENROUTER_URL } from "./copywriter";

export type AgentTool = {
  name: string;
  description: string;
  /** JSON Schema dos argumentos */
  parameters: Record<string, unknown>;
};

export type AgentToolCall = { name: string; args: Record<string, unknown> };

export type AgentRunInput = {
  system: string;
  prompt: string;
  tools: AgentTool[];
  /** Máximo de idas ao modelo (cada uma pode pedir várias ferramentas). */
  maxTurns: number;
  /** Executa a ferramenta. Erros lançados viram `{ error }` para o modelo. */
  callTool: (call: AgentToolCall) => Promise<unknown>;
};

export type AgentRunResult = {
  /** Última mensagem de texto do modelo (resumo da rodada) */
  text: string;
  turns: number;
  toolCalls: number;
};

export interface ToolAgent {
  readonly provider: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

/** Executa a ferramenta sem deixar o erro derrubar o laço. */
async function safeCall(input: AgentRunInput, call: AgentToolCall): Promise<unknown> {
  try {
    return await input.callTool(call);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

function openRouterError(status: number, msg: string): CopyWriterError {
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
  return new CopyWriterError(code, `OpenRouter: ${msg}`);
}

/**
 * Agente pelo OpenRouter (formato de chat da OpenAI com `tools`). Usa o provedor mais barato
 * entre os que aceitam ferramentas. Erros do OpenRouter saem como `CopyWriterError`, o erro
 * padrão de IA dos conectores.
 */
export class OpenRouterToolAgent implements ToolAgent {
  readonly provider = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly opts: { model: string; fetch?: typeof fetch },
  ) {
    if (!apiKey) throw new CopyWriterError("AUTH", "OPENROUTER_API_KEY não configurada.");
  }

  private async chat(messages: ChatMessage[], tools: AgentTool[], allowTools: boolean) {
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
          model: this.opts.model,
          messages,
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: allowTools ? "auto" : "none",
          provider: { sort: "price", require_parameters: true },
        }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      throw new CopyWriterError("UNAVAILABLE", `OpenRouter indisponível: ${String(err)}`);
    }
    const data = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
      error?: { message?: string; code?: number };
    } | null;
    if (!res.ok || data?.error) {
      throw openRouterError(
        data?.error?.code ?? res.status,
        data?.error?.message ?? `respondeu ${res.status}`,
      );
    }
    const message = data?.choices?.[0]?.message;
    if (!message) throw new CopyWriterError("INVALID", "OpenRouter: resposta sem mensagem.");
    return message;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: input.system },
      { role: "user", content: input.prompt },
    ];
    let toolCalls = 0;
    let text = "";
    for (let turn = 1; turn <= input.maxTurns; turn++) {
      // Na última ida o modelo só pode responder em texto (fecha a rodada).
      const message = await this.chat(messages, input.tools, turn < input.maxTurns);
      const calls = message.tool_calls ?? [];
      if (message.content) text = message.content;
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      if (calls.length === 0) return { text, turns: turn, toolCalls };
      for (const c of calls) {
        toolCalls++;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await safeCall(input, { name: c.function.name, args });
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
      }
    }
    return { text, turns: input.maxTurns, toolCalls };
  }
}

/**
 * Agente simulado (testes): roda um roteiro que chama as ferramentas como o modelo faria.
 * Sem roteiro, não chama nada.
 */
export class FakeToolAgent implements ToolAgent {
  readonly provider = "fake";
  readonly runs: AgentRunInput[] = [];

  constructor(
    private readonly script: (
      call: (name: string, args?: Record<string, unknown>) => Promise<unknown>,
      input: AgentRunInput,
    ) => Promise<string> = async () => "Nada a fazer.",
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input);
    let toolCalls = 0;
    const text = await this.script(async (name, args = {}) => {
      toolCalls++;
      return safeCall(input, { name, args });
    }, input);
    return { text, turns: toolCalls + 1, toolCalls };
  }
}
