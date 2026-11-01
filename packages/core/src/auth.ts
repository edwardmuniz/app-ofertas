import { LoginInput, type Me, ROLE_SCOPES, type Role, SignupInput } from "@ofertas/contracts";
import { type DbOrTx, memberships, sessions, users, workspaces } from "@ofertas/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { type Actor, type Deps, now } from "./context";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto";
import { AppError } from "./errors";
import { consumeLimit, DEFAULT_LIMITS } from "./limits";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionResult = { sessionToken: string; expiresAt: Date; me: Me };

async function createSession(deps: Deps, userId: string, workspaceId: string) {
  const token = randomToken();
  const expiresAt = new Date(now(deps).getTime() + SESSION_TTL_MS);
  await deps.db.insert(sessions).values({ id: sha256(token), userId, workspaceId, expiresAt });
  return { token, expiresAt };
}

function userActor(me: Me, origin: Actor["origin"] = "web"): Actor {
  return {
    type: "user",
    id: me.user.id,
    label: me.user.email,
    userId: me.user.id,
    role: me.role,
    workspaceId: me.workspace.id,
    scopes: new Set(ROLE_SCOPES[me.role]),
    origin,
  };
}

/**
 * Cria usuário + workspace (como owner). O primeiro cadastro é sempre permitido;
 * os demais só com allowSignup.
 */
export async function signup(
  deps: Deps,
  rawInput: SignupInput,
  opts: { allowSignup: boolean },
): Promise<SessionResult> {
  const input = SignupInput.parse(rawInput);
  const email = input.email.toLowerCase();

  const ensureOpen = async (db: DbOrTx) => {
    if (opts.allowSignup) return;
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    if ((row?.n ?? 0) > 0) {
      throw new AppError("FORBIDDEN", "Novos cadastros estão desativados.", {
        hint: "Peça acesso ao dono do workspace.",
      });
    }
  };
  // Checagem rápida antes do hash da senha (que é caro de propósito).
  await ensureOpen(deps.db);

  const passwordHash = await hashPassword(input.password);
  const me = await deps.db.transaction(async (tx) => {
    // Trava global: dois cadastros simultâneos numa instalação nova não viram dois donos.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('auth.signup'))`);
    await ensureOpen(tx);
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new AppError("CONFLICT", "Já existe uma conta com este e-mail.");

    const [user] = await tx
      .insert(users)
      .values({ email, name: input.name, passwordHash })
      .returning();
    const [ws] = await tx.insert(workspaces).values({ name: input.workspace_name }).returning();
    if (!user || !ws) throw new Error("Falha ao criar conta");
    await tx.insert(memberships).values({ userId: user.id, workspaceId: ws.id, role: "owner" });
    const me: Me = {
      user: { id: user.id, name: user.name, email: user.email },
      workspace: { id: ws.id, name: ws.name, timezone: ws.timezone },
      role: "owner",
    };
    await recordAudit(tx, userActor(me), {
      action: "auth.signup",
      target: { type: "workspace", id: ws.id },
      result: "ok",
    });
    return me;
  });

  const session = await createSession(deps, me.user.id, me.workspace.id);
  return { sessionToken: session.token, expiresAt: session.expiresAt, me };
}

async function loadMe(deps: Deps, userId: string, workspaceId?: string): Promise<Me | null> {
  const conds = [eq(memberships.userId, userId)];
  if (workspaceId) conds.push(eq(memberships.workspaceId, workspaceId));
  const [row] = await deps.db
    .select({ user: users, workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(...conds))
    .orderBy(memberships.createdAt)
    .limit(1);
  if (!row) return null;
  return {
    user: { id: row.user.id, name: row.user.name, email: row.user.email },
    workspace: { id: row.workspace.id, name: row.workspace.name, timezone: row.workspace.timezone },
    role: row.role as Role,
  };
}

const LOGIN_WINDOW_SEC = 15 * 60;

/** Freia tentativa de senha por força bruta: limite por IP e por e-mail. */
async function throttleLogin(deps: Deps, email: string, ip: string | undefined) {
  if (ip) {
    await consumeLimit(deps, {
      key: "auth.login_per_ip",
      bucket: ip,
      max: DEFAULT_LIMITS["auth.login_per_ip"],
      windowSec: LOGIN_WINDOW_SEC,
    });
  }
  await consumeLimit(deps, {
    key: "auth.login_per_email",
    bucket: sha256(email),
    max: DEFAULT_LIMITS["auth.login_per_email"],
    windowSec: LOGIN_WINDOW_SEC,
  });
}

export async function login(
  deps: Deps,
  rawInput: LoginInput,
  opts: { ip?: string } = {},
): Promise<SessionResult> {
  const input = LoginInput.parse(rawInput);
  const email = input.email.toLowerCase();
  await throttleLogin(deps, email, opts.ip);
  const [user] = await deps.db.select().from(users).where(eq(users.email, email));
  const ok = user ? await verifyPassword(input.password, user.passwordHash) : false;
  if (!user || !ok) throw new AppError("UNAUTHENTICATED", "E-mail ou senha incorretos.");

  const me = await loadMe(deps, user.id);
  if (!me) throw new AppError("FORBIDDEN", "Usuário sem acesso a nenhum workspace.");
  const session = await createSession(deps, user.id, me.workspace.id);
  await recordAudit(deps.db, userActor(me), { action: "auth.login", result: "ok" });
  return { sessionToken: session.token, expiresAt: session.expiresAt, me };
}

export async function resolveSession(
  deps: Deps,
  token: string,
): Promise<{ actor: Actor; me: Me } | null> {
  const [s] = await deps.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, now(deps))))
    .limit(1);
  if (!s) return null;
  const me = await loadMe(deps, s.userId, s.workspaceId);
  if (!me) return null;
  return { actor: userActor(me), me };
}

export async function logout(deps: Deps, token: string) {
  await deps.db.delete(sessions).where(eq(sessions.id, sha256(token)));
}
