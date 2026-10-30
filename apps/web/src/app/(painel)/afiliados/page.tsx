"use client";

import type { AffiliateAccount } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { Badge, ErrorText, Field } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

type Platforms = { credential_fields: Record<string, { key: string; label: string }[]> };

const PLATFORM_LABEL: Record<string, string> = {
  shopee: "Shopee",
  amazon: "Amazon",
  mercadolivre: "Mercado Livre",
  magalu: "Magazine Luiza",
};

export default function AfiliadosPage() {
  const [accounts, setAccounts] = useState<AffiliateAccount[]>([]);
  const [fields, setFields] = useState<Platforms["credential_fields"]>({});
  const [mode, setMode] = useState<"live" | "fake">("fake");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [acc, plat] = await Promise.all([
      api<AffiliateAccount[]>("/affiliate-accounts"),
      api<Platforms>("/affiliate-accounts/platforms"),
    ]);
    setAccounts(acc);
    setFields(plat.credential_fields);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const form = e.currentTarget;
    const f = new FormData(form);
    const platform = String(f.get("platform"));
    const credentials = Object.fromEntries(
      (fields[platform] ?? []).map((c) => [c.key, String(f.get(`cred_${c.key}`) ?? "").trim()]),
    );
    try {
      await api("/affiliate-accounts", {
        method: "POST",
        body: {
          platform,
          label: f.get("label"),
          mode,
          ...(mode === "live" ? { credentials } : {}),
        },
      });
      form.reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(a: AffiliateAccount) {
    await api(`/affiliate-accounts/${a.id}`, {
      method: "PATCH",
      body: { status: a.status === "disabled" ? "active" : "disabled" },
    });
    await load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Contas de afiliado</h1>
        <p className="mt-1 text-sm text-neutral-500">
          As credenciais ficam cifradas no servidor e nunca são mostradas a agentes.
        </p>
      </div>

      <form onSubmit={connect} className="card grid gap-4 md:grid-cols-2">
        <h2 className="font-medium md:col-span-2">Conectar conta</h2>
        <Field label="Plataforma" htmlFor="platform">
          <select className="input" id="platform" name="platform" defaultValue="shopee">
            <option value="shopee">Shopee</option>
          </select>
        </Field>
        <Field label="Nome" htmlFor="label">
          <input className="input" id="label" name="label" required defaultValue="Shopee" />
        </Field>
        <div className="flex gap-4 text-sm md:col-span-2">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "fake"} onChange={() => setMode("fake")} />
            Simulado (catálogo de teste, sem credenciais)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "live"} onChange={() => setMode("live")} />
            Real (API de Afiliados)
          </label>
        </div>
        {mode === "live" &&
          (fields.shopee ?? []).map((c) => (
            <Field key={c.key} label={c.label} htmlFor={`cred_${c.key}`}>
              <input
                className="input font-mono"
                id={`cred_${c.key}`}
                name={`cred_${c.key}`}
                type={c.key === "secret" ? "password" : "text"}
                autoComplete="off"
                required
              />
            </Field>
          ))}
        <div className="md:col-span-2">
          <ErrorText error={error} />
          <button className="btn mt-2" type="submit" disabled={saving}>
            {saving ? "Testando conexão…" : "Conectar"}
          </button>
        </div>
      </form>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 font-medium">Contas</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-neutral-500">Nenhuma conta conectada.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 font-normal">Conta</th>
                <th className="py-2 font-normal">Modo</th>
                <th className="py-2 font-normal">Status</th>
                <th className="py-2 font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="py-2">
                    <div>{a.label}</div>
                    <div className="text-xs text-neutral-500">{PLATFORM_LABEL[a.platform]}</div>
                  </td>
                  <td className="py-2">{a.mode === "fake" ? "Simulado" : "Real"}</td>
                  <td className="py-2">
                    {a.status === "error" ? (
                      <span className="text-sm text-red-600" title={a.last_error ?? ""}>
                        Erro: {a.last_error}
                      </span>
                    ) : (
                      <Badge on={a.status === "active"} onLabel="Ativa" offLabel="Desativada" />
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <button type="button" className="btn-ghost" onClick={() => toggle(a)}>
                      {a.status === "disabled" ? "Ativar" : "Desativar"}
                    </button>
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
