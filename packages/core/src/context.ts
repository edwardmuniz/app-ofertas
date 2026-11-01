import type { AffiliateConnectorFactory, MessagingProviderFactory } from "@ofertas/connectors";
import { type ActorType, type Origin, type Role, SCOPES, type Scope } from "@ofertas/contracts";
import type { Db, DbOrTx } from "@ofertas/db";
import type { AlertNotifier } from "./alerts";
import type { KeyValueCache } from "./cache";
import type { CounterStore } from "./limits";
import type { MediaFetcher, PageFetcher, StreamOpener } from "./safe-fetch";
import type { SecretBox } from "./secrets";
import type { ObjectStorage } from "./storage";

export type Actor = {
  type: ActorType;
  /** id do usuário, do token ou nome do processo (system) */
  id: string;
  /** Nome legível para o log de auditoria */
  label: string;
  workspaceId: string;
  scopes: ReadonlySet<Scope>;
  origin: Origin;
  /** Presente quando o ator é um usuário logado */
  userId?: string;
  role?: Role;
};

export type Deps = {
  db: Db;
  counters: CounterStore;
  cache: KeyValueCache;
  /** URL pública do redirecionador, ex.: https://go.seudominio.com */
  redirectBaseUrl: string;
  /** Cifra credenciais de terceiros (AES-256-GCM) */
  secrets: SecretBox;
  /** Cria o conector de afiliado de uma conta (real ou simulado) */
  affiliateConnectors: AffiliateConnectorFactory;
  /** Provedores de WhatsApp (Evolution Go e simulado) */
  messaging: MessagingProviderFactory;
  /** URL pública base dos webhooks de WhatsApp, ex.: https://app.x/webhooks/whatsapp */
  messagingWebhookUrl: string | null;
  /** Arquivos (imagens dos criativos) */
  storage: ObjectStorage;
  /** Baixa mídia de URLs públicas com proteção contra endereços internos */
  fetchMedia: MediaFetcher;
  /** Baixa páginas de produto (oferta por link). */
  fetchPage: PageFetcher;
  /** Baixa arquivos grandes em fluxo (feed de produtos). */
  openStream: StreamOpener;
  /** URL pública da API: links de upload e de imagens (precisa ser acessível pela Evolution Go) */
  publicApiUrl: string;
  /** Envia alertas ao webhook do workspace (ausente = não notifica) */
  notify?: AlertNotifier;
  now?: () => Date;
};

export type Ctx = Deps & { actor: Actor };

/** Contexto dentro de uma transação: mesmas dependências, mas `db` é a transação. */
export type TxCtx = Omit<Ctx, "db"> & { db: DbOrTx };

export const now = (deps: Pick<Deps, "now">) => (deps.now ? deps.now() : new Date());

/** Ator usado por processos automáticos (worker). Tem todos os escopos do workspace. */
export function systemActor(workspaceId: string, process: string): Actor {
  return {
    type: "system",
    id: process,
    label: `sistema:${process}`,
    workspaceId,
    scopes: new Set(SCOPES),
    origin: "worker",
  };
}
