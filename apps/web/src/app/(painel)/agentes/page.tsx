"use client";

import {
  type ApiToken,
  type CreatedToken,
  SCOPE_PRESETS,
  type ScopePreset,
} from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3001/mcp";

function snippets(token: string) {
  return [
    {
      name: "Claude Code",
      code: `claude mcp add --transport http ofertas ${MCP_URL} --header "Authorization: Bearer ${token}"`,
    },
    {
      name: "Codex (~/.codex/config.toml)",
      code: `[mcp_servers.ofertas]\nurl = "${MCP_URL}"\nbearer_token_env_var = "OFERTAS_TOKEN"\n\n# e no terminal:\n# export OFERTAS_TOKEN=${token}`,
    },
    {
      name: "Gemini CLI (~/.gemini/settings.json)",
      code: JSON.stringify(
        {
          mcpServers: {
            ofertas: { httpUrl: MCP_URL, headers: { Authorization: `Bearer ${token}` } },
          },
        },
        null,
        2,
      ),
    },
    {
      name: "Outros clientes (JSON genérico)",
      code: JSON.stringify(
        {
          mcpServers: {
            ofertas: { type: "http", url: MCP_URL, headers: { Authorization: `Bearer ${token}` } },
          },
        },
        null,
        2,
      ),
    },
  ];
}

function CopyBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100">
        {code}
      </pre>
    </div>
  );
}

export default function AgentesPage() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("Meu agente");
  const [preset, setPreset] = useState<ScopePreset>("full_no_spend");

  const load = useCallback(() => api<ApiToken[]>("/tokens").then(setTokens), []);
  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const t = await api<CreatedToken>("/tokens", { method: "POST", body: { name, preset } });
      setCreated(t);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao criar token.");
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revogar este token? O agente perde o acesso na hora.")) return;
    await api(`/tokens/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Conectar agente"
        subtitle={
          <>
            Gere um token para Claude, Codex, Gemini ou outro agente operar a plataforma pelo MCP em{" "}
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">{MCP_URL}</code>.
          </>
        }
      />

      <form onSubmit={create} className="card grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <div>
          <label className="label" htmlFor="name">
            Nome
          </label>
          <input
            className="input"
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="preset">
            Permissões
          </label>
          <select
            className="input"
            id="preset"
            value={preset}
            onChange={(e) => setPreset(e.target.value as ScopePreset)}
          >
            {(Object.keys(SCOPE_PRESETS) as ScopePreset[]).map((k) => (
              <option key={k} value={k}>
                {SCOPE_PRESETS[k].label}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit">
          Gerar token
        </button>
        {error && <p className="text-sm text-red-600 md:col-span-3">{error}</p>}
      </form>

      {created && (
        <section className="card space-y-4 border-brand-300 dark:border-brand-700">
          <div>
            <h2 className="font-medium">Token criado: {created.name}</h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Copie agora. Por segurança, ele não será exibido de novo.
            </p>
          </div>
          <CopyBlock title="Token" code={created.token} />
          {snippets(created.token).map((s) => (
            <CopyBlock key={s.name} title={s.name} code={s.code} />
          ))}
          <button type="button" className="btn-ghost" onClick={() => setCreated(null)}>
            Fechar
          </button>
        </section>
      )}

      <section className="card overflow-x-auto">
        <h2 className="mb-3 font-medium">Tokens</h2>
        {tokens.length === 0 ? (
          <p className="text-sm text-neutral-500">Nenhum agente conectado ainda.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 font-normal">Nome</th>
                <th className="py-2 font-normal">Prefixo</th>
                <th className="py-2 font-normal">Escopos</th>
                <th className="py-2 font-normal">Último uso</th>
                <th className="py-2 font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {tokens.map((t) => (
                <tr key={t.id} className={t.revoked_at ? "opacity-50" : ""}>
                  <td className="py-2">{t.name}</td>
                  <td className="py-2 font-mono text-xs">{t.prefix}…</td>
                  <td className="py-2 tabular-nums">{t.scopes.length}</td>
                  <td className="py-2">{fmtDate(t.last_used_at)}</td>
                  <td className="py-2 text-right">
                    {t.revoked_at ? (
                      <span className="text-xs">Revogado</span>
                    ) : (
                      <button type="button" className="btn-ghost" onClick={() => revoke(t.id)}>
                        Revogar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
