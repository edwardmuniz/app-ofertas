import {
  createMessagingProviderFactory,
  defaultAffiliateConnectorFactory,
} from "@ofertas/connectors";
import { channelSegments, channels, createDb, runMigrations } from "@ofertas/db";
import { resetDb } from "@ofertas/db/testing";
import { DEFAULT_BRAND, renderCreative } from "@ofertas/render";
import {
  type Ctx,
  type Deps,
  MemoryCache,
  MemoryCounterStore,
  MemoryStorage,
  SecretBox,
  signup,
  syncGroups,
} from "../src";

/** Importa todos os grupos do número (prévia + escolha de todos), como faria o painel. */
export async function importAllGroups(ctx: Ctx, accountId: string) {
  const dry = await syncGroups(ctx, accountId, {}, { dryRun: true });
  if (dry.status !== "dry_run") throw new Error("esperado dry_run");
  const groups = (dry.preview as { groups: { jid: string }[] }).groups;
  const res = await syncGroups(ctx, accountId, { group_jids: groups.map((g) => g.jid) });
  if (res.status !== "done" || !res.result) throw new Error("importação falhou");
  return res.result;
}

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** Conecta no banco de teste, aplica migrations e limpa os dados. */
export async function setupTestDeps(): Promise<Deps & { close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST não definida");
  await runMigrations(url);
  const { db, close } = createDb(url, { max: 5 });
  await resetDb(db);
  return {
    db,
    counters: new MemoryCounterStore(),
    cache: new MemoryCache(),
    redirectBaseUrl: "http://go.test",
    secrets: new SecretBox(TEST_KEY),
    affiliateConnectors: defaultAffiliateConnectorFactory,
    messaging: createMessagingProviderFactory({}),
    messagingWebhookUrl: "http://api.test/webhooks/whatsapp",
    storage: new MemoryStorage(),
    fetchMedia: fakeFetchMedia,
    fetchPage: fakeFetchPage,
    openStream: fakeOpenStream,
    publicApiUrl: "http://api.test",
    close,
  };
}

let n = 0;
export async function createOwner(deps: Deps) {
  n++;
  return signup(
    deps,
    {
      name: `Dono ${n}`,
      email: `dono${n}-${Date.now()}@teste.com`,
      password: "senha-forte-123",
      workspace_name: `Loja ${n}`,
    },
    { allowSignup: true },
  );
}

let sampleImage: Buffer | null = null;
/** Sem internet nos testes: toda URL de imagem devolve um PNG gerado localmente. */
/** Páginas servidas pelo fetchPage dos testes: url pedida → página (url final, html). */
export const fakePages = new Map<string, { url: string; status?: number; html: string }>();
export async function fakeFetchPage(url: string) {
  const page = fakePages.get(url);
  if (!page) throw new Error(`página não cadastrada no teste: ${url}`);
  return { status: 200, ...page };
}

/** Arquivos servidos pelo openStream dos testes (feed de produtos): url → conteúdo. */
export const fakeFiles = new Map<string, string>();
export async function fakeOpenStream(url: string) {
  const content = fakeFiles.get(url);
  if (content === undefined) throw new Error(`arquivo não cadastrado no teste: ${url}`);
  const bytes = new TextEncoder().encode(content);
  // Em pedaços pequenos, para exercitar a leitura em fluxo.
  const body = (async function* () {
    for (let i = 0; i < bytes.length; i += 64) yield bytes.subarray(i, i + 64);
  })();
  return { body, size: bytes.length };
}

export async function fakeFetchMedia(_url: string) {
  sampleImage ??= (
    await renderCreative({
      template: "card_preco",
      format: "wa_image",
      data: {
        title: "Foto",
        price: "R$ 1",
        originalPrice: null,
        discountPct: null,
        coupon: null,
        badge: null,
        platform: "",
        image: null,
      },
      brand: DEFAULT_BRAND,
    })
  ).preview.png;
  return { data: sampleImage, contentType: "image/png" };
}

/** Canal direto no banco (grupo de fora do WhatsApp conectado), para testes de convite/links. */
export async function insertChannel(
  deps: Pick<Deps, "db">,
  workspaceId: string,
  v: {
    name: string;
    invite_url?: string | null;
    member_count?: number;
    member_limit?: number;
    segment_ids?: string[];
  },
) {
  const [row] = await deps.db
    .insert(channels)
    .values({
      workspaceId,
      name: v.name,
      inviteUrl: v.invite_url ?? null,
      memberCount: v.member_count ?? 0,
      memberLimit: v.member_limit ?? 1024,
    })
    .returning();
  if (!row) throw new Error("canal");
  if (v.segment_ids?.length) {
    await deps.db
      .insert(channelSegments)
      .values(v.segment_ids.map((segmentId) => ({ channelId: row.id, segmentId })));
  }
  return { ...row, segment_ids: v.segment_ids ?? [] };
}
