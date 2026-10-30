import { FakeAffiliateConnector } from "./fake";
import { ShopeeConnector } from "./shopee";
import { type AffiliateConnector, ConnectorError, type Platform } from "./types";

export type ConnectorAccount = {
  platform: Platform;
  mode: "live" | "fake";
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

export const defaultAffiliateConnectorFactory: AffiliateConnectorFactory = (account) => {
  if (account.mode === "fake") return new FakeAffiliateConnector(account.platform);
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
