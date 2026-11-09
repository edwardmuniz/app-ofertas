// Grupos do Facebook pela extensão do Chrome (spec 19), modo semiautomático. O servidor decide
// (fila, limites, texto, link, imagem) e entrega o post pronto; a extensão prepara o post na
// interface do Facebook e a PESSOA revisa e publica, devolvendo depois o link do post. O servidor
// nunca publica no Facebook nem lê nada interno dele.
import {
  AddFacebookGroupInput,
  AnalyzeFacebookGroupInput,
  BrowserJobResultInput,
  ClaimBrowserJobInput,
  type FacebookAccount,
  FacebookHeartbeatInput,
  SetGroupPostingPolicyInput,
} from "@ofertas/contracts";
import {
  browserJobs,
  channelStatsDaily,
  channels,
  type DbOrTx,
  facebookAccounts,
  posts,
} from "@ofertas/db";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { requireHuman, requireScope } from "./authz";
import {
  addSegments,
  assertSegmentsExist,
  getChannelRow,
  segmentIdsFor,
  toChannel,
} from "./channels";
import { type Ctx, type Deps, now, systemActor } from "./context";
import { withOwnMedia } from "./creatives";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { classifyGroupPolicy, policyAllowsPosting } from "./facebook-policy";
import { getLimit } from "./limits";
import { type MutationOptions, runMutation } from "./mutation";
import { localDate, localMidnight } from "./tz";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Sem contato da extensão por mais que isso = desligada. */
export const FACEBOOK_ONLINE_MS = 10 * MINUTE;
/** Prazo para a extensão publicar um trabalho que pegou. */
const LEASE_MS = 5 * MINUTE;
/** Trabalho que ninguém pegou nesse prazo é cancelado (Chrome fechado). */
const QUEUED_TTL_MS = 2 * HOUR;
/** Pausa depois de um aviso de bloqueio do Facebook. */
export const FACEBOOK_BLOCK_PAUSE_MS = 24 * HOUR;
const MAX_ATTEMPTS = 3;
/** Tentativas enquanto a extensão está desligada (~1 h a cada 5 min). */
const MAX_WAIT_ATTEMPTS = 12;

const MAYBE_POSTED =
  "A extensão pegou o post e não respondeu: ele pode ter saído. Confira no grupo antes de agendar de novo.";

type AccountRow = typeof facebookAccounts.$inferSelect;
type PostRow = typeof posts.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;

const isOnline = (a: Pick<AccountRow, "lastSeenAt">, at: Date) =>
  Boolean(a.lastSeenAt && at.getTime() - a.lastSeenAt.getTime() < FACEBOOK_ONLINE_MS);

async function toAccounts(db: DbOrTx, rows: AccountRow[], at: Date, tz: string) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const groups = await db
    .select({ id: channels.facebookAccountId, n: sql<number>`count(*)::int` })
    .from(channels)
    .where(and(inArray(channels.facebookAccountId, ids), sql`${channels.status} <> 'archived'`))
    .groupBy(channels.facebookAccountId);
  const dayStart = localMidnight(at, tz);
  const jobs = await db
    .select({
      id: browserJobs.facebookAccountId,
      today: sql<number>`count(*) filter (where ${browserJobs.status} = 'done' and ${browserJobs.finishedAt} >= ${dayStart.toISOString()})::int`,
      queued: sql<number>`count(*) filter (where ${browserJobs.status} in ('queued', 'claimed'))::int`,
    })
    .from(browserJobs)
    .where(inArray(browserJobs.facebookAccountId, ids))
    .groupBy(browserJobs.facebookAccountId);
  return rows.map(
    (r): FacebookAccount => ({
      id: r.id,
      fb_user_id: r.fbUserId,
      name: r.name,
      online: isOnline(r, at),
      last_seen_at: r.lastSeenAt?.toISOString() ?? null,
      paused_until: r.pausedUntil && r.pausedUntil > at ? r.pausedUntil.toISOString() : null,
      pause_reason: r.pausedUntil && r.pausedUntil > at ? r.pauseReason : null,
      group_count: groups.find((g) => g.id === r.id)?.n ?? 0,
      posts_today: jobs.find((j) => j.id === r.id)?.today ?? 0,
      queued_jobs: jobs.find((j) => j.id === r.id)?.queued ?? 0,
      created_at: r.createdAt.toISOString(),
    }),
  );
}

async function workspaceTz(db: DbOrTx, workspaceId: string) {
  const r = await db.execute<{ tz: string }>(
    sql`select timezone as tz from workspaces where id = ${workspaceId}`,
  );
  return [...r][0]?.tz ?? "America/Sao_Paulo";
}

async function accountByFbId(db: DbOrTx, workspaceId: string, fbUserId: string) {
  const [row] = await db
    .select()
    .from(facebookAccounts)
    .where(
      and(eq(facebookAccounts.workspaceId, workspaceId), eq(facebookAccounts.fbUserId, fbUserId)),
    );
  if (!row) {
    throw new AppError("NOT_FOUND", "Perfil do Facebook não registrado.", {
      hint: "Abra o Facebook com a extensão ligada: ela registra o perfil sozinha.",
    });
  }
  return row;
}

// ── Painel, API e MCP ───────────────────────────────────────────

export async function listFacebookAccounts(ctx: Ctx): Promise<FacebookAccount[]> {
  requireScope(ctx.actor, "channels:read");
  const rows = await ctx.db
    .select()
    .from(facebookAccounts)
    .where(eq(facebookAccounts.workspaceId, ctx.actor.workspaceId))
    .orderBy(asc(facebookAccounts.createdAt));
  return toAccounts(ctx.db, rows, now(ctx), await workspaceTz(ctx.db, ctx.actor.workspaceId));
}

/** Tira a pausa do perfil (depois de um bloqueio). Só pessoas: a pausa protege a conta. */
export async function resumeFacebookAccount(
  ctx: Ctx,
  accountId: string,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Religar o perfil do Facebook");
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "facebook.resume_account",
    scope: "channels:write",
    input: { id: accountId },
    opts,
    target: (i) => ({ type: "facebook_account", id: i.id }),
    preview: async (c, i) => {
      const [row] = await c.db
        .select()
        .from(facebookAccounts)
        .where(and(eq(facebookAccounts.id, i.id), eq(facebookAccounts.workspaceId, wsId)));
      if (!row) throw new AppError("NOT_FOUND", "Perfil do Facebook não encontrado.");
      return { paused_until: row.pausedUntil?.toISOString() ?? null, reason: row.pauseReason };
    },
    execute: async (tx, i) => {
      await tx.db
        .update(facebookAccounts)
        .set({ pausedUntil: null, pauseReason: null })
        .where(eq(facebookAccounts.id, i.id));
      return { resumed: true as const };
    },
  });
}

// ── Extensão ────────────────────────────────────────────────────

/**
 * Contato da extensão (a cada minuto): registra o perfil na primeira vez e marca online.
 */
export async function facebookHeartbeat(ctx: Ctx, raw: FacebookHeartbeatInput) {
  requireScope(ctx.actor, "facebook:execute");
  const input = FacebookHeartbeatInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  const at = now(ctx);
  const [existing] = await ctx.db
    .select()
    .from(facebookAccounts)
    .where(
      and(eq(facebookAccounts.workspaceId, wsId), eq(facebookAccounts.fbUserId, input.fb_user_id)),
    );
  let row: AccountRow;
  if (existing) {
    const [u] = await ctx.db
      .update(facebookAccounts)
      .set({ lastSeenAt: at, ...(input.name ? { name: input.name } : {}) })
      .where(eq(facebookAccounts.id, existing.id))
      .returning();
    if (!u) throw new Error("perfil");
    row = u;
  } else {
    const [c] = await ctx.db
      .insert(facebookAccounts)
      .values({
        workspaceId: wsId,
        fbUserId: input.fb_user_id,
        name: input.name ?? null,
        lastSeenAt: at,
      })
      .onConflictDoUpdate({
        target: [facebookAccounts.workspaceId, facebookAccounts.fbUserId],
        set: { lastSeenAt: at },
      })
      .returning();
    if (!c) throw new Error("perfil");
    row = c;
    await recordAudit(ctx.db, ctx.actor, {
      action: "facebook.register_account",
      target: { type: "facebook_account", id: row.id },
      params: { fb_user_id: input.fb_user_id, name: input.name ?? null },
      result: "ok",
    });
  }
  const paused = row.pausedUntil && row.pausedUntil > at;
  return {
    account_id: row.id,
    paused_until: paused ? (row.pausedUntil?.toISOString() ?? null) : null,
    pause_reason: paused ? row.pauseReason : null,
  };
}

/** Grupo do Facebook entra na plataforma (pela extensão, na página do grupo). */
export async function addFacebookGroup(
  ctx: Ctx,
  raw: AddFacebookGroupInput,
  opts: MutationOptions = {},
) {
  const input = AddFacebookGroupInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "facebook.add_group",
    scope: "facebook:execute",
    input,
    opts,
    preview: async (c, i) => {
      const account = await accountByFbId(c.db, wsId, i.fb_user_id);
      if (i.segment_ids) await assertSegmentsExist(c.db, wsId, i.segment_ids);
      const [existing] = await c.db
        .select({ id: channels.id, type: channels.type, status: channels.status })
        .from(channels)
        .where(and(eq(channels.workspaceId, wsId), eq(channels.externalId, i.group_id)));
      if (existing && existing.type !== "fb_group") {
        throw new AppError("CONFLICT", "Já existe um canal com esse id.");
      }
      return {
        account_id: account.id,
        action: existing ? ("update" as const) : ("create" as const),
        channel_id: existing?.id ?? null,
        name: i.name,
      };
    },
    execute: async (tx, i, p) => {
      const values = {
        name: i.name,
        inviteUrl: i.url ?? `https://www.facebook.com/groups/${i.group_id}`,
        facebookAccountId: p.account_id,
        lastSyncedAt: now(ctx),
        ...(i.member_count !== undefined ? { memberCount: i.member_count } : {}),
      };
      const [row] = p.channel_id
        ? await tx.db
            .update(channels)
            .set({ ...values, status: "active" })
            .where(eq(channels.id, p.channel_id))
            .returning()
        : await tx.db
            .insert(channels)
            .values({
              ...values,
              workspaceId: wsId,
              type: "fb_group",
              externalId: i.group_id,
              memberLimit: 1_000_000,
            })
            .returning();
      if (!row) throw new Error("canal");
      if (i.segment_ids?.length) await addSegments(tx.db, [row.id], i.segment_ids);
      const segs = await segmentIdsFor(tx.db, [row.id]);
      return toChannel(row, segs.get(row.id) ?? []);
    },
  });
}

/**
 * A extensão analisa um grupo aberto: coleta o texto visível (regras, descrição e últimos posts)
 * e o servidor classifica se o grupo aceita divulgação. Importa (ou atualiza) o grupo com a
 * política detectada. Nenhuma leitura interna do Facebook: só o texto que a pessoa vê.
 */
export async function analyzeFacebookGroup(
  ctx: Ctx,
  raw: AnalyzeFacebookGroupInput,
  opts: MutationOptions = {},
) {
  const input = AnalyzeFacebookGroupInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "facebook.analyze_group",
    scope: "facebook:execute",
    input,
    opts,
    preview: async (c, i) => {
      const account = await accountByFbId(c.db, wsId, i.fb_user_id);
      const [existing] = await c.db
        .select({ id: channels.id, type: channels.type, policySource: channels.policySource })
        .from(channels)
        .where(and(eq(channels.workspaceId, wsId), eq(channels.externalId, i.group_id)));
      if (existing && existing.type !== "fb_group") {
        throw new AppError("CONFLICT", "Já existe um canal com esse id.");
      }
      const verdict = classifyGroupPolicy(i.collected);
      return {
        account_id: account.id,
        channel_id: existing?.id ?? null,
        // Correção humana não é sobrescrita pela detecção automática.
        keep_human: existing?.policySource === "human",
        verdict,
      };
    },
    execute: async (tx, i, p) => {
      const at = now(ctx);
      const policyFields = p.keep_human
        ? {}
        : {
            postingPolicy: p.verdict.policy,
            policySource: "detected" as const,
            policyNotes: p.verdict.notes,
            policyEvidence: p.verdict.evidence,
            policyCheckedAt: at,
          };
      const values = {
        name: i.name,
        inviteUrl: `https://www.facebook.com/groups/${i.group_id}`,
        facebookAccountId: p.account_id,
        lastSyncedAt: at,
        ...(i.member_count !== undefined ? { memberCount: i.member_count } : {}),
        ...policyFields,
      };
      const [row] = p.channel_id
        ? await tx.db.update(channels).set(values).where(eq(channels.id, p.channel_id)).returning()
        : await tx.db
            .insert(channels)
            .values({
              ...values,
              workspaceId: wsId,
              type: "fb_group",
              externalId: i.group_id,
              memberLimit: 1_000_000,
            })
            .returning();
      if (!row) throw new Error("canal");
      const segs = await segmentIdsFor(tx.db, [row.id]);
      return {
        channel: toChannel(row, segs.get(row.id) ?? []),
        policy: row.postingPolicy,
        evidence: row.policyEvidence ?? [],
        kept_human: p.keep_human,
      };
    },
  });
}

/** Pessoa ou agente corrige a política de um grupo do Facebook (não é trocada pela detecção). */
export async function setGroupPostingPolicy(
  ctx: Ctx,
  channelId: string,
  raw: SetGroupPostingPolicyInput,
  opts: MutationOptions = {},
) {
  const input = SetGroupPostingPolicyInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "facebook.set_group_policy",
    scope: "channels:write",
    input: { channel_id: channelId, ...input },
    opts,
    target: (i) => ({ type: "channel", id: i.channel_id }),
    preview: async (c, i) => {
      const row = await getChannelRow(c.db, wsId, i.channel_id);
      if (row.type !== "fb_group") throw new AppError("NOT_FOUND", "Não é um grupo do Facebook.");
      return { before: row.postingPolicy, after: i.posting_policy };
    },
    execute: async (tx, i) => {
      const source = ctx.actor.type === "user" ? "human" : "agent";
      const [row] = await tx.db
        .update(channels)
        .set({
          postingPolicy: i.posting_policy,
          policySource: source,
          policyNotes: i.notes ?? null,
          policyCheckedAt: now(ctx),
        })
        .where(and(eq(channels.id, i.channel_id), eq(channels.workspaceId, wsId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Canal não encontrado.");
      const segs = await segmentIdsFor(tx.db, [row.id]);
      return toChannel(row, segs.get(row.id) ?? []);
    },
  });
}

/** Próximo trabalho do perfil (null = nada a fazer ou perfil pausado). */
export async function claimBrowserJob(ctx: Ctx, raw: ClaimBrowserJobInput) {
  requireScope(ctx.actor, "facebook:execute");
  const input = ClaimBrowserJobInput.parse(raw);
  const account = await accountByFbId(ctx.db, ctx.actor.workspaceId, input.fb_user_id);
  const at = now(ctx);
  await ctx.db
    .update(facebookAccounts)
    .set({ lastSeenAt: at })
    .where(eq(facebookAccounts.id, account.id));
  if (account.pausedUntil && account.pausedUntil > at) return null;
  const lease = new Date(at.getTime() + LEASE_MS);
  const claimed = await ctx.db.execute<{ id: string }>(sql`
    update browser_jobs set status = 'claimed', claimed_at = ${at.toISOString()},
      lease_until = ${lease.toISOString()}, updated_at = now()
    where id = (
      select id from browser_jobs
      where facebook_account_id = ${account.id} and status = 'queued'
      order by created_at
      limit 1
      for update skip locked
    )
    returning id`);
  const id = [...claimed][0]?.id;
  if (!id) return null;
  const [job] = await ctx.db.select().from(browserJobs).where(eq(browserJobs.id, id));
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    group_id: job.payload.group_id,
    text: job.payload.text,
    has_image: Boolean(job.payload.image_source_url),
    lease_until: lease.toISOString(),
  };
}

async function claimedJob(ctx: Ctx, jobId: string) {
  const [job] = await ctx.db
    .select()
    .from(browserJobs)
    .where(and(eq(browserJobs.id, jobId), eq(browserJobs.workspaceId, ctx.actor.workspaceId)));
  if (!job) throw new AppError("NOT_FOUND", "Trabalho não encontrado.");
  if (job.status !== "claimed") {
    throw new AppError("CONFLICT", `Trabalho já está ${job.status}.`, {
      hint: "Pegue o próximo com /v1/facebook/jobs/claim.",
    });
  }
  return job;
}

/** Imagem do trabalho: a extensão baixa por aqui (com o token), nunca direto da loja. */
export async function browserJobImage(ctx: Ctx, jobId: string) {
  requireScope(ctx.actor, "facebook:execute");
  const job = await claimedJob(ctx, jobId);
  const url = job.payload.image_source_url;
  if (!url) throw new AppError("NOT_FOUND", "Este trabalho não tem imagem.");
  const media = await withOwnMedia(ctx)(url);
  return { data: media.data, contentType: media.contentType };
}

/** Resultado do trabalho: grava o post como enviado ou trata o erro (bloqueio pausa o perfil). */
export async function completeBrowserJob(ctx: Ctx, jobId: string, raw: BrowserJobResultInput) {
  requireScope(ctx.actor, "facebook:execute");
  const input = BrowserJobResultInput.parse(raw);
  const job = await claimedJob(ctx, jobId);
  const at = now(ctx);
  const wsId = ctx.actor.workspaceId;
  const result = {
    post_id: input.post_id ?? null,
    post_url: input.post_url ?? null,
    pending: input.pending ?? false,
    error_kind: input.error_kind ?? null,
    raw: input.raw ?? null,
  };
  const [post] = job.postId
    ? await ctx.db.select().from(posts).where(eq(posts.id, job.postId))
    : [];

  if (input.ok) {
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(browserJobs)
        .set({ status: "done", finishedAt: at, result, error: null })
        .where(eq(browserJobs.id, job.id));
      if (post) {
        await tx
          .update(posts)
          .set({
            status: "sent",
            sentAt: at,
            externalMessageId: input.post_id ?? null,
            externalUrl: input.post_url ?? null,
            error: input.pending ? "Aguardando aprovação do admin do grupo." : null,
          })
          .where(eq(posts.id, post.id));
        await tx
          .insert(channelStatsDaily)
          .values({
            channelId: post.channelId,
            date: localDate(at, await workspaceTz(tx, wsId)),
            messagesSent: 1,
          })
          .onConflictDoUpdate({
            target: [channelStatsDaily.channelId, channelStatsDaily.date],
            set: { messagesSent: sql`${channelStatsDaily.messagesSent} + 1` },
          });
      }
      await recordAudit(tx, ctx.actor, {
        action: "posts.send",
        target: { type: "post", id: post?.id ?? job.id },
        params: { group_id: job.payload.group_id, post_url: input.post_url ?? null },
        result: "ok",
      });
    });
    return { status: "done" as const };
  }

  const reason = input.error?.trim() || "Falha ao publicar no Facebook.";
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(browserJobs)
      .set({ status: "failed", finishedAt: at, result, error: reason })
      .where(eq(browserJobs.id, job.id));

    if (input.error_kind === "blocked") {
      const until = new Date(at.getTime() + FACEBOOK_BLOCK_PAUSE_MS);
      await tx
        .update(facebookAccounts)
        .set({ pausedUntil: until, pauseReason: reason })
        .where(eq(facebookAccounts.id, job.facebookAccountId));
      // Para tudo do perfil: os outros trabalhos voltam para a fila depois da pausa.
      const others = await tx
        .update(browserJobs)
        .set({ status: "canceled", finishedAt: at, error: "Perfil pausado por bloqueio." })
        .where(
          and(
            eq(browserJobs.facebookAccountId, job.facebookAccountId),
            eq(browserJobs.status, "queued"),
          ),
        )
        .returning({ postId: browserJobs.postId });
      const ids = [post?.id, ...others.map((o) => o.postId)].filter((x): x is string => Boolean(x));
      if (ids.length) {
        await tx
          .update(posts)
          .set({ status: "scheduled", scheduledAt: until, error: reason, sendStartedAt: null })
          .where(inArray(posts.id, ids));
      }
      await emitEvent(tx, wsId, "post.failed", { post_id: post?.id ?? null, reason });
      return;
    }

    if (!post) return;
    if (input.error_kind === "not_member") {
      await tx.update(channels).set({ status: "paused" }).where(eq(channels.id, post.channelId));
      await failPost(tx, post, "O perfil não está no grupo (ou foi removido). Grupo pausado.");
      return;
    }
    if (post.attempts >= MAX_ATTEMPTS) await failPost(tx, post, reason);
    else await retry(tx, post, at, reason, true);
  });
  return { status: "failed" as const };
}

async function retry(db: DbOrTx, post: PostRow, at: Date, reason: string, backoff: boolean) {
  const delay = backoff ? 2 ** post.attempts * MINUTE : 10 * MINUTE;
  await db
    .update(posts)
    .set({
      status: "scheduled",
      scheduledAt: new Date(at.getTime() + delay),
      error: reason,
      sendStartedAt: null,
    })
    .where(eq(posts.id, post.id));
}

async function failPost(db: DbOrTx, post: Pick<PostRow, "id" | "workspaceId">, reason: string) {
  await db.update(posts).set({ status: "failed", error: reason }).where(eq(posts.id, post.id));
  await emitEvent(db, post.workspaceId, "post.failed", { post_id: post.id, reason });
}

/**
 * Trabalhos abandonados: pegos e sem resposta no prazo (podem ter saído: não repete) ou que
 * ninguém pegou em 2 h (Chrome fechado). Roda junto com o publicador.
 */
export async function recoverBrowserJobs(deps: Deps) {
  const at = now(deps);
  const expired = await deps.db
    .update(browserJobs)
    .set({ status: "failed", finishedAt: at, error: MAYBE_POSTED })
    .where(and(eq(browserJobs.status, "claimed"), lt(browserJobs.leaseUntil, at)))
    .returning({ postId: browserJobs.postId, workspaceId: browserJobs.workspaceId });
  const abandoned = await deps.db
    .update(browserJobs)
    .set({ status: "canceled", finishedAt: at, error: "A extensão não pegou o post." })
    .where(
      and(
        eq(browserJobs.status, "queued"),
        lt(browserJobs.createdAt, new Date(at.getTime() - QUEUED_TTL_MS)),
      ),
    )
    .returning({ postId: browserJobs.postId, workspaceId: browserJobs.workspaceId });
  for (const j of expired) {
    if (j.postId)
      await failPost(deps.db, { id: j.postId, workspaceId: j.workspaceId }, MAYBE_POSTED);
  }
  for (const j of abandoned) {
    if (j.postId) {
      await failPost(
        deps.db,
        { id: j.postId, workspaceId: j.workspaceId },
        "A extensão não pegou o post em 2 h. Deixe o Chrome aberto com uma aba do Facebook.",
      );
    }
  }
  return { expired: expired.length, abandoned: abandoned.length };
}

// ── Publicador (chamado por publishPost) ────────────────────────

export type FacebookGate =
  | { kind: "ready"; account: AccountRow }
  | { kind: "wait"; at: Date; reason: string | null; countAttempt: boolean }
  | { kind: "fail"; reason: string };

/** Intervalo entre posts do perfil: entre o mínimo e o máximo, fixo por post (não sorteia a cada volta). */
function gapFor(postId: string, minMs: number, maxMs: number) {
  let h = 0;
  for (const ch of postId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return minMs + (maxMs > minMs ? h % (maxMs - minMs) : 0);
}

/** Pode preparar o post agora? Perfil ligado (extensão online), fora de pausa e dentro dos limites. */
export async function facebookGate(
  deps: Deps,
  post: PostRow,
  channel: ChannelRow,
): Promise<FacebookGate> {
  const at = now(deps);
  if (!channel.facebookAccountId || !channel.externalId) {
    return { kind: "fail", reason: "Grupo sem perfil do Facebook ligado." };
  }
  const [account] = await deps.db
    .select()
    .from(facebookAccounts)
    .where(eq(facebookAccounts.id, channel.facebookAccountId));
  if (!account) return { kind: "fail", reason: "Perfil do Facebook removido." };
  // Só posta onde o grupo aceita divulgação.
  if (channel.postingPolicy === "forbidden") {
    return { kind: "fail", reason: "Grupo não aceita divulgação." };
  }
  if (!policyAllowsPosting(channel.postingPolicy)) {
    return {
      kind: "fail",
      reason: "Grupo ainda não analisado: analise a política antes de publicar.",
    };
  }
  if (account.pausedUntil && account.pausedUntil > at) {
    return {
      kind: "wait",
      at: account.pausedUntil,
      reason: account.pauseReason,
      countAttempt: false,
    };
  }
  const waiting = (reason: string): FacebookGate =>
    post.attempts >= MAX_WAIT_ATTEMPTS
      ? { kind: "fail", reason }
      : { kind: "wait", at: new Date(at.getTime() + 5 * MINUTE), reason, countAttempt: true };
  if (!isOnline(account, at)) {
    return waiting("Extensão desligada: deixe o Chrome aberto com uma aba do Facebook.");
  }

  const wsId = post.workspaceId;
  const live = inArray(browserJobs.status, ["queued", "claimed", "done"]);
  // Um post por grupo no intervalo (padrão 24 h).
  const groupHours = await getLimit(deps, wsId, "facebook.group_interval_hours");
  const [lastInGroup] = await deps.db
    .select({ at: sql<string | null>`max(${browserJobs.createdAt})` })
    .from(browserJobs)
    .innerJoin(posts, eq(posts.id, browserJobs.postId))
    .where(and(eq(posts.channelId, channel.id), live));
  if (lastInGroup?.at) {
    const next = new Date(lastInGroup.at).getTime() + groupHours * HOUR;
    if (next > at.getTime())
      return { kind: "wait", at: new Date(next), reason: null, countAttempt: false };
  }
  // Intervalo aleatório entre posts do perfil.
  const gap = gapFor(
    post.id,
    (await getLimit(deps, wsId, "facebook.min_gap_minutes")) * MINUTE,
    (await getLimit(deps, wsId, "facebook.max_gap_minutes")) * MINUTE,
  );
  const [counts] = await deps.db
    .select({
      last: sql<string | null>`max(${browserJobs.createdAt})`,
      hour: sql<number>`count(*) filter (where ${browserJobs.createdAt} >= ${new Date(at.getTime() - HOUR).toISOString()})::int`,
      day: sql<number>`count(*) filter (where ${browserJobs.createdAt} >= ${new Date(at.getTime() - 24 * HOUR).toISOString()})::int`,
    })
    .from(browserJobs)
    .where(and(eq(browserJobs.facebookAccountId, account.id), live));
  if (counts?.last) {
    const next = new Date(counts.last).getTime() + gap;
    if (next > at.getTime())
      return { kind: "wait", at: new Date(next), reason: null, countAttempt: false };
  }
  if ((counts?.hour ?? 0) >= (await getLimit(deps, wsId, "facebook.per_hour"))) {
    return {
      kind: "wait",
      at: new Date(at.getTime() + 10 * MINUTE),
      reason: null,
      countAttempt: false,
    };
  }
  if ((counts?.day ?? 0) >= (await getLimit(deps, wsId, "facebook.per_day"))) {
    return { kind: "wait", at: new Date(at.getTime() + HOUR), reason: null, countAttempt: false };
  }
  return { kind: "ready", account };
}

/** Entrega o post pronto à extensão (ela prepara e a pessoa publica). Fica "sending" até a resposta. */
export async function queueFacebookPost(
  deps: Deps,
  post: PostRow,
  channel: ChannelRow,
  account: AccountRow,
  content: { body: string; imageUrl: string | null; trackedLinkId: string | null },
): Promise<{ status: string; reason?: string }> {
  await deps.db.transaction(async (tx) => {
    await tx.insert(browserJobs).values({
      workspaceId: post.workspaceId,
      facebookAccountId: account.id,
      type: "post",
      postId: post.id,
      payload: {
        group_id: channel.externalId ?? "",
        text: content.body,
        image_source_url: content.imageUrl,
      },
    });
    await tx
      .update(posts)
      .set({ body: content.body, trackedLinkId: content.trackedLinkId, error: null })
      .where(eq(posts.id, post.id));
  });
  await recordAudit(deps.db, systemActor(post.workspaceId, "publisher"), {
    action: "facebook.queue_post",
    target: { type: "post", id: post.id },
    params: { channel: channel.name, group_id: channel.externalId },
    result: "ok",
  });
  return { status: "queued" };
}
