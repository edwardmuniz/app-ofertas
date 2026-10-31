import {
  createMessagingProviderFactory,
  defaultAffiliateConnectorFactory,
} from "@ofertas/connectors";
import { createDb, runMigrations } from "@ofertas/db";
import { resetDb } from "@ofertas/db/testing";
import { DEFAULT_BRAND, renderCreative } from "@ofertas/render";
import {
  type Deps,
  MemoryCache,
  MemoryCounterStore,
  MemoryStorage,
  SecretBox,
  signup,
} from "../src";

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
