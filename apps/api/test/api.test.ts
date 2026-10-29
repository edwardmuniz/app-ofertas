import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MemoryCounterStore } from "@ofertas/core";
import { createDb, limits, runMigrations } from "@ofertas/db";
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
    deps: { db, counters: new MemoryCounterStore() },
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
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_audit_log",
      "get_preferences",
      "get_workspace_overview",
      "update_preferences",
    ]);
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
