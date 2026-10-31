import { EvolutionGoProvider } from "./evolution-go";
import { FakeMessagingProvider } from "./fake";
import { MessagingError, type MessagingProvider, type MessagingProviderName } from "./types";

export type MessagingProviderFactory = (name: MessagingProviderName) => MessagingProvider;

export function createMessagingProviderFactory(cfg: {
  evolutionGo?: { baseUrl: string; globalKey: string } | null;
}): MessagingProviderFactory {
  const fake = new FakeMessagingProvider();
  const evo =
    cfg.evolutionGo?.baseUrl && cfg.evolutionGo.globalKey
      ? new EvolutionGoProvider(cfg.evolutionGo)
      : null;
  return (name) => {
    if (name === "fake") return fake;
    if (!evo) {
      throw new MessagingError(
        "NOT_CONFIGURED",
        "Evolution Go não configurada (EVOLUTION_GO_URL e EVOLUTION_GO_API_KEY no .env).",
      );
    }
    return evo;
  };
}
