import { FakeAffiliateConnector } from "./fake";
import { ShopeeConnector } from "./shopee";
import { type AffiliateConnector, ConnectorError, type Platform } from "./types";

export type ConnectorAccount = {
  platform: Platform;
  mode: "live" | "fake" | "feed";
  credentials: Record<string, string> | null;
};

export type AffiliateConnectorFactory = (account: ConnectorAccount) => AffiliateConnector;

/** Campos de credencial por plataforma (exibidos no painel). */
export const CREDENTIAL_FIELDS: Record<Platform, { key: string; label: string }[]> = {
  shopee: [
    { key: "app_id", label: "AppID" },
    { key: "secret", label: "Secret" },
  ],
  amazon: [],
  mercadolivre: [],
  magalu: [],
};

/** Campos do modo feed (feed de produtos em CSV + ID de afiliado para montar os links). */
export const FEED_FIELDS: Partial<Record<Platform, { key: string; label: string }[]>> = {
  shopee: [
    { key: "affiliate_id", label: "ID de afiliado" },
    { key: "feed_urls", label: "Links do feed (um por linha)" },
  ],
};

export const defaultAffiliateConnectorFactory: AffiliateConnectorFactory = (account) => {
  if (account.mode === "fake") return new FakeAffiliateConnector(account.platform);
  if (account.mode === "feed") {
    // O modo feed lê o catálogo local (banco); quem monta o conector é o core.
    throw new ConnectorError(account.platform, "UNSUPPORTED", "Modo feed é montado pelo core.");
  }
  switch (account.platform) {
    case "shopee":
      return new ShopeeConnector({
        app_id: account.credentials?.app_id ?? "",
        secret: account.credentials?.secret ?? "",
      });
    default:
      throw new ConnectorError(
        account.platform,
        "UNSUPPORTED",
        `Conector ${account.platform} ainda não implementado (Fase 7).`,
      );
  }
};
