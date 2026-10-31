// Alertas operacionais: verificação periódica (worker), consulta e notificação por webhook.
import {
  type Alert,
  ListAlertsQuery,
  Preferences,
  type PublicStatus,
  type SystemStatus,
} from "@ofertas/contracts";
import { alerts, channels, messagingAccounts, posts, workspaces } from "@ofertas/db";
import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now } from "./context";

const MINUTE = 60_000;
export const OVERDUE_MS = 10 * MINUTE;
export const WORKER_HEARTBEAT_KEY = "worker:heartbeat";
/** Sem sinal do worker por mais que isso = parado. */
export const WORKER_STALE_MS = 3 * MINUTE;
const FAILING_THRESHOLD = 3;

type AlertRow = typeof alerts.$inferSelect;
type Finding = Pick<AlertRow, "workspaceId" | "kind" | "subject" | "severity" | "message"> & {
  details: Record<string, unknown>;
};

/** Payload enviado ao webhook de alertas (formato aceito por Slack, Discord e ntfy). */
export type AlertNotification = {
  text: string;
  content: string;
  alert: { kind: string; severity: string; status: "open" | "resolved"; message: string };
};
export type AlertNotifier = (url: string, payload: AlertNotification) => Promise<void>;

/** Worker registra que está vivo a cada rodada. */
export async function recordWorkerHeartbeat(deps: Pick<Deps, "cache" | "now">) {
  await deps.cache.set(WORKER_HEARTBEAT_KEY, now(deps).toISOString(), 24 * 3600);
}

async function workerHealth(deps: Pick<Deps, "cache" | "now">) {
  const last = await deps.cache.get(WORKER_HEARTBEAT_KEY);
  const ok = Boolean(last && now(deps).getTime() - new Date(last).getTime() < WORKER_STALE_MS);
  return { ok, last_seen_at: last };
}

const keyOf = (a: Pick<AlertRow, "workspaceId" | "kind" | "subject">) =>
  `${a.workspaceId}|${a.kind}|${a.subject}`;

async function collectFindings(deps: Deps): Promise<Finding[]> {
  const t = now(deps);
  const findings: Finding[] = [];

  // Número caiu: já esteve conectado e agora não está.
  const down = await deps.db
    .select({
      id: messagingAccounts.id,
      workspaceId: messagingAccounts.workspaceId,
      label: messagingAccounts.label,
      status: messagingAccounts.status,
      lastError: messagingAccounts.lastError,
      channels: sql<number>`(select count(*)::int from ${channels} where ${channels.messagingAccountId} = ${messagingAccounts.id} and ${channels.status} = 'active')`,
    })
    .from(messagingAccounts)
    .where(
      or(
        inArray(messagingAccounts.status, ["disconnected", "logged_out"]),
        and(eq(messagingAccounts.status, "pending"), isNotNull(messagingAccounts.connectedAt)),
      ),
    );
  for (const a of down) {
    findings.push({
      workspaceId: a.workspaceId,
      kind: "messaging_down",
      subject: a.id,
      severity: "critical",
      message:
        a.status === "logged_out"
          ? `WhatsApp "${a.label}" foi desconectado no celular. Conecte de novo pelo QR code em WhatsApp.`
          : `WhatsApp "${a.label}" está desconectado. Os envios de ${a.channels} grupo(s) estão parados.`,
      details: {
        account_id: a.id,
        status: a.status,
        last_error: a.lastError,
        channels: a.channels,
      },
    });
  }

  // Fila parada: posts vencidos que ninguém pegou, ou presos em "enviando".
  const overdueAt = new Date(t.getTime() - OVERDUE_MS);
  const stalled = await deps.db
    .select({
      workspaceId: posts.workspaceId,
      n: sql<number>`count(*)::int`,
      oldest: sql<string>`min(${posts.scheduledAt})`,
    })
    .from(posts)
    .where(
      or(
        and(eq(posts.status, "scheduled"), lt(posts.scheduledAt, overdueAt)),
        and(eq(posts.status, "sending"), lt(posts.updatedAt, overdueAt)),
      ),
    )
    .groupBy(posts.workspaceId);
  for (const s of stalled) {
    findings.push({
      workspaceId: s.workspaceId,
      kind: "queue_stalled",
      subject: "",
      severity: "critical",
      message: `${s.n} publicação(ões) atrasada(s) há mais de 10 min: a fila de envio parou.`,
      details: { overdue: s.n, oldest_scheduled_at: new Date(s.oldest).toISOString() },
    });
  }

  // Envios falhando: vários erros na última hora.
  const failing = await deps.db
    .select({ workspaceId: posts.workspaceId, n: sql<number>`count(*)::int` })
    .from(posts)
    .where(
      and(eq(posts.status, "failed"), gte(posts.updatedAt, new Date(t.getTime() - 60 * MINUTE))),
    )
    .groupBy(posts.workspaceId)
    .having(sql`count(*) >= ${FAILING_THRESHOLD}`);
  for (const f of failing) {
    findings.push({
      workspaceId: f.workspaceId,
      kind: "posts_failing",
      subject: "",
      severity: "warning",
      message: `${f.n} envios falharam na última hora. Veja o motivo em Publicações.`,
      details: { failed_last_hour: f.n },
    });
  }
  return findings;
}

/**
 * Abre, atualiza e resolve alertas conforme o estado atual. Notifica (webhook das preferências)
 * quando um alerta abre e quando é resolvido.
 */
export async function runHealthChecks(deps: Deps) {
  const t = now(deps);
  const findings = await collectFindings(deps);
  const open = await deps.db.select().from(alerts).where(eq(alerts.status, "open"));
  const openByKey = new Map(open.map((a) => [keyOf(a), a]));
  const seen = new Set<string>();
  const changes: { row: AlertRow; status: "open" | "resolved" }[] = [];

  for (const f of findings) {
    const k = keyOf(f);
    seen.add(k);
    const existing = openByKey.get(k);
    if (existing) {
      await deps.db
        .update(alerts)
        .set({ lastSeenAt: t, message: f.message, details: f.details, severity: f.severity })
        .where(eq(alerts.id, existing.id));
    } else {
      const [row] = await deps.db
        .insert(alerts)
        .values({ ...f, openedAt: t, lastSeenAt: t })
        .onConflictDoNothing()
        .returning();
      if (row) changes.push({ row, status: "open" });
    }
  }
  for (const a of open) {
    if (seen.has(keyOf(a))) continue;
    const [row] = await deps.db
      .update(alerts)
      .set({ status: "resolved", resolvedAt: t })
      .where(and(eq(alerts.id, a.id), eq(alerts.status, "open")))
      .returning();
    if (row) changes.push({ row, status: "resolved" });
  }

  if (deps.notify && changes.length) await notifyChanges(deps, deps.notify, changes);
  return {
    open: findings.length,
    opened: changes.filter((c) => c.status === "open").length,
    resolved: changes.filter((c) => c.status === "resolved").length,
  };
}

async function notifyChanges(
  deps: Deps,
  notify: AlertNotifier,
  changes: { row: AlertRow; status: "open" | "resolved" }[],
) {
  const wsIds = [...new Set(changes.map((c) => c.row.workspaceId))];
  const wsRows = await deps.db
    .select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings })
    .from(workspaces)
    .where(inArray(workspaces.id, wsIds));
  const byId = new Map(wsRows.map((w) => [w.id, w]));
  for (const { row, status } of changes) {
    const ws = byId.get(row.workspaceId);
    const url = Preferences.safeParse(ws?.settings.preferences ?? {}).data?.alert_webhook_url;
    if (!ws || !url) continue;
    const icon =
      status === "resolved"
        ? "[resolvido]"
        : row.severity === "critical"
          ? "[CRÍTICO]"
          : "[atenção]";
    const text = `${icon} ${ws.name}: ${status === "resolved" ? `normalizado: ${row.message}` : row.message}`;
    try {
      await notify(url, {
        text,
        content: text,
        alert: { kind: row.kind, severity: row.severity, status, message: row.message },
      });
      await deps.db
        .update(alerts)
        .set({ notifiedAt: now(deps) })
        .where(eq(alerts.id, row.id));
    } catch (err) {
      console.error(JSON.stringify({ msg: "falha ao notificar alerta", error: String(err) }));
    }
  }
}

const toAlert = (a: AlertRow): Alert => ({
  id: a.id,
  kind: a.kind,
  subject: a.subject,
  severity: a.severity,
  status: a.status,
  message: a.message,
  details: a.details,
  opened_at: a.openedAt.toISOString(),
  last_seen_at: a.lastSeenAt.toISOString(),
  resolved_at: a.resolvedAt?.toISOString() ?? null,
});

export async function listAlerts(ctx: Ctx, raw: ListAlertsQuery = {}): Promise<Alert[]> {
  requireScope(ctx.actor, "metrics:read");
  const q = ListAlertsQuery.parse(raw);
  const rows = await ctx.db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.workspaceId, ctx.actor.workspaceId),
        q.status === "all" ? undefined : eq(alerts.status, q.status),
      ),
    )
    .orderBy(desc(alerts.openedAt))
    .limit(q.limit);
  return rows.map(toAlert);
}

/** Saúde da operação: worker, fila, números e alertas abertos. */
export async function getSystemStatus(ctx: Ctx): Promise<SystemStatus> {
  requireScope(ctx.actor, "metrics:read");
  const wsId = ctx.actor.workspaceId;
  const t = now(ctx);
  const [worker, [queue], accounts, open] = await Promise.all([
    workerHealth(ctx),
    ctx.db
      .select({
        scheduled: sql<number>`count(*) filter (where ${posts.status} = 'scheduled')::int`,
        overdue: sql<number>`count(*) filter (where ${posts.status} = 'scheduled' and ${posts.scheduledAt} < ${new Date(t.getTime() - OVERDUE_MS).toISOString()}::timestamptz)::int`,
        failed: sql<number>`count(*) filter (where ${posts.status} = 'failed' and ${posts.updatedAt} >= ${new Date(t.getTime() - 60 * MINUTE).toISOString()}::timestamptz)::int`,
      })
      .from(posts)
      .where(eq(posts.workspaceId, wsId)),
    ctx.db
      .select({
        id: messagingAccounts.id,
        label: messagingAccounts.label,
        status: messagingAccounts.status,
      })
      .from(messagingAccounts)
      .where(eq(messagingAccounts.workspaceId, wsId)),
    listAlerts(ctx, { status: "open" }),
  ]);
  return {
    ok: worker.ok && !open.some((a) => a.severity === "critical"),
    worker,
    queue: {
      scheduled: queue?.scheduled ?? 0,
      overdue: queue?.overdue ?? 0,
      failed_last_hour: queue?.failed ?? 0,
    },
    messaging: accounts,
    alerts: open,
  };
}

/** Status público para monitores externos: banco e worker. Não expõe dados do negócio. */
export async function getPublicStatus(deps: Deps): Promise<PublicStatus> {
  let db = true;
  try {
    await deps.db.execute(sql`select 1`);
  } catch {
    db = false;
  }
  const worker = await workerHealth(deps).catch(() => ({ ok: false, last_seen_at: null }));
  return { ok: db && worker.ok, db, worker: worker.ok, worker_last_seen_at: worker.last_seen_at };
}

/** Alertas que o overview mostra: abertos + worker parado. */
export async function overviewAlerts(ctx: Ctx) {
  const out: { level: "warning" | "critical"; message: string }[] = [];
  const worker = await workerHealth(ctx);
  if (!worker.ok)
    out.push({
      level: "critical",
      message: worker.last_seen_at
        ? "O worker parou: buscas, regras e envios não estão rodando."
        : "O worker não está rodando: inicie-o para buscar ofertas e enviar publicações.",
    });
  const open = await ctx.db
    .select({ severity: alerts.severity, message: alerts.message })
    .from(alerts)
    .where(and(eq(alerts.workspaceId, ctx.actor.workspaceId), eq(alerts.status, "open")))
    .orderBy(desc(alerts.openedAt));
  for (const a of open) out.push({ level: a.severity, message: a.message });
  return out;
}
