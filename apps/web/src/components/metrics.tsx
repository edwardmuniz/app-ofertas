"use client";

import { Segmented } from "./ui";

export const PERIODS = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["value"];

export const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function PeriodPicker({
  value,
  onChange,
}: {
  value: PeriodKey;
  onChange: (p: PeriodKey) => void;
}) {
  return <Segmented options={PERIODS} value={value} onChange={onChange} />;
}
