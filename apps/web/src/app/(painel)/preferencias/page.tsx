"use client";

import type { Preferences } from "@ofertas/contracts";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Chip, Loading, LoadingButton, PageHeader } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

const toList = (s: string) =>
  s
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);

const WINDOW_PRESETS = [
  { value: "08:00-12:00", label: "Manhã 8h–12h" },
  { value: "12:00-14:00", label: "Almoço 12h–14h" },
  { value: "14:00-18:00", label: "Tarde 14h–18h" },
  { value: "19:00-23:00", label: "Noite 19h–23h" },
];

/** Lista de palavras como etiquetas: digita e Enter (ou vírgula) adiciona. */
function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw = draft) => {
    const v = raw.trim().replace(/,$/, "").trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="input flex min-h-10 flex-wrap items-center gap-1.5 py-1.5">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-sm dark:bg-neutral-800"
        >
          {v}
          <button
            type="button"
            aria-label={`Tirar ${v}`}
            className="text-neutral-500 hover:text-red-600"
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-32 flex-1 bg-transparent text-sm outline-none"
        value={draft}
        placeholder={values.length ? "" : placeholder}
        onChange={(e) => {
          if (e.target.value.endsWith(",")) add(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
          if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={() => add()}
      />
    </div>
  );
}

export default function PreferenciasPage() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [niches, setNiches] = useState<string[]>([]);
  const [windows, setWindows] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Preferences>("/workspace/preferences").then((p) => {
      setPrefs(p);
      setNiches(p.niches ?? []);
      setWindows(p.posting_windows ?? []);
    });
  }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Preferences = {
      tone_of_voice: String(f.get("tone_of_voice") ?? ""),
      niches,
      posting_windows: windows,
      forbidden: toList(String(f.get("forbidden") ?? "")),
      notes: String(f.get("notes") ?? ""),
      alert_webhook_url: String(f.get("alert_webhook_url") ?? "").trim() || null,
    };
    setSaving(true);
    setMsg(null);
    try {
      const res = await api<{ status: string; result?: Preferences }>("/workspace/preferences", {
        method: "PATCH",
        body,
      });
      if (res.result) setPrefs(res.result);
      setMsg({ ok: true, text: "Preferências salvas." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Erro ao salvar." });
    } finally {
      setSaving(false);
    }
  }

  if (!prefs) return <Loading />;

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
        <div>
          <div className="label">Nichos</div>
          <TagInput
            values={niches}
            onChange={setNiches}
            placeholder="casa, tech, beleza… (Enter adiciona)"
          />
        </div>
        <div className="space-y-1.5">
          <div className="label">Horários de envio</div>
          <div className="flex flex-wrap gap-2">
            {WINDOW_PRESETS.map((w) => (
              <Chip
                key={w.value}
                on={windows.includes(w.value)}
                onClick={() =>
                  setWindows((x) =>
                    x.includes(w.value) ? x.filter((v) => v !== w.value) : [...x, w.value],
                  )
                }
              >
                {w.label}
              </Chip>
            ))}
          </div>
          <TagInput
            values={windows.filter((w) => !WINDOW_PRESETS.some((p) => p.value === w))}
            onChange={(custom) =>
              setWindows([
                ...windows.filter((w) => WINDOW_PRESETS.some((p) => p.value === w)),
                ...custom,
              ])
            }
            placeholder="Outro horário, ex.: 06:30-08:00"
          />
          <p className="text-xs text-neutral-500">
            Publicações e regras só saem nesses horários. Sem nenhum, sai a qualquer hora.
          </p>
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
        <LoadingButton busy={saving} type="submit">
          Salvar
        </LoadingButton>
      </form>
    </div>
  );
}
