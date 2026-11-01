"use client";

import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Datas no formato AAAA-MM-DD (dia local). */
export type DateRange = { from: string | null; to: string | null };

const MONTHS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];
const WEEK = [
  ["dom", "D"],
  ["seg", "S"],
  ["ter", "T"],
  ["qua", "Q"],
  ["qui", "Q"],
  ["sex", "S"],
  ["sab", "S"],
] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const show = (k: string | null) => {
  if (!k) return "";
  const [y, m, d] = k.split("-");
  return `${d}/${m}/${y}`;
};

/** Converte o período em instantes ISO (início do dia "de" até o fim do dia "até"), no fuso local. */
export function rangeToIso(r: DateRange) {
  return {
    from: r.from ? parse(r.from).toISOString() : undefined,
    to: r.to ? addDays(parse(r.to), 1).toISOString() : undefined,
  };
}

function presets(): { label: string; range: () => DateRange }[] {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  return [
    { label: "Hoje", range: () => ({ from: key(today), to: key(today) }) },
    {
      label: "Ontem",
      range: () => ({ from: key(addDays(today, -1)), to: key(addDays(today, -1)) }),
    },
    { label: "Últimos 7 dias", range: () => ({ from: key(addDays(today, -6)), to: key(today) }) },
    { label: "Últimos 30 dias", range: () => ({ from: key(addDays(today, -29)), to: key(today) }) },
    {
      label: "Este mês",
      range: () => ({ from: key(new Date(y, m, 1)), to: key(new Date(y, m + 1, 0)) }),
    },
    {
      label: "Mês passado",
      range: () => ({ from: key(new Date(y, m - 1, 1)), to: key(new Date(y, m, 0)) }),
    },
    {
      label: "Este ano",
      range: () => ({ from: key(new Date(y, 0, 1)), to: key(new Date(y, 11, 31)) }),
    },
    {
      label: "Ano passado",
      range: () => ({ from: key(new Date(y - 1, 0, 1)), to: key(new Date(y - 1, 11, 31)) }),
    },
  ];
}

function Month({
  year,
  month,
  range,
  hover,
  onPick,
  onHover,
}: {
  year: number;
  month: number;
  range: DateRange;
  hover: string | null;
  onPick: (k: string) => void;
  onHover: (k: string | null) => void;
}) {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const today = key(new Date());
  // Enquanto escolhe o fim, o intervalo acompanha o mouse.
  const end = range.from && !range.to ? hover : range.to;
  const lo = range.from && end && end < range.from ? end : range.from;
  const hi = range.from && end && end < range.from ? range.from : end;
  const cells = Array.from({ length: days }, (_, i) => key(new Date(year, month, i + 1)));
  return (
    <div className="grid grid-cols-7 gap-y-1 text-center text-sm">
      {WEEK.map(([id, w]) => (
        <div key={id} className="py-1 text-xs font-medium text-neutral-500">
          {w}
        </div>
      ))}
      {cells.map((k, i) => {
        const edge = k === lo || k === hi;
        const inside = lo && hi && k > lo && k < hi;
        return (
          <div
            key={k}
            className={inside ? "bg-brand-500/10" : ""}
            // O primeiro dia começa na coluna do dia da semana.
            style={i === 0 ? { gridColumnStart: first.getDay() + 1 } : undefined}
          >
            <button
              type="button"
              onClick={() => onPick(k)}
              onMouseEnter={() => onHover(k)}
              className={`mx-auto flex h-9 w-9 items-center justify-center rounded-full tabular-nums transition-colors ${
                edge
                  ? "bg-brand-500 font-semibold text-white"
                  : k === today
                    ? "ring-1 ring-brand-500"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              {Number(k.slice(8))}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Seletor de período: atalhos (Hoje, Últimos 7 dias…) e dois meses lado a lado.
 * Primeiro clique escolhe o início, o segundo o fim.
 */
export function DateRangePicker({
  value,
  onChange,
  label = "Período",
  align = "left",
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  label?: string;
  /** Lado em que o calendário abre (use "right" quando o campo fica à direita da tela) */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  const [hover, setHover] = useState<string | null>(null);
  const base = value.from ? parse(value.from) : new Date();
  const [view, setView] = useState({ y: base.getFullYear(), m: base.getMonth() });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(value);
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open, value]);

  const apply = (r: DateRange) => {
    onChange(r);
    setOpen(false);
  };
  const pick = (k: string) => {
    if (!draft.from || draft.to) return setDraft({ from: k, to: null });
    apply(k < draft.from ? { from: k, to: draft.from } : { from: draft.from, to: k });
  };
  const next = new Date(view.y, view.m + 1, 1);
  const shift = (n: number) => {
    const d = new Date(view.y, view.m + n, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };
  const years = Array.from({ length: 8 }, (_, i) => new Date().getFullYear() - 5 + i);
  const empty = !value.from && !value.to;

  return (
    <div ref={box} className="relative w-full max-w-md">
      <div className="mb-1 text-xs font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </div>
      <div
        className={`flex h-10 w-full items-center gap-2 rounded-lg border bg-white px-3 text-sm dark:bg-neutral-900 ${
          open ? "border-brand-500" : "border-neutral-300 dark:border-neutral-700"
        }`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className={`flex-1 ${value.from ? "" : "text-neutral-400"}`}>
            {show(value.from) || "dd/mm/aaaa"}
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-neutral-400" />
          <span className={`flex-1 ${value.to ? "" : "text-neutral-400"}`}>
            {show(value.to) || "dd/mm/aaaa"}
          </span>
        </button>
        {empty ? (
          <CalendarDays className="h-4 w-4 shrink-0 text-neutral-400" />
        ) : (
          <button
            type="button"
            aria-label="Limpar período"
            className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            onClick={() => onChange({ from: null, to: null })}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {open && (
        <div
          className={`absolute top-full ${align === "right" ? "right-0" : "left-0"} z-30 mt-2 flex w-[min(92vw,760px)] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl md:flex-row dark:border-neutral-800 dark:bg-neutral-900`}
        >
          <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 p-2 md:w-44 md:flex-col md:border-r md:border-b-0 dark:border-neutral-800">
            {presets().map((p) => (
              <button
                key={p.label}
                type="button"
                className="rounded-md px-3 py-2 text-left text-sm whitespace-nowrap hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onClick={() => apply(p.range())}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex-1 p-4">
            <div className="mb-3 text-center text-xs font-medium tracking-wide text-neutral-500 uppercase">
              {draft.from && !draft.to ? "Escolha a data final" : "Escolha a data inicial"}
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    aria-label="Mês anterior"
                    className="rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    onClick={() => shift(-1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <div className="flex gap-1">
                    <select
                      className="bg-transparent text-sm font-semibold"
                      value={view.m}
                      aria-label="Mês"
                      onChange={(e) => setView((v) => ({ ...v, m: Number(e.target.value) }))}
                    >
                      {MONTHS.map((n, i) => (
                        <option key={n} value={i}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <select
                      className="bg-transparent text-sm font-semibold"
                      value={view.y}
                      aria-label="Ano"
                      onChange={(e) => setView((v) => ({ ...v, y: Number(e.target.value) }))}
                    >
                      {years.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    aria-label="Próximo mês"
                    className="rounded p-1 hover:bg-neutral-100 md:invisible dark:hover:bg-neutral-800"
                    onClick={() => shift(1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <Month
                  year={view.y}
                  month={view.m}
                  range={draft}
                  hover={hover}
                  onPick={pick}
                  onHover={setHover}
                />
              </div>
              <div className="hidden md:block">
                <div className="mb-2 flex items-center justify-between">
                  <span className="w-6" />
                  <span className="text-sm font-semibold">
                    {MONTHS[next.getMonth()]} {next.getFullYear()}
                  </span>
                  <button
                    type="button"
                    aria-label="Próximo mês"
                    className="rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    onClick={() => shift(1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <Month
                  year={next.getFullYear()}
                  month={next.getMonth()}
                  range={draft}
                  hover={hover}
                  onPick={pick}
                  onHover={setHover}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-between border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
              <button
                type="button"
                className="text-neutral-500 hover:underline"
                onClick={() => apply({ from: null, to: null })}
              >
                Limpar
              </button>
              <button
                type="button"
                className="font-medium text-brand-600 hover:underline"
                onClick={() => {
                  const t = new Date();
                  setView({ y: t.getFullYear(), m: t.getMonth() });
                }}
              >
                Hoje
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
