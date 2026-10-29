import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
