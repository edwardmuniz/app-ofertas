"use client";

import type { ConnectionState, MessagingAccount } from "@ofertas/contracts";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChoiceCards, ErrorText, Field, PageHeader } from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";
import { ImportPanel } from "./import-panel";
import { JoinPanel, TeamPanel } from "./team-panel";

const STATUS: Record<string, { label: string; cls: string }> = {
  connected: {
    label: "Conectado",
    cls: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  },
  pending: {
    label: "Aguardando conexão",
    cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  },
  disconnected: {
    label: "Desconectado",
    cls: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-400",
  },
  logged_out: {
    label: "Deslogado",
    cls: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-400",
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

  // Próxima consulta só depois da anterior terminar (a Evolution Go pode segurar a resposta).
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await poll();
      if (!stop && !doneRef.current) t = setTimeout(loop, 2000);
    };
    loop();
    return () => {
      stop = true;
      clearTimeout(t);
    };
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
  const [importing, setImporting] = useState<string | null>(null);
  const [provider, setProvider] = useState<"evolution_go" | "fake">("evolution_go");
  const [joining, setJoining] = useState<string | null>(null);
  /** Número sendo removido (card esmaecido) e o que acabou de sair (card sumindo). */
  const [removing, setRemoving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async () => setAccounts(await api<MessagingAccount[]>("/whatsapp/accounts")),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function remove(a: MessagingAccount) {
    setError(null);
    setMsg(null);
    try {
      const prev = await api<{
        preview: { channels_kept: number; scheduled_posts_canceled: number };
      }>(`/whatsapp/accounts/${a.id}?dry_run=true`, { method: "DELETE" });
      const { channels_kept: kept, scheduled_posts_canceled: posts } = prev.preview;
      const text = [
        `Remover "${a.label}" da plataforma e da Evolution Go?`,
        kept ? `${kept} grupo(s) continuam como canais, sem número ligado.` : null,
        posts ? `${posts} publicação(ões) agendada(s) serão canceladas.` : null,
      ]
        .filter(Boolean)
        .join("\n");
      if (!confirm(text)) return;
      setRemoving(a.id);
      await api(`/whatsapp/accounts/${a.id}`, { method: "DELETE" });
      if (connecting === a.id) setConnecting(null);
      setLeaving(a.id);
      setMsg(`"${a.label}" removido.`);
      // Deixa o card sumir antes de tirá-lo da lista.
      await new Promise((ok) => setTimeout(ok, 300));
      setAccounts((list) => list.filter((x) => x.id !== a.id));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao remover.");
    } finally {
      setRemoving(null);
      setLeaving(null);
    }
  }

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
        body: { label: f.get("label"), provider },
      });
      if (res.result) setConnecting(res.result.id);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="WhatsApp"
        subtitle={
          <>Use um número dedicado às ofertas. Aqueça o número antes de enviar muito volume.</>
        }
      />

      <form onSubmit={create} className="card grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <Field label="Nome do número" htmlFor="label">
          <input className="input" id="label" name="label" required defaultValue="Ofertas" />
        </Field>
        <button className="btn" type="submit">
          Conectar número
        </button>
        <div className="md:col-span-2">
          <ChoiceCards
            columns={2}
            value={provider}
            onChange={setProvider}
            options={[
              {
                value: "evolution_go",
                label: "Número real",
                hint: "Você lê o QR code com o celular do número das ofertas.",
              },
              {
                value: "fake",
                label: "Simulado",
                hint: "Grupos e envios de mentira, para testar sem um celular.",
              },
            ]}
          />
        </div>
      </form>

      <ErrorText error={error} />
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}

      <div className="space-y-3">
        {accounts.map((a) => {
          const st = STATUS[a.status] ?? { label: a.status, cls: "" };
          return (
            <div
              key={a.id}
              aria-busy={removing === a.id}
              className={`card space-y-3 transition-all duration-300 ${
                leaving === a.id
                  ? "scale-[0.98] opacity-0"
                  : removing === a.id
                    ? "pointer-events-none opacity-60"
                    : ""
              }`}
            >
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
                      <button
                        type="button"
                        className="btn"
                        disabled={importing === a.id}
                        onClick={() => {
                          setMsg(null);
                          setImporting(a.id);
                        }}
                      >
                        Importar grupos
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          setMsg(null);
                          setJoining(a.id);
                        }}
                      >
                        Entrar por link
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
                    <>
                      <button type="button" className="btn" onClick={() => setConnecting(a.id)}>
                        Conectar
                      </button>
                      <button
                        type="button"
                        className="btn-ghost inline-flex items-center gap-1.5"
                        disabled={removing !== null}
                        onClick={() => remove(a)}
                      >
                        {removing === a.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {removing === a.id ? "Removendo…" : "Remover"}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {joining === a.id && a.status === "connected" && (
                <JoinPanel
                  accountId={a.id}
                  onClose={() => setJoining(null)}
                  onDone={(text) => {
                    setJoining(null);
                    setMsg(text);
                    load();
                  }}
                />
              )}
              {importing === a.id && a.status === "connected" && (
                <ImportPanel
                  account={a}
                  onClose={() => setImporting(null)}
                  onDone={(text) => {
                    setImporting(null);
                    setMsg(text);
                    load();
                  }}
                />
              )}
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

      <TeamPanel />
    </div>
  );
}
