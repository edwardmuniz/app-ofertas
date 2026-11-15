import { FakeToolAgent, fakeAffiliateControls } from "@ofertas/connectors";
import { workspaces } from "@ofertas/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type Ctx,
  connectAffiliateAccount,
  type Deps,
  getAiUsage,
  getAutoCuratorStatus,
  listOffers,
  requestAutoCuratorRun,
  resolveSession,
  runAutoCurator,
  runDueAutoCurators,
  setAffiliateAccountStatus,
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
afterEach(() => fakeAffiliateControls.reset());

type SearchOut = { results: { ref: string; flags: string[]; in_curation: boolean }[] };

/** Roteiro do agente: busca "panelas" e escolhe as 3 primeiras sem sinal ruim. */
const pickThree = () =>
  new FakeToolAgent(async (call) => {
    const res = (await call("search_offers", { keyword: "panelas" })) as SearchOut;
    const good = res.results.filter((r) => !r.flags.includes("fake_discount")).slice(0, 3);
    await call("pick_offers", {
      picks: [
        ...good.map((r) => ({ ref: r.ref, reason: `Bom preço (${r.ref})` })),
        { ref: "p999", reason: "inventada" },
      ],
    });
    return "Escolhi panelas com desconto real.";
  });

async function shopCtx(agent: FakeToolAgent | null): Promise<Ctx> {
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão inválida");
  const ctx: Ctx = { ...deps, curatorAgent: agent, actor: r.actor };
  await connectAffiliateAccount(ctx, { platform: "shopee", label: "Shopee", mode: "fake" });
  return ctx;
}

describe("curador automático", () => {
  it("dry_run mostra as escolhas sem gravar; rodando, entram na curadoria com o motivo", async () => {
    const agent = pickThree();
    const ctx = await shopCtx(agent);
    await updatePreferences(ctx, { niches: ["cozinha"], forbidden: ["armas"] });

    const preview = await runAutoCurator(ctx, { dryRun: true });
    expect(preview.status).toBe("dry_run");
    if (preview.status !== "dry_run") return;
    expect(preview.preview.picks).toHaveLength(3);
    expect(preview.preview.searches).toEqual(["panelas"]);
    expect((await listOffers(ctx, { status: "new", limit: 50 })).items).toHaveLength(0);

    // O agente recebeu nichos e proibidos no pedido.
    expect(agent.runs[0]?.prompt).toContain("cozinha");
    expect(agent.runs[0]?.prompt).toContain("armas");

    const res = await runAutoCurator(ctx);
    if (res.status !== "done") throw new Error(res.status);
    expect(res.result.picks).toHaveLength(3);
    expect(res.result.picks.every((p) => p.offer_id)).toBe(true);
    const created = (await listOffers(ctx, { status: "new", limit: 50 })).items;
    expect(created).toHaveLength(3);
    expect(created.every((o) => o.notes?.startsWith("Curador: Bom preço"))).toBe(true);

    const status = await getAutoCuratorStatus(ctx);
    expect(status).toMatchObject({
      enabled: false,
      configured: true,
      last_result: { added: 3, searches: ["panelas"], error: null },
    });

    // Rodando de novo, o que já está na curadoria volta marcado e a escolha repetida é recusada.
    const again = await runAutoCurator(ctx);
    if (again.status !== "done") throw new Error(again.status);
    expect(again.result.picks).toHaveLength(0);
  });

  it("trabalha por conta ativa: limite em cada conta, conta desativada fica de fora; mede o gasto", async () => {
    type Result = SearchOut["results"][number] & { account: string; platform: string };
    let onlyFirst: Result[] = [];
    const agent = new FakeToolAgent(async (call) => {
      // Busca só na primeira conta: só vêm resultados dela.
      onlyFirst = (
        (await call("search_offers", { keyword: "panelas", account: "a1" })) as {
          results: Result[];
        }
      ).results;
      const all = ((await call("search_offers", { keyword: "panelas" })) as { results: Result[] })
        .results;
      await call("pick_offers", {
        picks: all
          .filter((r) => !r.flags.includes("fake_discount"))
          .map((r) => ({
            ref: r.ref,
            reason: `Boa (${r.account})`,
          })),
      });
      return "Escolhi nas duas contas.";
    });
    const ctx = await shopCtx(agent);
    await connectAffiliateAccount(ctx, { platform: "amazon", label: "Amazon", mode: "fake" });
    const off = await connectAffiliateAccount(ctx, {
      platform: "shopee",
      label: "Shopee velha",
      mode: "fake",
    });
    if (off.status !== "done") throw new Error(off.status);
    await setAffiliateAccountStatus(ctx, off.result.id, "disabled");
    await updatePreferences(ctx, { auto_curator_max_offers: 2 });

    const status = await getAutoCuratorStatus(ctx);
    expect(status.accounts.map((a) => a.label)).toEqual(["Shopee", "Amazon"]);

    const res = await runAutoCurator(ctx);
    if (res.status !== "done") throw new Error(res.status);
    // Conta desativada não entra no pedido nem na busca.
    expect(agent.runs[0]?.prompt).toContain("a1: Shopee (shopee)");
    expect(agent.runs[0]?.prompt).toContain("a2: Amazon (amazon)");
    expect(agent.runs[0]?.prompt).not.toContain("Shopee velha");
    expect(onlyFirst.length).toBeGreaterThan(0);
    expect(onlyFirst.every((r) => r.account === "a1" && r.platform === "shopee")).toBe(true);

    // Até 2 por conta: 4 no total, cada uma gravada na conta em que foi achada.
    const byLabel = (label: string) => res.result.picks.filter((p) => p.account_label === label);
    expect(byLabel("Shopee")).toHaveLength(2);
    expect(byLabel("Amazon")).toHaveLength(2);
    const amazonId = status.accounts.find((a) => a.label === "Amazon")?.id;
    const amazonOffers = await listOffers(ctx, { status: "new", affiliate_account_id: amazonId });
    expect(amazonOffers.items).toHaveLength(2);
    expect(amazonOffers.items.every((o) => o.affiliate_account_id === amazonId)).toBe(true);

    const after = await getAutoCuratorStatus(ctx);
    expect(after.last_result).toMatchObject({
      added: 4,
      by_account: { Shopee: 2, Amazon: 2 },
      cost_usd: 0.002,
    });

    // Gasto do curador fica registrado (o simulado informa US$ 0,002 por rodada).
    const usage = await getAiUsage(ctx);
    expect(usage.today.by_feature.find((f) => f.feature === "curator")).toMatchObject({
      calls: 1,
      cost_usd: 0.002,
    });
    expect(usage.month.cost_usd).toBeCloseTo(0.002);
    expect(usage.since).not.toBeNull();
  });

  it("respeita o máximo por rodada e recusa sem IA configurada", async () => {
    const ctx = await shopCtx(pickThree());
    await updatePreferences(ctx, { auto_curator_max_offers: 2 });
    const res = await runAutoCurator(ctx);
    if (res.status !== "done") throw new Error(res.status);
    expect(res.result.picks).toHaveLength(2);

    const off = await shopCtx(null);
    await expect(runAutoCurator(off)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("worker roda só quem ligou, de dia e quando o intervalo venceu", async () => {
    const agent = pickThree();
    const ctx = await shopCtx(agent);
    const wsId = ctx.actor.workspaceId;
    // 15h em São Paulo.
    const at = new Date("2026-11-16T18:00:00Z");
    const worker: Deps = { ...deps, curatorAgent: agent, now: () => at };

    expect((await runDueAutoCurators(worker)).some((r) => r.workspace_id === wsId)).toBe(false);

    await updatePreferences(ctx, { auto_curator: true, auto_curator_every_hours: 4 });
    const first = await runDueAutoCurators(worker);
    expect(first.find((r) => r.workspace_id === wsId)).toMatchObject({ added: 3 });

    // Intervalo ainda não venceu.
    expect((await runDueAutoCurators(worker)).some((r) => r.workspace_id === wsId)).toBe(false);

    // De madrugada não roda, mesmo vencido.
    const night: Deps = { ...worker, now: () => new Date("2026-11-17T06:00:00Z") };
    expect((await runDueAutoCurators(night)).some((r) => r.workspace_id === wsId)).toBe(false);

    // Falha da IA vira rodada com erro (espera o intervalo antes de tentar de novo).
    const broken = new FakeToolAgent(async () => {
      throw new Error("modelo fora do ar");
    });
    const later: Deps = {
      ...deps,
      curatorAgent: broken,
      now: () => new Date("2026-11-16T23:00:00Z"),
    };
    const failed = await runDueAutoCurators(later);
    expect(failed.find((r) => r.workspace_id === wsId)?.error).toContain("modelo fora do ar");
    const [ws] = await deps.db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, wsId));
    expect(ws?.settings.auto_curator?.error).toContain("modelo fora do ar");
  });

  it("rodar agora: o worker atende o pedido na próxima volta, mesmo desligado e de madrugada", async () => {
    const agent = pickThree();
    const ctx = await shopCtx(agent);
    const wsId = ctx.actor.workspaceId;
    const night = new Date("2026-11-17T06:00:00Z");
    const c: Ctx = { ...ctx, now: () => night };
    await requestAutoCuratorRun(c);
    expect((await getAutoCuratorStatus(c)).requested_at).toBe(night.toISOString());

    const worker: Deps = {
      ...deps,
      curatorAgent: agent,
      now: () => new Date(night.getTime() + 60_000),
    };
    expect((await runDueAutoCurators(worker)).find((r) => r.workspace_id === wsId)).toMatchObject({
      added: 3,
    });
    const status = await getAutoCuratorStatus(c);
    expect(status.requested_at).toBeNull();
    expect(status.last_result?.added).toBe(3);
    // Pedido atendido não roda de novo.
    expect((await runDueAutoCurators(worker)).some((r) => r.workspace_id === wsId)).toBe(false);

    await expect(requestAutoCuratorRun({ ...ctx, curatorAgent: null })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });
});
