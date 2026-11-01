import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMessagingProviderFactory,
  defaultAffiliateConnectorFactory,
} from "@ofertas/connectors";
import { MemoryCache, MemoryCounterStore, MemoryStorage, SecretBox } from "@ofertas/core";
import { channels, createDb, limits, runMigrations } from "@ofertas/db";
import { resetDb } from "@ofertas/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

let app: FastifyInstance;
let baseUrl: string;
let closeDb: () => Promise<void>;
let db: ReturnType<typeof createDb>["db"];
let cookie: string;
let workspaceId: string;

async function createAgentToken(preset: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/tokens",
    headers: { cookie },
    payload: { name: `agente-${preset}`, preset },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

async function mcpClient(token: string) {
  const client = new Client({ name: "teste", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function parse(result: unknown) {
  const r = result as { content: { type: string; text: string }[]; isError?: boolean };
  return { isError: r.isError ?? false, body: JSON.parse(r.content[0]?.text ?? "null") };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST não definida");
  await runMigrations(url);
  const conn = createDb(url, { max: 5 });
  db = conn.db;
  closeDb = conn.close;
  await resetDb(db);

  app = await buildApp({
    deps: {
      db,
      counters: new MemoryCounterStore(),
      cache: new MemoryCache(),
      redirectBaseUrl: "http://go.test",
      secrets: new SecretBox(Buffer.alloc(32, 1).toString("base64")),
      affiliateConnectors: defaultAffiliateConnectorFactory,
      messaging: createMessagingProviderFactory({}),
      messagingWebhookUrl: "http://api.test/webhooks/whatsapp",
      storage: new MemoryStorage(),
      fetchMedia: async () => {
        throw new Error("sem rede nos testes");
      },
      fetchPage: async () => {
        throw new Error("sem rede nos testes");
      },
      openStream: async () => {
        throw new Error("sem rede nos testes");
      },
      publicApiUrl: "http://localhost",
    },
    allowSignup: false,
    publicUrl: "http://localhost",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("sem endereço");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      name: "Dono",
      email: "dono@teste.com",
      password: "senha-forte-123",
      workspace_name: "Loja",
    },
  });
  expect(res.statusCode).toBe(200);
  workspaceId = res.json().workspace.id;
  const setCookie = res.headers["set-cookie"];
  cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("REST", () => {
  it("health", async () => {
    const res = await app.inject({ url: "/v1/health" });
    expect(res.json()).toEqual({ ok: true });
  });

  it("401 sem autenticação, com formato de erro padrão", async () => {
    const res = await app.inject({ url: "/v1/workspace/overview" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("segundo cadastro bloqueado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { name: "B", email: "b@teste.com", password: "12345678", workspace_name: "B" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("validação devolve VALIDATION_ERROR", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/workspace/preferences",
      headers: { cookie },
      payload: { posting_windows: ["25h"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("PATCH preferências com dry_run e com token Bearer", async () => {
    const token = await createAgentToken("full");
    const dry = await app.inject({
      method: "PATCH",
      url: "/v1/workspace/preferences?dry_run=true",
      headers: { authorization: `Bearer ${token}` },
      payload: { niches: ["tech"] },
    });
    expect(dry.json().status).toBe("dry_run");

    const done = await app.inject({
      method: "PATCH",
      url: "/v1/workspace/preferences",
      headers: { authorization: `Bearer ${token}`, "x-audit-reason": "via rest" },
      payload: { niches: ["tech"] },
    });
    expect(done.json()).toMatchObject({ status: "done", result: { niches: ["tech"] } });
  });

  it("token de agente não cria tokens", async () => {
    const token = await createAgentToken("full");
    const res = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "x", preset: "full" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("token inválido devolve 401", async () => {
    const res = await app.inject({
      url: "/v1/workspace/overview",
      headers: { authorization: "Bearer ofk_invalido" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("OpenAPI publicado", async () => {
    const res = await app.inject({ url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain("/v1/workspace/preferences");
  });

  it("rate limit devolve 429 com Retry-After", async () => {
    const token = await createAgentToken("read_only");
    await db.insert(limits).values({ workspaceId, key: "api.requests_per_minute", value: 2 });
    try {
      const call = () =>
        app.inject({ url: "/v1/health", headers: { authorization: `Bearer ${token}` } });
      await call();
      await call();
      const third = await call();
      expect(third.statusCode).toBe(429);
      expect(third.headers["retry-after"]).toBeDefined();
    } finally {
      await db.delete(limits);
    }
  });
});

describe("MCP", () => {
  it("recusa sem token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("lista tools, entrega instruções e chama overview", async () => {
    const client = await mcpClient(await createAgentToken("full"));
    expect(client.getInstructions()).toContain("dry_run");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "get_audit_log",
        "get_preferences",
        "get_workspace_overview",
        "update_preferences",
        "create_tracked_link",
        "get_link_stats",
        "create_invite_link",
      ]),
    );
    const res = parse(await client.callTool({ name: "get_workspace_overview", arguments: {} }));
    expect(res.isError).toBe(false);
    expect(res.body.workspace.name).toBe("Loja");
    await client.close();
  });

  it("update_preferences: dry_run, idempotência e auditoria com origem mcp", async () => {
    const client = await mcpClient(await createAgentToken("full"));
    const args = { notes: "via mcp", reason: "teste mcp", idempotency_key: "mcp-idem-0001" };

    const dry = parse(
      await client.callTool({ name: "update_preferences", arguments: { ...args, dry_run: true } }),
    );
    expect(dry.body.status).toBe("dry_run");

    const a = parse(await client.callTool({ name: "update_preferences", arguments: args }));
    const b = parse(await client.callTool({ name: "update_preferences", arguments: args }));
    expect(a.body.status).toBe("done");
    expect(b.body).toEqual(a.body);

    const audit = parse(
      await client.callTool({
        name: "get_audit_log",
        arguments: { action: "workspace.update_preferences", origin: "mcp" },
      }),
    );
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0].reason).toBe("teste mcp");
    await client.close();
  });

  it("erro de escopo vem como isError com código e hint", async () => {
    const client = await mcpClient(await createAgentToken("read_only"));
    const res = parse(
      await client.callTool({ name: "update_preferences", arguments: { notes: "x" } }),
    );
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe("FORBIDDEN_SCOPE");
    expect(res.body.error.hint).toBeTruthy();
    await client.close();
  });

  it("lê resource de preferências", async () => {
    const client = await mcpClient(await createAgentToken("read_only"));
    const r = await client.readResource({ uri: "workspace://preferences" });
    const first = r.contents[0] as { text?: string } | undefined;
    expect(JSON.parse(first?.text ?? "{}")).toHaveProperty("niches");
    await client.close();
  });
});

describe("Fase 1: links e convites", () => {
  it("agente monta segmento, grupo, convite e link pelo MCP", async () => {
    const client = await mcpClient(await createAgentToken("full_no_spend"));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = parse(await client.callTool({ name, arguments: args }));
      if (r.isError) throw new Error(JSON.stringify(r.body));
      return r.body;
    };

    const seg = await call("upsert_segment", { name: "achadinhos" });
    // Grupo de fora do número conectado (não há cadastro manual: entra direto no banco).
    const [row] = await db
      .insert(channels)
      .values({ workspaceId, name: "Achadinhos #1", inviteUrl: "https://chat.whatsapp.com/XYZ" })
      .returning();
    const ch = await call("update_channel", {
      channel_id: row?.id,
      segment_ids: [seg.result.id],
    });
    expect(ch.result.segment_ids).toEqual([seg.result.id]);

    const inv = await call("create_invite_link", {
      segment_id: seg.result.id,
      name: "Bio Instagram",
      slug: "achadinhos",
    });
    expect(inv.result.url).toBe("http://go.test/entrar/achadinhos");
    expect(inv.result.capacity.current_channel.name).toBe("Achadinhos #1");

    const dry = await call("create_tracked_link", {
      destination_url: "https://shopee.com.br/produto",
      source: "wa",
      dry_run: true,
    });
    expect(dry.status).toBe("dry_run");

    const link = await call("create_tracked_link", {
      destination_url: "https://shopee.com.br/produto",
      source: "wa",
      channel_id: ch.result.id,
      reason: "oferta do dia",
    });
    expect(link.result.short_url).toMatch(/^http:\/\/go\.test\/\w{7}$/);

    const updated = await call("update_tracked_link", {
      id: link.result.id,
      destination_url: "https://shopee.com.br/outro",
    });
    expect(updated.result.slug).toBe(link.result.slug);

    const stats = await call("get_link_stats", { group_by: "none" });
    expect(stats.totals).toEqual({ human: 0, unique: 0, bot: 0 });
    await client.close();
  });

  it("token só leitura não cria link pelo MCP", async () => {
    const client = await mcpClient(await createAgentToken("read_only"));
    const r = parse(
      await client.callTool({
        name: "create_tracked_link",
        arguments: { destination_url: "https://x.com" },
      }),
    );
    expect(r.body.error.code).toBe("FORBIDDEN_SCOPE");
    await client.close();
  });

  it("REST: cria e edita link, valida URL e lista", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/v1/links",
      headers: { cookie },
      payload: { destination_url: "javascript:alert(1)" },
    });
    expect(bad.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/v1/links",
      headers: { cookie, "x-audit-reason": "teste rest" },
      payload: { destination_url: "https://a.com", title: "Air fryer" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().result.id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/links/${id}`,
      headers: { cookie },
      payload: { active: false },
    });
    expect(patched.json().result.active).toBe(false);

    const list = await app.inject({ url: "/v1/links?q=air", headers: { cookie } });
    expect(list.json().items).toHaveLength(1);

    const stats = await app.inject({ url: "/v1/stats/clicks?group_by=day", headers: { cookie } });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().rows.length).toBeGreaterThanOrEqual(7);
  });
});

describe("Fase 2: ofertas", () => {
  it("humano conecta a Shopee simulada; agente não consegue conectar conta", async () => {
    const token = await createAgentToken("full");
    const byAgent = await app.inject({
      method: "POST",
      url: "/v1/affiliate-accounts",
      headers: { authorization: `Bearer ${token}` },
      payload: { platform: "shopee", label: "x", mode: "fake" },
    });
    expect(byAgent.statusCode).toBe(403);

    const res = await app.inject({
      method: "POST",
      url: "/v1/affiliate-accounts",
      headers: { cookie },
      payload: { platform: "shopee", label: "Shopee (simulado)", mode: "fake" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ mode: "fake", status: "active" });
  });

  it("agente busca, salva, valida e gera link pelo MCP", async () => {
    const client = await mcpClient(await createAgentToken("full_no_spend"));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = parse(await client.callTool({ name, arguments: args }));
      if (r.isError) throw new Error(JSON.stringify(r.body));
      return r.body;
    };

    const found = await call("search_offers", { keyword: "air fryer", min_discount: 20, limit: 5 });
    expect(found.items.length).toBeGreaterThan(0);
    const pick = found.items[0];
    expect(pick.score).toBeGreaterThanOrEqual(0);

    const saved = await call("save_offer", { product_id: pick.product_id, reason: "boa nota" });
    expect(saved.result.status).toBe("approved");

    const valid = await call("validate_offer", { offer_id: saved.result.id });
    expect(valid.result.ok).toBe(true);

    const link = await call("create_offer_link", {
      offer_id: saved.result.id,
      source: "wa",
      campaign: "bf",
    });
    expect(link.result.short_url).toMatch(/^http:\/\/go\.test\//);
    expect(link.result.sub_ids[0]).toBe("wa");

    const detail = await call("get_offer", { offer_id: saved.result.id });
    expect(detail.price_history.points).toBeGreaterThanOrEqual(1);

    const saved2 = await call("upsert_saved_search", {
      name: "Air fryers",
      query: { keyword: "air fryer", min_discount: 30 },
      interval_minutes: 60,
    });
    expect(saved2.result.active).toBe(true);
    await client.close();
  });

  it("REST: busca, lista e rejeita com motivo", async () => {
    const search = await app.inject({
      method: "POST",
      url: "/v1/offers/search",
      headers: { cookie },
      payload: { keyword: "fone", limit: 3 },
    });
    expect(search.statusCode).toBe(200);
    const productId = search.json().items[0].product_id;

    const saved = await app.inject({
      method: "POST",
      url: "/v1/offers",
      headers: { cookie },
      payload: { product_id: productId, status: "new" },
    });
    const offerId = saved.json().result.id;
    expect(saved.json().result.status).toBe("new");

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/offers/${offerId}/status`,
      headers: { cookie },
      payload: { status: "rejected", reason: "fora do nicho" },
    });
    expect(rejected.json().result).toMatchObject({
      status: "rejected",
      reject_reason: "fora do nicho",
    });

    const list = await app.inject({ url: "/v1/offers?status=rejected", headers: { cookie } });
    expect(list.json().items).toHaveLength(1);
  });
});

describe("Fase 3: WhatsApp e publicação", () => {
  it("humano conecta número simulado; agente importa grupos e agenda pelo MCP; webhook atualiza membros", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/whatsapp/accounts",
      headers: { cookie },
      payload: { label: "Número de ofertas", provider: "fake" },
    });
    expect(created.statusCode).toBe(200);
    const accountId = created.json().result.id;

    const conn = await app.inject({
      url: `/v1/whatsapp/accounts/${accountId}/connection`,
      headers: { cookie },
    });
    expect(conn.json().account.status).toBe("connected");

    const token = await createAgentToken("full_no_spend");
    // Agente não vê o QR (só humanos conectam números).
    const qrByAgent = await app.inject({
      url: `/v1/whatsapp/accounts/${accountId}/connection`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(qrByAgent.statusCode).toBe(403);

    const client = await mcpClient(token);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = parse(await client.callTool({ name, arguments: args }));
      if (r.isError) throw new Error(JSON.stringify(r.body));
      return r.body;
    };
    // O agente vê os grupos do número na prévia e importa os escolhidos.
    const avail = await call("sync_whatsapp_groups", { account_id: accountId, dry_run: true });
    expect(avail.preview.groups).toHaveLength(3);
    const synced = await call("sync_whatsapp_groups", {
      account_id: accountId,
      group_jids: avail.preview.groups.map((g: { jid: string }) => g.jid),
    });
    expect(synced.result.channels).toHaveLength(3);
    const group = synced.result.channels[0];

    const offers = await call("list_offers", { status: "approved", limit: 1 });
    const offerId = offers.items[0].id;
    const preview = await call("preview_post", { offer_id: offerId });
    expect(preview.body.length).toBeGreaterThan(10);

    const dry = await call("schedule_posts", {
      offer_ids: [offerId],
      channel_ids: [group.id],
      dry_run: true,
    });
    expect(dry.preview.posts).toHaveLength(1);
    const real = await call("schedule_posts", {
      offer_ids: [offerId],
      channel_ids: [group.id],
      reason: "teste",
    });
    expect(real.result.scheduled).toHaveLength(1);
    const queue = await call("list_posts", { status: "scheduled" });
    expect(queue.items.length).toBeGreaterThanOrEqual(1);
    await client.close();

    // Webhook: token errado é recusado; certo atualiza membros.
    const { messagingAccounts } = await import("@ofertas/db");
    const { eq } = await import("drizzle-orm");
    const [acc] = await db
      .select()
      .from(messagingAccounts)
      .where(eq(messagingAccounts.id, accountId));
    const { SecretBox } = await import("@ofertas/core");
    const instanceToken = new SecretBox(Buffer.alloc(32, 1).toString("base64")).decrypt(
      acc?.token ?? "",
    );
    const payload = (t: string) => ({
      event: "GroupInfo",
      instanceId: acc?.instanceId,
      instanceToken: t,
      data: { JID: group.external_id, Join: ["x@s"], Leave: [] },
    });
    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp/fake",
      payload: payload("nope"),
    });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp/fake",
      payload: payload(instanceToken),
    });
    expect(good.statusCode).toBe(200);
    const channels = await app.inject({ url: "/v1/channels", headers: { cookie } });
    const updated = channels.json().find((c: { id: string }) => c.id === group.id);
    expect(updated.member_count).toBe(group.member_count + 1);
  });
});

describe("Fase 3.1: gestão de grupos", () => {
  it("humano cria grupo pela API; agente lê e configura pelo MCP mas não cria", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/whatsapp/accounts",
      headers: { cookie },
      payload: { label: "Gestão", provider: "fake" },
    });
    const accountId = created.json().result.id;
    await app.inject({ url: `/v1/whatsapp/accounts/${accountId}/connection`, headers: { cookie } });

    const team = await app.inject({
      method: "POST",
      url: "/v1/team-contacts",
      headers: { cookie },
      payload: { phone: "+55 11 98888-1111", label: "Dono" },
    });
    expect(team.json().result.phone).toBe("5511988881111");

    const res = await app.inject({
      method: "POST",
      url: `/v1/whatsapp/accounts/${accountId}/groups`,
      headers: { cookie },
      payload: { name: "Ofertas API", participants: ["5511988881111"] },
    });
    expect(res.statusCode).toBe(200);
    const group = res.json().result.channel;
    expect(group).toMatchObject({ name: "Ofertas API", admin_only: true, locked: true });

    const details = await app.inject({
      url: `/v1/channels/${group.id}/group`,
      headers: { cookie },
    });
    expect(details.statusCode).toBe(200);
    expect(details.json().team_in_group).toEqual([
      { phone: "5511988881111", label: "Dono", is_admin: false },
    ]);

    const token = await createAgentToken("full_no_spend");
    const client = await mcpClient(token);
    const settings = parse(
      await client.callTool({
        name: "update_group_settings",
        arguments: { channel_id: group.id, approval_required: true },
      }),
    );
    expect(settings.body.result.approval_required).toBe(true);
    const byAgent = await app.inject({
      method: "POST",
      url: `/v1/whatsapp/accounts/${accountId}/groups`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Agente", participants: ["5511988881111"] },
    });
    expect(byAgent.statusCode).toBe(403);
  });
});

describe("Fase 4: criativos", () => {
  it("agente gera card pelo MCP, abre a prévia e sobe imagem própria com PUT", async () => {
    const client = await mcpClient(await createAgentToken("full_no_spend"));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = parse(await client.callTool({ name, arguments: args }));
      if (r.isError) throw new Error(JSON.stringify(r.body));
      return r.body;
    };
    const templates = await call("list_creative_templates", {});
    expect(templates.map((t: { key: string }) => t.key)).toEqual(["card_preco", "cupom_destaque"]);

    const offers = await call("list_offers", { status: "approved", limit: 1 });
    const generated = await call("generate_creative", {
      offer_id: offers.items[0].id,
      formats: ["wa_image", "feed_4x5"],
    });
    expect(generated.result.variants).toHaveLength(2);

    const preview = new URL(generated.result.variants[0].preview_url);
    const img = await app.inject({ url: `${preview.pathname}${preview.search}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");

    const ticket = await call("request_upload", {
      filename: "meu-card.png",
      mime: "image/png",
      size_bytes: img.rawPayload.length,
    });
    const put = new URL(ticket.result.put_url);
    const sent = await app.inject({
      method: "PUT",
      url: `${put.pathname}${put.search}`,
      headers: { "content-type": "image/png" },
      payload: img.rawPayload,
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ ok: true, width: 480 });

    const done = await call("complete_upload", {
      upload_id: ticket.result.upload_id,
      title: "Meu card",
    });
    expect(done.result).toMatchObject({ origin: "upload", title: "Meu card" });

    const lib = await call("list_creatives", {});
    expect(lib.items.length).toBeGreaterThanOrEqual(2);
    await client.close();

    const forged = await app.inject({
      url: `${preview.pathname}?e=${preview.searchParams.get("e")}&s=forjada1234`,
    });
    expect(forged.statusCode).toBe(404);
  });
});

describe("Fase 5: métricas e alertas", () => {
  it("agente lê resumo, funil, horários, status e calendário pelo MCP; prompt sazonal disponível", async () => {
    const client = await mcpClient(await createAgentToken("read_only"));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = parse(await client.callTool({ name, arguments: args }));
      if (r.isError) throw new Error(JSON.stringify(r.body));
      return r.body;
    };
    const summary = await call("get_performance_summary", { period: "7d" });
    expect(summary.audience.channels_active).toBeGreaterThanOrEqual(1);
    expect(summary.revenue).toBeNull();
    const funnel = await call("get_funnel", { period: "30d" });
    expect(funnel.stages).toHaveLength(5);
    const hours = await call("get_metrics_breakdown", { view: "hours", period: "7d" });
    expect(Array.isArray(hours.hours)).toBe(true);
    const status = await call("get_system_status");
    expect(status.worker.ok).toBe(false);
    const cal = await call("get_seasonal_calendar", { days: 60 });
    expect(cal.events.some((e: { key: string }) => e.key === "black_friday")).toBe(true);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain("planejar_campanha_sazonal");
    const p = await client.getPrompt({
      name: "planejar_campanha_sazonal",
      arguments: { evento: "black_friday" },
    });
    expect(JSON.stringify(p.messages)).toContain("get_seasonal_calendar");
    await client.close();
  });

  it("REST: resumo com período, validação e status público para monitores", async () => {
    const ok = await app.inject({ url: "/v1/metrics/summary?period=today", headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ url: "/v1/metrics/summary?period=custom", headers: { cookie } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");
    const pub = await app.inject({ url: "/v1/status" });
    expect(pub.statusCode).toBe(503);
    expect(pub.json()).toMatchObject({ db: true, worker: false });
    const alerts = await app.inject({ url: "/v1/alerts", headers: { cookie } });
    expect(alerts.json()).toEqual({ items: [] });
  });
});
