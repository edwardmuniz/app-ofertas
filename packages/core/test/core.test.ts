import { policies, users } from "@ofertas/db";
import { resetDb } from "@ofertas/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
  authenticateToken,
  type Ctx,
  createToken,
  type Deps,
  getOverview,
  getPreferences,
  listAudit,
  login,
  resolveSession,
  revokeToken,
  signup,
  updatePreferences,
} from "../src";
import { createOwner, setupTestDeps } from "./helpers";

let deps: Deps & { close: () => Promise<void> };

beforeAll(async () => {
  deps = await setupTestDeps();
});
afterAll(async () => {
  await deps.close();
});

async function ownerCtx(): Promise<Ctx> {
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão inválida");
  return { ...deps, actor: r.actor };
}

async function tokenCtx(owner: Ctx, preset: "read_only" | "full" = "full"): Promise<Ctx> {
  const t = await createToken(owner, { name: "agente", preset });
  const actor = await authenticateToken(deps, t.token, "mcp");
  if (!actor) throw new Error("token inválido");
  return { ...deps, actor };
}

describe("auth", () => {
  it("cadastra, faz login e resolve sessão", async () => {
    const s = await createOwner(deps);
    expect(s.me.role).toBe("owner");
    const l = await login(deps, { email: s.me.user.email, password: "senha-forte-123" });
    const r = await resolveSession(deps, l.sessionToken);
    expect(r?.me.workspace.id).toBe(s.me.workspace.id);
  });

  it("rejeita senha errada", async () => {
    const s = await createOwner(deps);
    await expect(login(deps, { email: s.me.user.email, password: "errada" })).rejects.toThrow(
      AppError,
    );
  });

  it("bloqueia novo cadastro quando já existem usuários e allowSignup=false", async () => {
    await createOwner(deps);
    await expect(
      signup(
        deps,
        { name: "X", email: "x@teste.com", password: "12345678", workspace_name: "X" },
        { allowSignup: false },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("freia força bruta no login por e-mail e por IP", async () => {
    const s = await createOwner(deps);
    const email = s.me.user.email;
    for (let i = 0; i < 10; i++) {
      await expect(login(deps, { email, password: "errada" })).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    }
    // 11ª tentativa no mesmo e-mail: bloqueada mesmo com a senha certa.
    await expect(login(deps, { email, password: "senha-forte-123" })).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });

    const ip = "203.0.113.9";
    for (let i = 0; i < 20; i++) {
      await login(deps, { email: `naoexiste${i}@teste.com`, password: "x" }, { ip }).catch(
        () => {},
      );
    }
    const other = await createOwner(deps);
    await expect(
      login(deps, { email: other.me.user.email, password: "senha-forte-123" }, { ip }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("instalação nova: dois cadastros ao mesmo tempo criam um só dono", async () => {
    await resetDb(deps.db);
    const attempt = (n: number) =>
      signup(
        deps,
        {
          name: `P${n}`,
          email: `primeiro${n}@teste.com`,
          password: "senha-forte-123",
          workspace_name: `W${n}`,
        },
        { allowSignup: false },
      );
    const results = await Promise.allSettled([attempt(1), attempt(2), attempt(3)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [row] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(users);
    expect(row?.n).toBe(1);
  });
});

describe("tokens", () => {
  it("autentica token, respeita escopos e revogação", async () => {
    const owner = await ownerCtx();
    const t = await createToken(owner, { name: "leitura", preset: "read_only" });
    expect(t.token.startsWith("ofk_")).toBe(true);

    const actor = await authenticateToken(deps, t.token, "mcp");
    expect(actor?.scopes.has("settings:read")).toBe(true);
    expect(actor?.scopes.has("settings:write")).toBe(false);

    await revokeToken(owner, t.id);
    expect(await authenticateToken(deps, t.token, "mcp")).toBeNull();
  });

  it("agente não pode criar tokens", async () => {
    const owner = await ownerCtx();
    const agent = await tokenCtx(owner);
    await expect(createToken(agent, { name: "x", preset: "full" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("token só leitura não altera preferências", async () => {
    const owner = await ownerCtx();
    const agent = await tokenCtx(owner, "read_only");
    await expect(updatePreferences(agent, { notes: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN_SCOPE",
    });
  });
});

describe("runMutation (via preferências)", () => {
  it("dry_run mostra prévia sem alterar", async () => {
    const owner = await ownerCtx();
    const agent = await tokenCtx(owner);
    const res = await updatePreferences(agent, { niches: ["casa"] }, { dryRun: true });
    expect(res.status).toBe("dry_run");
    if (res.status === "dry_run") expect(res.preview.after.niches).toEqual(["casa"]);
    expect((await getPreferences(agent)).niches).toBeUndefined();
  });

  it("executa, mescla campos e grava auditoria com motivo", async () => {
    const owner = await ownerCtx();
    const agent = await tokenCtx(owner);
    await updatePreferences(agent, { niches: ["casa"] });
    const res = await updatePreferences(agent, { notes: "foco em BF" }, { reason: "teste" });
    expect(res.status).toBe("done");
    expect(await getPreferences(agent)).toEqual({ niches: ["casa"], notes: "foco em BF" });

    const audit = await listAudit(owner, { action: "workspace.update_preferences" });
    expect(audit.items[0]?.reason).toBe("teste");
    expect(audit.items[0]?.origin).toBe("mcp");
    expect(audit.items[0]?.actor_type).toBe("token");
  });

  it("idempotência: repetir a mesma chave não executa de novo", async () => {
    const owner = await ownerCtx();
    const agent = await tokenCtx(owner);
    const key = "chave-idem-0001";
    const a = await updatePreferences(agent, { notes: "1" }, { idempotencyKey: key });
    const b = await updatePreferences(agent, { notes: "1" }, { idempotencyKey: key });
    expect(b).toEqual(a);
    const audit = await listAudit(owner, { action: "workspace.update_preferences" });
    expect(audit.items).toHaveLength(1);
    await expect(
      updatePreferences(agent, { notes: "2" }, { idempotencyKey: key }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("política approval cria aprovação pendente para agente", async () => {
    const owner = await ownerCtx();
    const agent = await tokenCtx(owner);
    await deps.db.insert(policies).values({
      workspaceId: owner.actor.workspaceId,
      actionType: "workspace.update_preferences",
      mode: "approval",
    });
    const res = await updatePreferences(agent, { notes: "pendente" });
    expect(res.status).toBe("pending_approval");
    expect((await getPreferences(agent)).notes).toBeUndefined();
    expect((await getOverview(agent)).counts.pending_approvals).toBe(1);

    // humano executa direto
    const human = await updatePreferences(owner, { notes: "ok" });
    expect(human.status).toBe("done");
  });

  it("política blocked impede a ação", async () => {
    const owner = await ownerCtx();
    await deps.db.insert(policies).values({
      workspaceId: owner.actor.workspaceId,
      actionType: "workspace.update_preferences",
      mode: "blocked",
    });
    await expect(updatePreferences(owner, { notes: "x" })).rejects.toMatchObject({
      code: "ACTION_BLOCKED",
    });
  });
});

describe("auditoria", () => {
  it("pagina com cursor", async () => {
    const owner = await ownerCtx();
    for (let i = 0; i < 5; i++) await updatePreferences(owner, { notes: String(i) });
    const p1 = await listAudit(owner, { limit: 3, action: "workspace.update_preferences" });
    expect(p1.items).toHaveLength(3);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await listAudit(owner, {
      limit: 3,
      action: "workspace.update_preferences",
      cursor: p1.next_cursor ?? undefined,
    });
    expect(p2.items).toHaveLength(2);
    expect(p2.next_cursor).toBeNull();
  });

  it("isola workspaces", async () => {
    const a = await ownerCtx();
    const b = await ownerCtx();
    await updatePreferences(a, { notes: "a" });
    const audit = await listAudit(b, { action: "workspace.update_preferences" });
    expect(audit.items).toHaveLength(0);
  });
});
