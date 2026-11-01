"use client";

import {
  type ApiToken,
  type CreatedToken,
  SCOPE_PRESETS,
  type ScopePreset,
} from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  ChoiceCards,
  Empty,
  ErrorText,
  Loading,
  LoadingButton,
  PageHeader,
  Segmented,
  Tag,
} from "@/components/ui";
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

/** O que cada nível de permissão deixa o agente fazer (em linguagem do dia a dia). */
const PRESET_HINTS: Record<ScopePreset, string> = {
  read_only: "Só consulta: métricas, ofertas, grupos e a fila. Não muda nada.",
  operation: "Busca e aprova ofertas, agenda posts, cria links e cards.",
  full_no_spend: "Tudo, menos anúncios pagos. Recomendado para agentes do dia a dia.",
  full: "Tudo, inclusive gastar com anúncios.",
};

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
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [client, setClient] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
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
    setBusy("create");
    try {
      const t = await api<CreatedToken>("/tokens", { method: "POST", body: { name, preset } });
      setCreated(t);
      setClient(0);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao criar token.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(t: ApiToken) {
    if (!confirm(`Revogar "${t.name}"? O agente perde o acesso na hora.`)) return;
    setError(null);
    setBusy(t.id);
    try {
      await api(`/tokens/${t.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao revogar.");
    } finally {
      setBusy(null);
    }
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

      <form onSubmit={create} className="card space-y-4">
        <div className="max-w-sm">
          <label className="label" htmlFor="name">
            Nome do agente
          </label>
          <input
            className="input"
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Claude do escritório"
          />
        </div>
        <div className="space-y-1.5">
          <div className="label">O que ele pode fazer</div>
          <ChoiceCards
            columns={4}
            value={preset}
            onChange={setPreset}
            options={(Object.keys(SCOPE_PRESETS) as ScopePreset[]).map((k) => ({
              value: k,
              label: SCOPE_PRESETS[k].label.replace(/ \(.*\)$/, ""),
              hint: PRESET_HINTS[k],
            }))}
          />
          <p className="text-xs text-neutral-500">
            Conectar números de WhatsApp, criar grupos e mexer em participantes continuam só com
            você, no painel.
          </p>
        </div>
        <ErrorText error={error} />
        <LoadingButton busy={busy === "create"} type="submit">
          Gerar token
        </LoadingButton>
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
          <div className="space-y-2">
            <div className="text-sm font-medium">Como conectar</div>
            <div className="overflow-x-auto">
              <Segmented
                options={snippets(created.token).map((sn, i) => ({
                  value: String(i),
                  label: sn.name.replace(/ \(.*\)$/, ""),
                }))}
                value={String(client)}
                onChange={(v) => setClient(Number(v))}
              />
            </div>
            {(() => {
              const sn = snippets(created.token)[client];
              return sn ? <CopyBlock title={sn.name} code={sn.code} /> : null;
            })()}
          </div>
          <button type="button" className="btn-ghost" onClick={() => setCreated(null)}>
            Fechar
          </button>
        </section>
      )}

      <section className="card overflow-x-auto">
        <h2 className="mb-3 font-medium">Tokens</h2>
        {!tokens ? (
          <Loading />
        ) : tokens.length === 0 ? (
          <Empty>Nenhum agente conectado ainda. Gere um token acima.</Empty>
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
                      <Tag>Revogado</Tag>
                    ) : (
                      <LoadingButton
                        variant="btn-ghost"
                        busy={busy === t.id}
                        onClick={() => revoke(t)}
                      >
                        Revogar
                      </LoadingButton>
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
