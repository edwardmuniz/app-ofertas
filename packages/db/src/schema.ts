import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

// Colunas comuns. As tabelas usam casing snake_case (configurado no client e no drizzle-kit).
const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const workspaceId = () =>
  uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export type WorkspaceSettings = {
  preferences?: Record<string, unknown>;
  brand_kit?: Record<string, string>;
};

// ── Identidade e acesso ─────────────────────────────────────────────

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text().notNull(),
  timezone: text().notNull().default("America/Sao_Paulo"),
  settings: jsonb().$type<WorkspaceSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    workspaceId: workspaceId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text({ enum: ["owner", "admin", "operator", "viewer"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 do token do cookie */
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: workspaceId(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId)],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text().notNull(),
    tokenHash: text().notNull().unique(),
    prefix: text().notNull(),
    scopes: text().array().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

// ── Governança ──────────────────────────────────────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    workspaceId: workspaceId(),
    actorType: text({ enum: ["user", "token", "system"] }).notNull(),
    actorId: text().notNull(),
    actorLabel: text().notNull(),
    origin: text({ enum: ["web", "rest", "mcp", "cli", "worker"] }).notNull(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    params: jsonb(),
    reason: text(),
    result: text({ enum: ["ok", "error", "pending_approval"] }).notNull(),
    error: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt, t.id)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    workspaceId: workspaceId(),
    key: text().notNull(),
    actorId: text().notNull(),
    requestHash: text().notNull(),
    response: jsonb().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

export const limits = pgTable(
  "limits",
  {
    id: id(),
    workspaceId: workspaceId(),
    key: text().notNull(),
    value: integer().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.key)],
);

export const policies = pgTable(
  "policies",
  {
    id: id(),
    workspaceId: workspaceId(),
    actionType: text().notNull(),
    mode: text({ enum: ["auto", "approval", "blocked"] }).notNull(),
    conditions: jsonb(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.actionType)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    workspaceId: workspaceId(),
    actionType: text().notNull(),
    payload: jsonb().notNull(),
    preview: jsonb(),
    requestedByType: text({ enum: ["user", "token", "system"] }).notNull(),
    requestedById: text().notNull(),
    reason: text(),
    status: text({ enum: ["pending", "approved", "rejected", "expired"] })
      .notNull()
      .default("pending"),
    decidedBy: uuid().references(() => users.id),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.status)],
);

// ── Canais (cadastro manual na Fase 1; importação do WhatsApp na Fase 3) ──

export const channels = pgTable(
  "channels",
  {
    id: id(),
    workspaceId: workspaceId(),
    type: text({ enum: ["wa_group", "wa_community", "wa_channel", "ig_account", "telegram"] })
      .notNull()
      .default("wa_group"),
    name: text().notNull(),
    externalId: text(),
    inviteUrl: text(),
    memberCount: integer().notNull().default(0),
    memberLimit: integer().notNull().default(1024),
    status: text({ enum: ["active", "paused", "archived"] })
      .notNull()
      .default("active"),
    /** Número de WhatsApp que publica neste canal */
    messagingAccountId: uuid().references(() => messagingAccounts.id, { onDelete: "set null" }),
    /** Só administradores enviam mensagens (recomendado para grupos de ofertas) */
    adminOnly: boolean(),
    /** O número ligado é admin do grupo (sem isso não publica em grupo "só admins") */
    numberIsAdmin: boolean(),
    description: text(),
    /** Só admins editam nome, descrição e foto */
    locked: boolean(),
    /** Entrada precisa de aprovação de um admin */
    approvalRequired: boolean(),
    /** Só admins adicionam membros */
    adminsAddMembers: boolean(),
    /** Estado do grupo no WhatsApp (via webhook): apagado ou suspenso pausa o canal */
    providerState: text({ enum: ["ok", "deleted", "suspended"] })
      .notNull()
      .default("ok"),
    /** Comunidade a que o grupo está ligado (JID) */
    communityJid: text(),
    lastSyncedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId), uniqueIndex().on(t.workspaceId, t.externalId)],
);

/**
 * Telefones da equipe (dono, número reserva, moderadores). Só eles podem ser adicionados a
 * grupos pela plataforma: adicionar clientes sem consentimento é spam (banimento e LGPD).
 */
export const teamContacts = pgTable(
  "team_contacts",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** Só dígitos, com DDI (ex.: 5511999998888) */
    phone: text().notNull(),
    label: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.phone)],
);

export const segments = pgTable(
  "segments",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text().notNull(),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.name)],
);

export const channelSegments = pgTable(
  "channel_segments",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    segmentId: uuid()
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.segmentId] }), index().on(t.segmentId)],
);

// ── Links e rastreamento ────────────────────────────────────────────

export const trackedLinks = pgTable(
  "tracked_links",
  {
    id: id(),
    workspaceId: workspaceId(),
    slug: text().notNull().unique(),
    destinationUrl: text().notNull(),
    fallbackUrl: text(),
    active: boolean().notNull().default(true),
    expiresAt: timestamp({ withTimezone: true }),
    title: text(),
    /** origem: wa, ig, ads, bio, story... */
    source: text(),
    campaign: text(),
    channelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    // Ligações com entidades das próximas fases (FK adicionada quando as tabelas existirem)
    offerId: uuid(),
    postId: uuid(),
    creativeId: uuid(),
    subIds: jsonb().$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

export const inviteLinks = pgTable(
  "invite_links",
  {
    id: id(),
    workspaceId: workspaceId(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    segmentId: uuid()
      .notNull()
      .references(() => segments.id, { onDelete: "restrict" }),
    strategy: text({ enum: ["fill_first", "round_robin"] })
      .notNull()
      .default("fill_first"),
    /** Vagas mantidas livres em cada grupo antes de considerá-lo cheio */
    reserve: integer().notNull().default(10),
    fallbackUrl: text(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

/** Cliques em links rastreados e convites. Volume alto: particionar por mês quando crescer. */
/** Vitrine pública do workspace (/@slug): marca, botões de grupo e ofertas do dia. */
export const storefronts = pgTable("storefronts", {
  id: id(),
  workspaceId: uuid()
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  slug: text().notNull().unique(),
  title: text().notNull(),
  tagline: text(),
  avatarUrl: text(),
  /** Convites rotativos exibidos como botões, na ordem */
  inviteLinkIds: jsonb().$type<string[]>().notNull().default([]),
  /** Personalização (cores, capa, botões, links, destaques, seções): ver StorefrontDesign */
  design: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  active: boolean().notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Conteúdo para redes (spec 18): vídeo vertical ou carrossel montado a partir de ofertas. */
export const contents = pgTable(
  "contents",
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: text({ enum: ["video", "carousel"] }).notNull(),
    status: text({
      enum: ["queued", "rendering", "pending_review", "ready", "rejected", "failed"],
    })
      .notNull()
      .default("queued"),
    title: text().notNull(),
    hook: text().notNull(),
    subhook: text(),
    outro: text().notNull(),
    caption: text().notNull(),
    hashtags: text().array().notNull().default([]),
    offerIds: jsonb().$type<string[]>().notNull().default([]),
    /** Vídeo (1 arquivo) ou imagens do carrossel, na ordem */
    assetIds: jsonb().$type<string[]>().notNull().default([]),
    coverAssetId: uuid(),
    seconds: real(),
    error: text(),
    attempts: integer().notNull().default(0),
    /** Revisão do vídeo enviado pelo agente (aprovar/recusar no painel) */
    reviewNote: text(),
    reviewedAt: timestamp({ withTimezone: true }),
    reviewedBy: text(),
    /** Preço de cada oferta quando o conteúdo foi feito (para avisar se mudou) */
    offerPrices: jsonb().$type<Record<string, number>>().notNull().default({}),
    /** Redes onde já foi postado (tiktok, instagram, youtube, pinterest...) */
    postedTo: jsonb().$type<string[]>().notNull().default([]),
    postedAt: timestamp({ withTimezone: true }),
    createdBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt), index().on(t.status)],
);

export const clicks = pgTable(
  "clicks",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** page_view = visita na vitrine; page_offer = clique numa oferta da vitrine */
    kind: text({ enum: ["link", "invite", "page_view", "page_offer"] }).notNull(),
    trackedLinkId: uuid().references(() => trackedLinks.id, { onDelete: "cascade" }),
    inviteLinkId: uuid().references(() => inviteLinks.id, { onDelete: "cascade" }),
    channelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ipHash: text(),
    userAgent: text(),
    referrer: text(),
    params: jsonb().$type<Record<string, string>>(),
    isBot: boolean().notNull().default(false),
    outcome: text({ enum: ["redirect", "fallback", "gone", "full"] }).notNull(),
  },
  (t) => [
    index().on(t.workspaceId, t.ts),
    index().on(t.trackedLinkId, t.ts),
    index().on(t.inviteLinkId, t.ts),
  ],
);

// ── Eventos (outbox) ────────────────────────────────────────────────

export const events = pgTable(
  "events",
  {
    id: id(),
    workspaceId: workspaceId(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

// ── Afiliados e ofertas (Fase 2) ────────────────────────────────────

const money = () => numeric({ precision: 12, scale: 2, mode: "number" });
const platform = () => text({ enum: ["shopee", "amazon", "mercadolivre", "magalu"] }).notNull();

export const affiliateAccounts = pgTable(
  "affiliate_accounts",
  {
    id: id(),
    workspaceId: workspaceId(),
    platform: platform(),
    label: text().notNull(),
    /** live = API real; fake = catálogo simulado; feed = feed de produtos (CSV) da loja */
    mode: text({ enum: ["live", "fake", "feed"] })
      .notNull()
      .default("live"),
    /** JSON das credenciais cifrado com AES-256-GCM */
    credentials: text(),
    status: text({ enum: ["active", "error", "disabled"] })
      .notNull()
      .default("active"),
    lastError: text(),
    /** Modo feed: última importação concluída (vazio = importar na próxima rodada do worker) */
    feedSyncedAt: timestamp({ withTimezone: true }),
    feedInfo: jsonb().$type<FeedInfo>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

export type OfferPriceDetails = {
  pix_price: number | null;
  installments: { count: number; value: number; interest_free: boolean } | null;
  /** Corrigido por pessoa ou agente (ex.: Pix lido na página da Shopee): vale enquanto o preço não mudar */
  manual?: boolean;
};

export type OfferCopy = {
  headline: string;
  body: string;
  extra: string | null;
  /** Quem escreveu: IA (Gemini, pelo painel), agente (MCP) ou humano */
  source: "ai" | "agent" | "human";
  updated_at: string;
};

export type FeedInfo = {
  /** Produtos guardados (com desconto) e lidos no total */
  items: number;
  read: number;
  files: number;
  seconds: number;
  error?: string | null;
  /** Importação em andamento desde */
  running_since?: string | null;
  /** Andamento da importação atual (arquivo n de N, bytes lidos do arquivo atual) */
  progress?: {
    file: number;
    files: number;
    bytes: number;
    total: number | null;
    /** Última atualização (sinal de vida: parada há minutos = importação interrompida) */
    at?: string;
  } | null;
};

/**
 * Catálogo local do feed de produtos (só itens em desconto). A busca e a validação das contas
 * em modo feed consultam esta tabela; o worker a recria todo dia.
 */
export const feedItems = pgTable(
  "feed_items",
  {
    accountId: uuid()
      .notNull()
      .references(() => affiliateAccounts.id, { onDelete: "cascade" }),
    externalId: text().notNull(),
    title: text().notNull(),
    url: text().notNull(),
    imageUrls: text().array().notNull().default([]),
    price: money().notNull(),
    originalPrice: money(),
    discountPct: integer(),
    rating: numeric({ precision: 3, scale: 2, mode: "number" }),
    likes: integer(),
    shopName: text(),
    categoryIds: text().array().notNull().default([]),
    categoryName: text(),
    /** Categoria principal (nome); o id é categoryIds[1] */
    topCategory: text(),
    seenAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.externalId] }),
    index().on(t.accountId, t.discountPct),
  ],
);

export const products = pgTable(
  "products",
  {
    id: id(),
    workspaceId: workspaceId(),
    platform: platform(),
    externalId: text().notNull(),
    title: text().notNull(),
    url: text().notNull(),
    imageUrls: text().array().notNull().default([]),
    shopName: text(),
    categoryIds: text().array().notNull().default([]),
    categoryName: text(),
    rating: numeric({ precision: 3, scale: 2, mode: "number" }),
    soldCount: integer(),
    lastPrice: money(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.platform, t.externalId)],
);

/** Série de preços observados: base do histórico e da detecção de desconto falso. */
export const pricePoints = pgTable(
  "price_points",
  {
    id: id(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    price: money().notNull(),
    originalPrice: money(),
    source: text({ enum: ["search", "lookup", "validation"] }).notNull(),
    capturedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.productId, t.capturedAt)],
);

export const offers = pgTable(
  "offers",
  {
    id: id(),
    workspaceId: workspaceId(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Vazio = oferta criada a partir de um link colado (sem API da loja; o link colado é o destino). */
    affiliateAccountId: uuid().references(() => affiliateAccounts.id, { onDelete: "cascade" }),
    status: text({ enum: ["new", "approved", "rejected", "expired"] })
      .notNull()
      .default("new"),
    price: money().notNull(),
    originalPrice: money(),
    discountPct: integer(),
    couponCode: text(),
    couponDescription: text(),
    commissionRate: numeric({ precision: 6, scale: 4, mode: "number" }),
    commissionValue: money(),
    affiliateUrl: text(),
    score: integer().notNull().default(0),
    qualityFlags: text().array().notNull().default([]),
    notes: text(),
    rejectReason: text(),
    validUntil: timestamp({ withTimezone: true }),
    lastValidatedAt: timestamp({ withTimezone: true }),
    /** Busca salva que encontrou a oferta (curadoria automática) */
    savedSearchId: uuid(),
    /** Condições de pagamento lidas da loja (preço no Pix, parcelamento) */
    priceDetails: jsonb().$type<OfferPriceDetails>(),
    /** Texto de divulgação próprio da oferta (IA no painel, agente pelo MCP ou humano) */
    copy: jsonb().$type<OfferCopy>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId, t.status, t.createdAt), index().on(t.productId)],
);

export const offerValidations = pgTable(
  "offer_validations",
  {
    id: id(),
    offerId: uuid()
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    ok: boolean().notNull(),
    priceWas: money().notNull(),
    priceNow: money(),
    available: boolean(),
    reason: text(),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.offerId, t.checkedAt)],
);

export const savedSearches = pgTable(
  "saved_searches",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text().notNull(),
    query: jsonb().$type<Record<string, unknown>>().notNull(),
    intervalMinutes: integer().notNull().default(60),
    /** Ofertas com score >= este valor entram na curadoria */
    minScore: integer().notNull().default(60),
    active: boolean().notNull().default(true),
    lastRunAt: timestamp({ withTimezone: true }),
    lastResult: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

// ── WhatsApp e publicação (Fase 3) ──────────────────────────────────

export const messagingAccounts = pgTable(
  "messaging_accounts",
  {
    id: id(),
    workspaceId: workspaceId(),
    provider: text({ enum: ["evolution_go", "fake"] }).notNull(),
    label: text().notNull(),
    /** id da instância no provedor */
    instanceId: text().notNull(),
    /** token da instância, cifrado */
    token: text().notNull(),
    phone: text(),
    /** JID do próprio número depois de conectado */
    ownJid: text(),
    status: text({ enum: ["pending", "connected", "disconnected", "logged_out"] })
      .notNull()
      .default("pending"),
    lastEventAt: timestamp({ withTimezone: true }),
    lastError: text(),
    connectedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId), uniqueIndex().on(t.provider, t.instanceId)],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text().notNull(),
    /** Texto com variáveis {{titulo}} etc. Variações separadas por uma linha com --- */
    body: text().notNull(),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.name)],
);

export const automationRules = pgTable(
  "automation_rules",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
    /** { min_score, min_discount, keywords[], platforms[] } */
    filters: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    segmentIds: uuid().array().notNull(),
    /** Janelas HH:MM-HH:MM no fuso do workspace; vazio = usa as preferências */
    windows: text().array().notNull().default([]),
    maxPerDay: integer().notNull().default(10),
    minIntervalMinutes: integer().notNull().default(30),
    templateId: uuid().references(() => messageTemplates.id, { onDelete: "set null" }),
    creativeTemplate: text(),
    lastRunAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const posts = pgTable(
  "posts",
  {
    id: id(),
    workspaceId: workspaceId(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    offerId: uuid().references(() => offers.id, { onDelete: "set null" }),
    /** Texto livre (posts sem oferta) */
    customText: text(),
    templateId: uuid().references(() => messageTemplates.id, { onDelete: "set null" }),
    withImage: boolean().notNull().default(true),
    /** Criativo pronto a usar como imagem */
    creativeId: uuid().references(() => creatives.id, { onDelete: "set null" }),
    /** Template para gerar o criativo na hora do envio (preço sempre atualizado) */
    creativeTemplate: text(),
    ruleId: uuid().references(() => automationRules.id, { onDelete: "set null" }),
    status: text({
      enum: ["scheduled", "sending", "sent", "failed", "skipped", "canceled", "deleted"],
    })
      .notNull()
      .default("scheduled"),
    scheduledAt: timestamp({ withTimezone: true }).notNull(),
    sentAt: timestamp({ withTimezone: true }),
    /**
     * Momento em que a chamada de envio ao provedor começou (limpo quando a tentativa falha sem
     * enviar). Se o processo cair com isso preenchido, a mensagem pode ter saído: não reenvia.
     */
    sendStartedAt: timestamp({ withTimezone: true }),
    /** Mensagem final enviada */
    body: text(),
    trackedLinkId: uuid().references(() => trackedLinks.id, { onDelete: "set null" }),
    externalMessageId: text(),
    attempts: integer().notNull().default(0),
    error: text(),
    createdBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.status, t.scheduledAt),
    index().on(t.channelId, t.scheduledAt),
    index().on(t.workspaceId, t.createdAt),
  ],
);

export const channelStatsDaily = pgTable(
  "channel_stats_daily",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    date: text().notNull(),
    joins: integer().notNull().default(0),
    leaves: integer().notNull().default(0),
    messagesSent: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.date] })],
);

// ── Criativos (Fase 4) ──────────────────────────────────────────────

export const assets = pgTable(
  "assets",
  {
    id: id(),
    workspaceId: workspaceId(),
    storageKey: text().notNull().unique(),
    mime: text().notNull(),
    size: integer().notNull(),
    width: integer(),
    height: integer(),
    checksum: text().notNull(),
    source: text({ enum: ["upload", "render", "import"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const creatives = pgTable(
  "creatives",
  {
    id: id(),
    workspaceId: workspaceId(),
    offerId: uuid().references(() => offers.id, { onDelete: "set null" }),
    title: text().notNull(),
    origin: text({ enum: ["template", "upload", "import"] }).notNull(),
    templateKey: text(),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Preço impresso no criativo (para saber se ficou desatualizado) */
    renderedPrice: money(),
    status: text({ enum: ["ready", "archived"] })
      .notNull()
      .default("ready"),
    tags: text().array().notNull().default([]),
    aiGenerated: boolean().notNull().default(false),
    createdBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt), index().on(t.offerId)],
);

export const creativeVariants = pgTable(
  "creative_variants",
  {
    id: id(),
    creativeId: uuid()
      .notNull()
      .references(() => creatives.id, { onDelete: "cascade" }),
    format: text().notNull(),
    assetId: uuid()
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    previewAssetId: uuid().references(() => assets.id, { onDelete: "set null" }),
    validation: jsonb()
      .$type<{ code: string; message: string; hint: string }[]>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.creativeId, t.format)],
);

export const uploads = pgTable(
  "uploads",
  {
    id: id(),
    workspaceId: workspaceId(),
    filename: text().notNull(),
    mime: text().notNull(),
    maxBytes: integer().notNull(),
    status: text({ enum: ["pending", "uploaded", "completed"] })
      .notNull()
      .default("pending"),
    assetId: uuid().references(() => assets.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdBy: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

// ── Métricas e alertas (Fase 5) ─────────────────────────────────────

/** Cliques consolidados por hora (UTC). Recalculado pelo worker para as últimas horas. */
export const clickStatsHourly = pgTable(
  "click_stats_hourly",
  {
    id: id(),
    workspaceId: workspaceId(),
    hour: timestamp({ withTimezone: true }).notNull(),
    kind: text({ enum: ["link", "invite", "page_view", "page_offer"] }).notNull(),
    channelId: uuid(),
    offerId: uuid(),
    postId: uuid(),
    trackedLinkId: uuid(),
    inviteLinkId: uuid(),
    human: integer().notNull().default(0),
    bot: integer().notNull().default(0),
  },
  (t) => [index().on(t.workspaceId, t.hour), index().on(t.hour), index().on(t.postId)],
);

/** Alertas operacionais (número caiu, fila parada, envios falhando). */
export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: text({
      enum: [
        "messaging_down",
        "queue_stalled",
        "posts_failing",
        "group_admin_lost",
        "group_unavailable",
      ],
    }).notNull(),
    /** Objeto afetado (ex.: id do número); vazio quando é do workspace todo */
    subject: text().notNull().default(""),
    severity: text({ enum: ["warning", "critical"] }).notNull(),
    status: text({ enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    message: text().notNull(),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
    notifiedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.workspaceId, t.status),
    uniqueIndex().on(t.workspaceId, t.kind, t.subject).where(sql`status = 'open'`),
  ],
);
