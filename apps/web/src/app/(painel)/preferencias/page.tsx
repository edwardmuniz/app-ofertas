"use client";

import type { Preferences } from "@ofertas/contracts";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

const toList = (s: string) =>
  s
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);

export default function PreferenciasPage() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<Preferences>("/workspace/preferences").then(setPrefs);
  }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Preferences = {
      tone_of_voice: String(f.get("tone_of_voice") ?? ""),
      niches: toList(String(f.get("niches") ?? "")),
      posting_windows: toList(String(f.get("posting_windows") ?? "")),
      forbidden: toList(String(f.get("forbidden") ?? "")),
      notes: String(f.get("notes") ?? ""),
      alert_webhook_url: String(f.get("alert_webhook_url") ?? "").trim() || null,
    };
    try {
      const res = await api<{ status: string; result?: Preferences }>("/workspace/preferences", {
        method: "PATCH",
        body,
      });
      if (res.result) setPrefs(res.result);
      setMsg({ ok: true, text: "Preferências salvas." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Erro ao salvar." });
    }
  }

  if (!prefs) return <p className="text-sm text-neutral-500">Carregando…</p>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Preferências do negócio"
        subtitle={<>Agentes conectados leem estas orientações antes de agir.</>}
      />
      <form onSubmit={save} className="card space-y-4">
        <div>
          <label className="label" htmlFor="tone_of_voice">
            Tom de voz
          </label>
          <textarea
            className="input"
            id="tone_of_voice"
            name="tone_of_voice"
            rows={2}
            defaultValue={prefs.tone_of_voice}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="niches">
              Nichos (separados por vírgula)
            </label>
            <input
              className="input"
              id="niches"
              name="niches"
              defaultValue={prefs.niches?.join(", ")}
            />
          </div>
          <div>
            <label className="label" htmlFor="posting_windows">
              Janelas de envio (ex.: 08:00-12:00)
            </label>
            <input
              className="input"
              id="posting_windows"
              name="posting_windows"
              defaultValue={prefs.posting_windows?.join(", ")}
            />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="forbidden">
            Nunca publicar (uma por linha)
          </label>
          <textarea
            className="input"
            id="forbidden"
            name="forbidden"
            rows={3}
            defaultValue={prefs.forbidden?.join("\n")}
          />
        </div>
        <div>
          <label className="label" htmlFor="notes">
            Outras orientações
          </label>
          <textarea className="input" id="notes" name="notes" rows={4} defaultValue={prefs.notes} />
        </div>
        <div>
          <label className="label" htmlFor="alert_webhook_url">
            Webhook de alertas (opcional)
          </label>
          <input
            className="input"
            id="alert_webhook_url"
            name="alert_webhook_url"
            type="url"
            placeholder="https://ntfy.sh/meu-topico-secreto"
            defaultValue={prefs.alert_webhook_url ?? ""}
          />
          <p className="mt-1 text-xs text-neutral-500">
            Recebe aviso quando o número cai ou a fila para. Funciona com ntfy (notificação no
            celular), Discord e Slack.
          </p>
        </div>
        {msg && (
          <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</p>
        )}
        <button className="btn" type="submit">
          Salvar
        </button>
      </form>
    </div>
  );
}
