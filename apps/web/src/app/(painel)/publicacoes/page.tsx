"use client";

import type {
  AutomationRule,
  Channel,
  MessageTemplate,
  Offer,
  Post,
  Segment,
} from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { ErrorText, Field } from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";
import { money } from "@/lib/format";

type Tab = "fila" | "agendar" | "regras" | "modelos";
type Mutation<T> = { status: string; result?: T; preview?: T };
type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;

const POST_STATUS: Record<string, string> = {
  scheduled: "Agendado",
  sending: "Enviando",
  sent: "Enviado",
  failed: "Falhou",
  skipped: "Pulado",
  canceled: "Cancelado",
  deleted: "Apagado",
};

export default function PublicacoesPage() {
  const [tab, setTab] = useState<Tab>("fila");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("offer")) setTab("agendar");
  }, []);

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
      return null;
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "fila", label: "Fila" },
    { key: "agendar", label: "Agendar" },
    { key: "regras", label: "Regras automáticas" },
    { key: "modelos", label: "Modelos" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Publicações</h1>
      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              tab === t.key
                ? "border-emerald-600 font-medium"
                : "border-transparent text-neutral-500"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ErrorText error={error} />
      {tab === "fila" && <Queue run={run} />}
      {tab === "agendar" && <Schedule run={run} onDone={() => setTab("fila")} />}
      {tab === "regras" && <Rules run={run} />}
      {tab === "modelos" && <Templates run={run} />}
    </div>
  );
}

function Queue({ run }: { run: Runner }) {
  const [status, setStatus] = useState("scheduled");
  const [items, setItems] = useState<Post[]>([]);
  const load = useCallback(async () => {
    const q = new URLSearchParams({ limit: "100" });
    if (status) q.set("status", status);
    setItems((await api<{ items: Post[] }>(`/posts?${q}`)).items);
  }, [status]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-3">
      <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Todos</option>
        {Object.entries(POST_STATUS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      {items.length === 0 && <p className="card text-sm text-neutral-500">Nada por aqui.</p>}
      {items.map((p) => (
        <div key={p.id} className="card space-y-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <span className="font-medium">{p.channel_name}</span>
              <span className="text-neutral-500">
                {" "}
                · {POST_STATUS[p.status]} · {fmtDate(p.sent_at ?? p.scheduled_at)} · por{" "}
                {p.created_by}
              </span>
            </div>
            <div className="flex gap-1">
              {p.status === "scheduled" && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={async () =>
                    (await run(() => api(`/posts/${p.id}/cancel`, { method: "POST" }))) && load()
                  }
                >
                  Cancelar
                </button>
              )}
              {p.status === "sent" && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={async () =>
                    confirm("Apagar esta mensagem do grupo para todos?") &&
                    (await run(() => api(`/posts/${p.id}/delete-sent`, { method: "POST" }))) &&
                    load()
                  }
                >
                  Apagar do grupo
                </button>
              )}
            </div>
          </div>
          {p.error && <p className="text-xs text-amber-700">{p.error}</p>}
          {p.body && (
            <pre className="max-h-40 overflow-auto rounded bg-neutral-50 p-2 text-xs whitespace-pre-wrap dark:bg-neutral-950">
              {p.body}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

type Plan = {
  posts: { channel_name: string; title: string | null; scheduled_at: string; body: string }[];
  skipped: { reason: string }[];
};

function Schedule({ run, onDone }: { run: Runner; onDone: () => void }) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [segmentId, setSegmentId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [at, setAt] = useState("");
  const [spacing, setSpacing] = useState(10);
  const [plan, setPlan] = useState<Plan | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ items: Offer[] }>("/offers?status=approved&limit=100"),
      api<Segment[]>("/segments"),
      api<Channel[]>("/channels"),
    ]).then(([o, s, c]) => {
      setOffers(o.items);
      setSegments(s);
      setChannels(c.filter((x) => x.messaging_account_id));
      const pre = new URLSearchParams(window.location.search).get("offer");
      if (pre) setSelected([pre]);
    });
  }, []);

  const body = () => ({
    offer_ids: selected,
    ...(segmentId ? { segment_ids: [segmentId] } : {}),
    ...(channelId ? { channel_ids: [channelId] } : {}),
    ...(at ? { at: new Date(at).toISOString() } : {}),
    spacing_minutes: spacing,
  });

  async function preview() {
    const res = await run(() =>
      api<Mutation<Plan>>("/posts?dry_run=true", { method: "POST", body: body() }),
    );
    if (res?.preview) setPlan(res.preview);
  }

  async function confirmSchedule() {
    const res = await run(() => api<Mutation<unknown>>("/posts", { method: "POST", body: body() }));
    if (res?.status === "done") onDone();
  }

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <h2 className="font-medium">1. Ofertas aprovadas</h2>
        {offers.length === 0 && (
          <p className="text-sm text-neutral-500">Aprove ofertas em Ofertas primeiro.</p>
        )}
        <div className="max-h-72 space-y-1 overflow-auto">
          {offers.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => toggle(o.id)}
              />
              <span className="tabular-nums text-neutral-500">{o.score}</span>
              <span className="line-clamp-1 flex-1">{o.title}</span>
              <span className="tabular-nums">{money(o.price)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="card grid gap-3 md:grid-cols-4">
        <h2 className="font-medium md:col-span-4">2. Onde e quando</h2>
        <Field label="Segmento" htmlFor="seg">
          <select
            className="input"
            id="seg"
            value={segmentId}
            onChange={(e) => setSegmentId(e.target.value)}
          >
            <option value="">—</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.channel_count})
              </option>
            ))}
          </select>
        </Field>
        <Field label="ou um grupo" htmlFor="ch">
          <select
            className="input"
            id="ch"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
          >
            <option value="">—</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Começar em (vazio = agora)" htmlFor="at">
          <input
            className="input"
            id="at"
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
        </Field>
        <Field label="Intervalo no grupo (min)" htmlFor="sp">
          <input
            className="input"
            id="sp"
            type="number"
            min={1}
            value={spacing}
            onChange={(e) => setSpacing(Number(e.target.value))}
          />
        </Field>
        <div className="md:col-span-4">
          <button
            type="button"
            className="btn"
            disabled={!selected.length || (!segmentId && !channelId)}
            onClick={preview}
          >
            Ver plano
          </button>
        </div>
      </div>

      {plan && (
        <div className="card space-y-3">
          <h2 className="font-medium">3. Confirme</h2>
          {plan.posts.map((p) => (
            <div key={`${p.channel_name}-${p.scheduled_at}`} className="text-sm">
              <div>
                <strong>{fmtDate(p.scheduled_at)}</strong> · {p.channel_name} · {p.title}
              </div>
            </div>
          ))}
          {plan.skipped.map((s) => (
            <p key={s.reason} className="text-sm text-amber-700">
              Pulado: {s.reason}
            </p>
          ))}
          {plan.posts[0] && (
            <pre className="rounded bg-neutral-50 p-2 text-xs whitespace-pre-wrap dark:bg-neutral-950">
              {plan.posts[0].body}
            </pre>
          )}
          <button
            type="button"
            className="btn"
            disabled={!plan.posts.length}
            onClick={confirmSchedule}
          >
            Agendar {plan.posts.length} publicação(ões)
          </button>
        </div>
      )}
    </div>
  );
}

function Rules({ run }: { run: Runner }) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const load = useCallback(async () => {
    const [r, s] = await Promise.all([
      api<AutomationRule[]>("/automation-rules"),
      api<Segment[]>("/segments"),
    ]);
    setRules(r);
    setSegments(s);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const list = (k: string) =>
      String(f.get(k) ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
    const res = await run(() =>
      api("/automation-rules", {
        method: "POST",
        body: {
          name: f.get("name"),
          segment_ids: [f.get("segment")],
          filters: {
            min_score: num("min_score"),
            min_discount: num("min_discount"),
            keywords: list("keywords"),
          },
          windows: list("windows"),
          max_per_day: num("max_per_day") ?? 10,
          min_interval_minutes: num("interval") ?? 30,
        },
      }),
    );
    if (res) {
      form.reset();
      load();
    }
  }

  const segName = (id: string) => segments.find((s) => s.id === id)?.name ?? "?";

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500">
        A cada minuto, dentro das janelas, cada regra agenda a melhor oferta aprovada em cada grupo
        do segmento, sem repetir produto por 7 dias.
      </p>
      <form onSubmit={create} className="card grid gap-3 md:grid-cols-3">
        <Field label="Nome" htmlFor="name">
          <input className="input" id="name" name="name" required placeholder="Tech noturno" />
        </Field>
        <Field label="Segmento" htmlFor="segment">
          <select className="input" id="segment" name="segment" required>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Palavras-chave (vírgula)" htmlFor="keywords">
          <input className="input" id="keywords" name="keywords" placeholder="fone, smartwatch" />
        </Field>
        <Field label="Nota mínima" htmlFor="min_score">
          <input
            className="input"
            id="min_score"
            name="min_score"
            type="number"
            min={0}
            max={100}
            defaultValue={60}
          />
        </Field>
        <Field label="Desconto mínimo %" htmlFor="min_discount">
          <input
            className="input"
            id="min_discount"
            name="min_discount"
            type="number"
            min={0}
            max={95}
          />
        </Field>
        <Field label="Janelas (ex.: 20:00-23:00)" htmlFor="windows">
          <input className="input" id="windows" name="windows" placeholder="vazio = preferências" />
        </Field>
        <Field label="Máx. por dia por grupo" htmlFor="max_per_day">
          <input
            className="input"
            id="max_per_day"
            name="max_per_day"
            type="number"
            min={1}
            defaultValue={10}
          />
        </Field>
        <Field label="Intervalo mínimo (min)" htmlFor="interval">
          <input
            className="input"
            id="interval"
            name="interval"
            type="number"
            min={5}
            defaultValue={30}
          />
        </Field>
        <div className="flex items-end">
          <button className="btn" type="submit" disabled={!segments.length}>
            Criar regra
          </button>
        </div>
      </form>
      {rules.map((r) => (
        <div
          key={r.id}
          className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
        >
          <div>
            <div className="font-medium">{r.name}</div>
            <div className="text-xs text-neutral-500">
              {r.segment_ids.map(segName).join(", ")} · até {r.max_per_day}/dia · a cada{" "}
              {r.min_interval_minutes} min
              {r.filters.keywords?.length ? ` · ${r.filters.keywords.join(", ")}` : ""}
              {r.filters.min_score ? ` · nota ≥ ${r.filters.min_score}` : ""}
              {r.windows.length ? ` · ${r.windows.join(", ")}` : ""}
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={async () =>
              (await run(() =>
                api(`/automation-rules/${r.id}`, { method: "PATCH", body: { active: !r.active } }),
              )) && load()
            }
          >
            {r.active ? "Pausar" : "Ativar"}
          </button>
        </div>
      ))}
    </div>
  );
}

function Templates({ run }: { run: Runner }) {
  const [data, setData] = useState<{ builtin_default: string; items: MessageTemplate[] } | null>(
    null,
  );
  const [editing, setEditing] = useState<{
    id?: string;
    name: string;
    body: string;
    is_default: boolean;
  } | null>(null);
  const [sample, setSample] = useState<string | null>(null);
  const load = useCallback(async () => setData(await api("/message-templates")), []);
  useEffect(() => {
    load();
  }, [load]);

  async function previewSample() {
    if (!editing) return;
    const res = await run(() =>
      api<{ preview: { sample: string } }>("/message-templates?dry_run=true", {
        method: "POST",
        body: editing,
      }),
    );
    if (res) setSample(res.preview.sample);
  }

  async function save() {
    if (!editing) return;
    const res = await run(() => api("/message-templates", { method: "POST", body: editing }));
    if (res) {
      setEditing(null);
      setSample(null);
      load();
    }
  }

  if (!data) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500">
        Variáveis:{" "}
        {
          "{{titulo}} {{preco}} {{preco_original}} {{desconto}} {{cupom}} {{link}} {{plataforma}} {{loja}} {{selo}}"
        }
        . Linhas com variável vazia somem. Separe variações com uma linha só com ---.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn"
          onClick={() =>
            setEditing({ name: "Meu modelo", body: data.builtin_default, is_default: true })
          }
        >
          Novo modelo
        </button>
        {data.items.map((t) => (
          <button
            key={t.id}
            type="button"
            className="btn-ghost"
            onClick={() =>
              setEditing({ id: t.id, name: t.name, body: t.body, is_default: t.is_default })
            }
          >
            {t.name} {t.is_default ? "★" : ""}
          </button>
        ))}
      </div>
      {editing && (
        <div className="card space-y-3">
          <input
            className="input"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
          <textarea
            className="input font-mono"
            rows={14}
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editing.is_default}
              onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
            />
            Usar como padrão
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={previewSample}>
              Ver exemplo
            </button>
            <button type="button" className="btn" onClick={save}>
              Salvar
            </button>
          </div>
          {sample && (
            <pre className="rounded bg-neutral-50 p-2 text-sm whitespace-pre-wrap dark:bg-neutral-950">
              {sample}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
