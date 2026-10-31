"use client";

export const PERIODS = [
  { key: "today", label: "Hoje" },
  { key: "yesterday", label: "Ontem" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];

export const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function PeriodPicker({
  value,
  onChange,
}: {
  value: PeriodKey;
  onChange: (p: PeriodKey) => void;
}) {
  return (
    <div className="flex rounded-lg border border-neutral-300 p-0.5 text-sm dark:border-neutral-700">
      {PERIODS.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onChange(p.key)}
          className={`rounded-md px-3 py-1 ${
            value === p.key
              ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
              : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
