"use client";

import type { ConnectionState, MessagingAccount } from "@ofertas/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorText, Field } from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";

const STATUS: Record<string, { label: string; cls: string }> = {
  connected: {
    label: "Conectado",
    cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  },
  pending: {
    label: "Aguardando conexão",
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  },
  disconnected: {
    label: "Desconectado",
    cls: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  },
  logged_out: {
    label: "Deslogado",
    cls: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  },
};

type Mutation<T> = { status: string; result?: T };

function ConnectPanel({ account, onDone }: { account: MessagingAccount; onDone: () => void }) {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [mode, setMode] = useState<"qr" | "code">("qr");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      const s = await api<ConnectionState>(`/whatsapp/accounts/${account.id}/connection`);
      setState(s);
      if (s.account.status === "connected" && !doneRef.current) {
        doneRef.current = true;
        onDone();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao consultar a conexão.");
    }
  }, [account.id, onDone]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);

  async function pair(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const phone = String(new FormData(e.currentTarget).get("phone") ?? "");
    try {
      const r = await api<{ code: string }>(`/whatsapp/accounts/${account.id}/pairing-code`, {
        method: "POST",
        body: { phone },
      });
      setCode(r.code);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro.");
    }
  }

  if (state?.account.status === "connected") {
    return <p className="text-sm text-emerald-700">✓ Número conectado. Agora importe os grupos.</p>;
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === "qr"} onChange={() => setMode("qr")} /> QR code
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === "code"} onChange={() => setMode("code")} /> Código
          no celular
        </label>
      </div>
      {mode === "qr" ? (
        <div className="space-y-2">
          <p className="text-sm text-neutral-500">
            No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o QR.
          </p>
          {state?.qr_image ? (
            // biome-ignore lint/performance/noImgElement: QR em data URL
            <img
              src={state.qr_image}
              alt="QR code do WhatsApp"
              className="h-64 w-64 rounded bg-white p-2"
            />
          ) : (
            <p className="text-sm text-neutral-500">Gerando QR…</p>
          )}
        </div>
      ) : (
        <form onSubmit={pair} className="space-y-2">
          <p className="text-sm text-neutral-500">
            No celular: Aparelhos conectados → Conectar um aparelho → Conectar com número de
            telefone.
          </p>
          <div className="flex gap-2">
            <input className="input" name="phone" placeholder="5511999998888" required />
            <button className="btn" type="submit">
              Gerar código
            </button>
          </div>
          {code && <p className="font-mono text-2xl tracking-widest">{code}</p>}
        </form>
      )}
      <ErrorText error={error} />
    </div>
  );
}

export default function WhatsAppPage() {
  const [accounts, setAccounts] = useState<MessagingAccount[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async () => setAccounts(await api<MessagingAccount[]>("/whatsapp/accounts")),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
    }
  }

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      const res = await api<Mutation<MessagingAccount>>("/whatsapp/accounts", {
        method: "POST",
        body: { label: f.get("label"), provider: f.get("provider") },
      });
      if (res.result) setConnecting(res.result.id);
    });
  }

  async function sync(a: MessagingAccount) {
    await run(async () => {
      const res = await api<Mutation<{ created: number; updated: number; invite_errors: number }>>(
        `/whatsapp/accounts/${a.id}/sync-groups`,
        { method: "POST" },
      );
      const r = res.result;
      if (r) {
        setMsg(
          `${r.created} grupo(s) novo(s), ${r.updated} atualizado(s).${r.invite_errors ? ` ${r.invite_errors} sem link de convite (o número precisa ser admin).` : ""} Veja em Grupos.`,
        );
      }
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">WhatsApp</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Use um número dedicado às ofertas. Aqueça o número antes de enviar muito volume.
        </p>
      </div>

      <form onSubmit={create} className="card grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
        <Field label="Nome do número" htmlFor="label">
          <input className="input" id="label" name="label" required defaultValue="Ofertas" />
        </Field>
        <Field label="Tipo" htmlFor="provider">
          <select className="input" id="provider" name="provider" defaultValue="evolution_go">
            <option value="evolution_go">Real (Evolution Go)</option>
            <option value="fake">Simulado (teste)</option>
          </select>
        </Field>
        <button className="btn" type="submit">
          Conectar número
        </button>
      </form>

      <ErrorText error={error} />
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}

      <div className="space-y-3">
        {accounts.map((a) => {
          const st = STATUS[a.status] ?? { label: a.status, cls: "" };
          return (
            <div key={a.id} className="card space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {a.label}{" "}
                    {a.provider === "fake" && (
                      <span className="text-xs text-neutral-500">(simulado)</span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {a.own_jid?.split("@")[0]?.split(":")[0] ?? a.phone ?? "sem número ainda"} ·{" "}
                    {a.channel_count} grupo(s) · último evento {fmtDate(a.last_event_at)}
                  </div>
                  {a.last_error && a.status !== "connected" && (
                    <div className="text-xs text-red-600">{a.last_error}</div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                  {a.status === "connected" ? (
                    <>
                      <button type="button" className="btn" onClick={() => sync(a)}>
                        Importar grupos
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() =>
                          confirm("Desconectar este número?") &&
                          run(() => api(`/whatsapp/accounts/${a.id}/logout`, { method: "POST" }))
                        }
                      >
                        Desconectar
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn" onClick={() => setConnecting(a.id)}>
                      Conectar
                    </button>
                  )}
                </div>
              </div>
              {connecting === a.id && a.status !== "connected" && (
                <ConnectPanel
                  account={a}
                  onDone={() => {
                    setConnecting(null);
                    load();
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
