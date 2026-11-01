import { AmazonConnector } from "./amazon";
import { FakeAffiliateConnector } from "./fake";
import { ShopeeConnector } from "./shopee";
import { type AffiliateConnector, ConnectorError, type PageReader, type Platform } from "./types";

export type ConnectorAccount = {
  platform: Platform;
  mode: "live" | "fake" | "feed";
  credentials: Record<string, string> | null;
  /** Leitura de páginas de produto (Amazon sem API). */
  fetchPage?: PageReader;
};

export type CredentialField = {
  key: string;
  label: string;
  /** Pode ficar em branco (ex.: credenciais da Creators API, só para quem já tem acesso) */
  optional?: boolean;
  secret?: boolean;
  placeholder?: string;
};

export type AffiliateConnectorFactory = (account: ConnectorAccount) => AffiliateConnector;

/** Campos de credencial por plataforma (exibidos no painel). */
export const CREDENTIAL_FIELDS: Record<Platform, CredentialField[]> = {
  shopee: [
    { key: "app_id", label: "AppID" },
    { key: "secret", label: "Secret", secret: true },
  ],
  amazon: [
    { key: "partner_tag", label: "Tag de associado", placeholder: "minhaloja-20" },
    { key: "credential_id", label: "Creators API: Credential ID", optional: true },
    { key: "credential_secret", label: "Creators API: Secret", optional: true, secret: true },
  ],
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
    case "amazon":
      return new AmazonConnector(
        {
          partner_tag: account.credentials?.partner_tag ?? "",
          credential_id: account.credentials?.credential_id,
          credential_secret: account.credentials?.credential_secret,
        },
        { fetchPage: account.fetchPage },
      );
    default:
      throw new ConnectorError(
        account.platform,
        "UNSUPPORTED",
        `Conector ${account.platform} ainda não implementado (Fase 7).`,
      );
  }
};
