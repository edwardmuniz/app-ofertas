// Teste de fumaça do adaptador contra a Evolution Go real: cria instância temporária,
// conecta (registra webhook), lê QR e status e apaga a instância. Não envia mensagens.
// Uso: pnpm --filter @ofertas/connectors exec tsx --env-file=../../.env scripts/evolution-smoke.ts
import { EvolutionGoProvider } from "../src";

const baseUrl = process.env.EVOLUTION_GO_URL;
const globalKey = process.env.EVOLUTION_GO_API_KEY;
if (!baseUrl || !globalKey) throw new Error("EVOLUTION_GO_URL / EVOLUTION_GO_API_KEY ausentes");

const p = new EvolutionGoProvider({ baseUrl, globalKey });
const step = async <T>(name: string, fn: () => Promise<T>) => {
  try {
    const r = await fn();
    const shown = JSON.stringify(r, (k, v) =>
      k === "token"
        ? "<token>"
        : typeof v === "string" && v.length > 80
          ? `${v.slice(0, 40)}…(${v.length})`
          : v,
    );
    console.log(`✓ ${name}: ${shown}`);
    return r;
  } catch (err) {
    console.log(`✗ ${name}: ${(err as Error).message}`);
    return null;
  }
};

const ref = await step("createInstance", () =>
  p.createInstance(`ofertas-smoke-${Date.now().toString(36)}`),
);
if (ref) {
  await step("connect", () => p.connect(ref, { webhookUrl: null }));
  await new Promise((r) => setTimeout(r, 3000));
  await step("status", () => p.status(ref));
  await step("getQr", () => p.getQr(ref));
  await step("deleteInstance", () => p.deleteInstance(ref.instanceId));
}
