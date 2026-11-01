"use client";

import type { AutomationRule, MessageTemplate, Post, Segment } from "@ofertas/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DateRange, DateRangePicker, rangeToIso } from "@/components/date-range";
import {
  Badge,
  Chip,
  ChoiceCards,
  Empty,
  Field,
  Loading,
  LoadingButton,
  Tag,
  type Tone,
} from "@/components/ui";
import { api, fmtDate } from "@/lib/api";
import { useCardsEnabled } from "@/lib/prefs";

type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;

const POST_STATUS: Record<string, { label: string; tone: Tone }> = {
  scheduled: { label: "Agendado", tone: "info" },
  sending: { label: "Enviando", tone: "accent" },
  sent: { label: "Enviado", tone: "positive" },
  failed: { label: "Falhou", tone: "negative" },
  skipped: { label: "Pulado", tone: "warning" },
  canceled: { label: "Cancelado", tone: "neutral" },
  deleted: { label: "Apagado", tone: "neutral" },
};

const FILTERS = [
  { value: "scheduled", label: "Agendados" },
  { value: "sent", label: "Enviados" },
  { value: "failed", label: "Com falha" },
  { value: "skipped", label: "Pulados" },
  { value: "", label: "Todos" },
] as const;

// ── Fila ────────────────────────────────────────────────────────

export function Queue({ run, onSchedule }: { run: Runner; onSchedule: () => void }) {
  const [status, setStatus] = useState<string>("scheduled");
  const [items, setItems] = useState<Post[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>({ from: null, to: null });

  const load = useCallback(async () => {
    const q = new URLSearchParams({ limit: "100" });
    if (status) q.set("status", status);
    const iso = rangeToIso(range);
    if (iso.from) q.set("from", iso.from);
    if (iso.to) q.set("to", iso.to);
    setItems((await api<{ items: Post[] }>(`/posts?${q}`)).items);
  }, [status, range]);
  useEffect(() => {
    setItems(null);
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(p: Post, path: "cancel" | "delete-sent") {
    if (path === "delete-sent" && !confirm("Apagar esta mensagem do grupo para todos?")) return;
    setBusy(p.id);
    if (await run(() => api(`/posts/${p.id}/${path}`, { method: "POST" }))) await load();
    setBusy(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Chip key={f.value} on={status === f.value} onClick={() => setStatus(f.value)}>
              {f.label}
            </Chip>
          ))}
        </div>
        <DateRangePicker value={range} onChange={setRange} align="right" />
      </div>
      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>
          {status === "scheduled" ? (
            <>
              Nada agendado.{" "}
              <button type="button" className="underline" onClick={onSchedule}>
                Agendar ofertas
              </button>{" "}
              ou crie uma regra automática.
            </>
          ) : range.from ? (
            "Nada neste período."
          ) : (
            "Nada por aqui."
          )}
        </Empty>
      ) : (
        items.map((p) => {
          const st = POST_STATUS[p.status] ?? { label: p.status, tone: "neutral" as const };
          const expanded = open === p.id;
          return (
            <div key={p.id} className="card space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 text-left text-sm"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : p.id)}
                >
                  {expanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
                  )}
                  <Tag tone={st.tone} dot>
                    {st.label}
                  </Tag>
                  <span className="font-medium">{p.channel_name}</span>
                  <span className="line-clamp-1 text-neutral-500">{p.title ?? "Mensagem"}</span>
                </button>
                <div className="flex items-center gap-2 text-xs text-neutral-500">
                  <span className="tabular-nums">{fmtDate(p.sent_at ?? p.scheduled_at)}</span>
                  {p.rule_id && <Tag>regra</Tag>}
                  {p.status === "scheduled" && (
                    <LoadingButton
                      variant="btn-ghost"
                      busy={busy === p.id}
                      onClick={() => act(p, "cancel")}
                    >
                      Cancelar
                    </LoadingButton>
                  )}
                  {p.status === "sent" && (
                    <LoadingButton
                      variant="btn-ghost"
                      busy={busy === p.id}
                      onClick={() => act(p, "delete-sent")}
                    >
                      Apagar do grupo
                    </LoadingButton>
                  )}
                </div>
              </div>
              {p.error && (
                <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  {p.error}
                </p>
              )}
              {expanded && p.body && (
                <pre className="max-h-60 overflow-auto rounded-lg bg-[#e7ffdb] p-3 text-xs whitespace-pre-wrap text-neutral-900 dark:bg-emerald-950 dark:text-emerald-50">
                  {p.body}
                </pre>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Regras automáticas ──────────────────────────────────────────

const WINDOW_PRESETS = [
  { value: "08:00-12:00", label: "Manhã 8h–12h" },
  { value: "12:00-14:00", label: "Almoço 12h–14h" },
  { value: "14:00-18:00", label: "Tarde 14h–18h" },
  { value: "19:00-23:00", label: "Noite 19h–23h" },
];
const IMAGE_OPTIONS = [
  { value: "card_preco", label: "Card de preço", hint: "Gerado no envio, preço atualizado" },
  { value: "cupom_destaque", label: "Cupom em destaque", hint: "Card com o cupom em evidência" },
  { value: "photo", label: "Foto do produto", hint: "A foto da loja, sem card" },
] as const;
const imageLabel = (v: string | null) =>
  IMAGE_OPTIONS.find((o) => o.value === (v ?? "photo"))?.label ?? "Foto do produto";

const toggleIn = (list: string[], v: string) =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="label">{title}</div>
      {children}
    </div>
  );
}

/** Opções prontas em chips mais um campo para qualquer outro valor (dentro de min–max). */
function NumberPicker({
  value,
  onChange,
  presets,
  min,
  max,
  format,
  unit,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  presets: number[];
  min: number;
  max: number;
  format: (n: number) => string;
  unit: string;
  label: string;
}) {
  const [draft, setDraft] = useState(presets.includes(value) ? "" : String(value));
  const apply = (raw: string) => {
    const n = Math.round(Number(raw));
    if (!raw.trim() || !Number.isFinite(n)) return;
    onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {presets.map((n) => (
        <Chip
          key={n}
          on={value === n}
          onClick={() => {
            setDraft("");
            onChange(n);
          }}
        >
          {format(n)}
        </Chip>
      ))}
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
          presets.includes(value)
            ? "border-neutral-300 dark:border-neutral-700"
            : "border-neutral-900 dark:border-white"
        }`}
      >
        <input
          className="w-12 bg-transparent text-center tabular-nums outline-none"
          inputMode="numeric"
          aria-label={label}
          placeholder="outro"
          value={draft}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "");
            setDraft(digits);
            apply(digits);
          }}
          onBlur={() => setDraft(presets.includes(value) ? "" : String(value))}
        />
        <span className="text-neutral-500">{unit}</span>
      </span>
    </div>
  );
}

const fmtMinutes = (m: number) => (m < 60 || m % 60 ? `${m} min` : `${m / 60} h`);
const HHMM_RANGE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** Cria uma regra ou, com `rule`, edita a existente (abre preenchido). */
function RuleForm({
  segments,
  run,
  rule,
  onDone,
  onCancel,
}: {
  segments: Segment[];
  run: Runner;
  rule?: AutomationRule;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [segIds, setSegIds] = useState<string[]>(
    rule?.segment_ids ?? (segments[0] ? [segments[0].id] : []),
  );
  const [minScore, setMinScore] = useState(rule ? (rule.filters.min_score ?? 0) : 60);
  const [minDiscount, setMinDiscount] = useState<number | null>(rule?.filters.min_discount ?? null);
  const [keywords, setKeywords] = useState(rule?.filters.keywords?.join(", ") ?? "");
  const [windows, setWindows] = useState<string[]>(rule?.windows ?? []);
  const [perDay, setPerDay] = useState(rule?.max_per_day ?? 10);
  const [interval, setIntervalMin] = useState(rule?.min_interval_minutes ?? 30);
  const [image, setImage] = useState<string>(
    rule ? (rule.creative_template ?? "photo") : "card_preco",
  );
  const [busy, setBusy] = useState(false);
  const cards = useCardsEnabled();
  const [customWindow, setCustomWindow] = useState("");
  const windowOk = HHMM_RANGE.test(customWindow.trim());
  const addWindow = () => {
    if (!windowOk) return;
    setWindows((x) => [...new Set([...x, customWindow.trim()])]);
    setCustomWindow("");
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await run(() =>
      api(rule ? `/automation-rules/${rule.id}` : "/automation-rules", {
        method: rule ? "PATCH" : "POST",
        body: {
          name,
          segment_ids: segIds,
          filters: {
            // Mantém filtros que o formulário não mostra (ex.: plataformas definidas por agente).
            ...rule?.filters,
            min_score: minScore,
            min_discount: minDiscount ?? undefined,
            keywords: keywords
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean),
          },
          windows,
          max_per_day: perDay,
          min_interval_minutes: interval,
          creative_template: image === "photo" ? null : image,
        },
      }),
    );
    setBusy(false);
    if (res) onDone();
  }

  return (
    <form onSubmit={submit} className="card space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Nome da regra" htmlFor="rule_name">
          <input
            className="input"
            id="rule_name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tech noturno"
          />
        </Field>
        <Field label="Só ofertas com estas palavras (opcional, vírgula)" htmlFor="rule_kw">
          <input
            className="input"
            id="rule_kw"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="fone, smartwatch"
          />
        </Field>
      </div>
      <Section title="Publicar nos segmentos">
        <div className="flex flex-wrap gap-2">
          {segments.map((s) => (
            <Chip
              key={s.id}
              on={segIds.includes(s.id)}
              onClick={() => setSegIds((x) => toggleIn(x, s.id))}
            >
              {s.name}
              <span className="opacity-60 tabular-nums">· {s.channel_count}</span>
            </Chip>
          ))}
        </div>
      </Section>
      <div className="grid gap-5 md:grid-cols-2">
        <Section title="Nota mínima da oferta">
          <NumberPicker
            label="Outra nota mínima"
            value={minScore}
            onChange={setMinScore}
            presets={[0, 50, 60, 70, 80]}
            min={0}
            max={100}
            format={(n) => (n === 0 ? "Qualquer" : `${n}+`)}
            unit="+"
          />
        </Section>
        <Section title="Desconto mínimo">
          <NumberPicker
            label="Outro desconto mínimo"
            value={minDiscount ?? 0}
            onChange={(n) => setMinDiscount(n || null)}
            presets={[0, 10, 20, 30, 50]}
            min={0}
            max={95}
            format={(n) => (n === 0 ? "Qualquer" : `${n}%+`)}
            unit="%"
          />
        </Section>
        <Section title="Horários">
          <div className="flex flex-wrap gap-2">
            <Chip on={windows.length === 0} onClick={() => setWindows([])}>
              Os das Preferências
            </Chip>
            {[
              ...WINDOW_PRESETS,
              ...windows
                .filter((w) => !WINDOW_PRESETS.some((p) => p.value === w))
                .map((w) => ({ value: w, label: w })),
            ].map((w) => (
              <Chip
                key={w.value}
                on={windows.includes(w.value)}
                onClick={() => setWindows((x) => toggleIn(x, w.value))}
              >
                {w.label}
              </Chip>
            ))}
            <span className="inline-flex items-center gap-1">
              <input
                className="input h-8 w-32 py-1 text-sm"
                aria-label="Outro horário"
                placeholder="06:30-08:00"
                value={customWindow}
                onChange={(e) => setCustomWindow(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addWindow();
                  }
                }}
              />
              <button
                type="button"
                className="btn-ghost h-8 px-2 text-sm"
                disabled={!windowOk}
                onClick={addWindow}
              >
                Adicionar
              </button>
            </span>
          </div>
        </Section>
        <Section title="Ritmo em cada grupo">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-20 text-neutral-500">até</span>
            <NumberPicker
              label="Outro máximo por dia"
              value={perDay}
              onChange={setPerDay}
              presets={[3, 5, 10, 20, 50]}
              min={1}
              max={100}
              format={(n) => `${n}/dia`}
              unit="/dia"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-20 text-neutral-500">uma a cada</span>
            <NumberPicker
              label="Outro intervalo em minutos"
              value={interval}
              onChange={setIntervalMin}
              presets={[1, 5, 15, 30, 60]}
              min={1}
              max={720}
              format={fmtMinutes}
              unit="min"
            />
          </div>
          <p className="text-xs text-neutral-500">
            Envios muito seguidos aumentam o risco de o WhatsApp bloquear o número. O teto de
            mensagens por hora do número continua valendo.
          </p>
        </Section>
      </div>
      <Section title="Imagem">
        {cards === false ? (
          <p className="text-sm text-neutral-500">
            Cards desligados nas Preferências: a regra envia a foto do produto.
          </p>
        ) : (
          <ChoiceCards
            options={IMAGE_OPTIONS}
            value={image as (typeof IMAGE_OPTIONS)[number]["value"]}
            onChange={setImage}
          />
        )}
      </Section>
      <div className="flex gap-2">
        <LoadingButton busy={busy} type="submit" disabled={!segIds.length || !name.trim()}>
          {rule ? "Salvar alterações" : "Criar regra"}
        </LoadingButton>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

export function Rules({ run }: { run: Runner }) {
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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

  async function toggle(r: AutomationRule) {
    setBusy(r.id);
    if (
      await run(() =>
        api(`/automation-rules/${r.id}`, { method: "PATCH", body: { active: !r.active } }),
      )
    )
      await load();
    setBusy(null);
  }

  const segName = (id: string) => segments.find((s) => s.id === id)?.name ?? "?";
  if (!rules) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-neutral-500">
          A cada minuto, dentro dos horários, cada regra agenda a melhor oferta aprovada em cada
          grupo dos segmentos, sem repetir produto por 7 dias.
        </p>
        {!creating && segments.length > 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditingId(null);
              setCreating(true);
            }}
          >
            Nova regra
          </button>
        )}
      </div>
      {segments.length === 0 && (
        <Empty>
          Regras publicam em segmentos. Crie um em{" "}
          <Link className="underline" href="/grupos">
            Grupos
          </Link>{" "}
          primeiro.
        </Empty>
      )}
      {creating && (
        <RuleForm
          segments={segments}
          run={run}
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {rules.length === 0 && segments.length > 0 && !creating && (
        <Empty>Nenhuma regra ainda. Com uma regra, as ofertas aprovadas saem sozinhas.</Empty>
      )}
      {rules.map((r) =>
        editingId === r.id ? (
          <RuleForm
            key={r.id}
            rule={r}
            segments={segments}
            run={run}
            onCancel={() => setEditingId(null)}
            onDone={() => {
              setEditingId(null);
              load();
            }}
          />
        ) : (
          <div key={r.id} className="card flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.name}</span>
                <Badge on={r.active} onLabel="Ativa" offLabel="Pausada" />
              </div>
              <div className="text-neutral-600 dark:text-neutral-400">
                Em {r.segment_ids.map(segName).join(", ")} · ofertas com nota{" "}
                {r.filters.min_score ?? 0}+
                {r.filters.min_discount ? ` e ${r.filters.min_discount}%+ de desconto` : ""}
                {r.filters.keywords?.length ? ` sobre ${r.filters.keywords.join(", ")}` : ""}
              </div>
              <div className="text-xs text-neutral-500">
                Até {r.max_per_day}/dia por grupo, uma a cada {r.min_interval_minutes} min ·{" "}
                {r.windows.length ? r.windows.join(", ") : "horários das Preferências"} ·{" "}
                {imageLabel(r.creative_template)}
                {r.last_run_at && ` · última rodada ${fmtDate(r.last_run_at)}`}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setCreating(false);
                  setEditingId(r.id);
                }}
              >
                Editar
              </button>
              <LoadingButton variant="btn-ghost" busy={busy === r.id} onClick={() => toggle(r)}>
                {r.active ? "Pausar" : "Ativar"}
              </LoadingButton>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

// ── Modelos de mensagem ─────────────────────────────────────────

const VARIABLES = [
  ["titulo", "Título"],
  ["preco", "Preço"],
  ["preco_original", "Preço antigo"],
  ["desconto", "Desconto"],
  ["cupom", "Cupom"],
  ["link", "Link"],
  ["plataforma", "Plataforma"],
  ["loja", "Loja"],
  ["selo", "Selo"],
] as const;

type Draft = { id?: string; name: string; body: string; is_default: boolean };

export function Templates({ run }: { run: Runner }) {
  const [data, setData] = useState<{ builtin_default: string; items: MessageTemplate[] } | null>(
    null,
  );
  const [editing, setEditing] = useState<Draft | null>(null);
  const [sample, setSample] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sample" | "save" | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const load = useCallback(async () => setData(await api("/message-templates")), []);
  useEffect(() => {
    load();
  }, [load]);

  function insert(v: string) {
    if (!editing) return;
    const el = area.current;
    const token = `{{${v}}}`;
    const start = el?.selectionStart ?? editing.body.length;
    const end = el?.selectionEnd ?? start;
    const body = editing.body.slice(0, start) + token + editing.body.slice(end);
    setEditing({ ...editing, body });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function previewSample() {
    if (!editing) return;
    setBusy("sample");
    const res = await run(() =>
      api<{ preview: { sample: string } }>("/message-templates?dry_run=true", {
        method: "POST",
        body: editing,
      }),
    );
    setBusy(null);
    if (res) setSample(res.preview.sample);
  }

  async function save() {
    if (!editing) return;
    setBusy("save");
    const res = await run(() => api("/message-templates", { method: "POST", body: editing }));
    setBusy(null);
    if (res) {
      setEditing(null);
      setSample(null);
      load();
    }
  }

  if (!data) return <Loading />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {data.items.map((t) => (
          <Chip
            key={t.id}
            on={editing?.id === t.id}
            onClick={() => {
              setSample(null);
              setEditing({ id: t.id, name: t.name, body: t.body, is_default: t.is_default });
            }}
          >
            {t.name}
            {t.is_default && <span className="opacity-60">· padrão</span>}
          </Chip>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() => {
            setSample(null);
            setEditing({
              name: "Meu modelo",
              body: data.builtin_default,
              is_default: !data.items.length,
            });
          }}
        >
          Novo modelo
        </button>
      </div>
      {!editing && (
        <Empty>
          {data.items.length
            ? "Escolha um modelo para editar."
            : "Sem modelos próprios: as mensagens usam o modelo embutido. Crie um para mudar o texto."}
        </Empty>
      )}
      {editing && (
        <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,22rem)]">
          <div className="card space-y-3">
            <input
              className="input font-medium"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              aria-label="Nome do modelo"
            />
            <div className="flex flex-wrap gap-1.5">
              <span className="self-center text-xs text-neutral-500">Inserir:</span>
              {VARIABLES.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  title={`{{${v}}}`}
                  onClick={() => insert(v)}
                  className="rounded-md border border-neutral-200 px-2 py-0.5 text-xs hover:border-neutral-400 dark:border-neutral-700"
                >
                  {label}
                </button>
              ))}
            </div>
            <textarea
              ref={area}
              className="input font-mono text-sm"
              rows={14}
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            />
            <p className="text-xs text-neutral-500">
              Linhas com variável vazia somem (ex.: sem cupom, a linha do cupom não aparece). Para
              variar o texto entre envios, separe versões com uma linha só com ---.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editing.is_default}
                onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
              />
              Usar como padrão
            </label>
            <div className="flex gap-2">
              <LoadingButton variant="btn-ghost" busy={busy === "sample"} onClick={previewSample}>
                Ver exemplo
              </LoadingButton>
              <LoadingButton busy={busy === "save"} onClick={save}>
                Salvar
              </LoadingButton>
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
                Cancelar
              </button>
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-neutral-500">Exemplo com uma oferta</div>
            {sample ? (
              <pre className="rounded-lg bg-[#e7ffdb] p-3 text-sm whitespace-pre-wrap text-neutral-900 dark:bg-emerald-950 dark:text-emerald-50">
                {sample}
              </pre>
            ) : (
              <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">
                Clique em “Ver exemplo” para ver como a mensagem fica.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
