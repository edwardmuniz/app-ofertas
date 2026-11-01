"use client";

import { useEffect, useState } from "react";
import { ErrorText, PageHeader } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { Schedule } from "./schedule";
import { Queue, Rules, Templates } from "./tabs";

type Tab = "fila" | "agendar" | "regras" | "modelos";

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
    <div className="flex flex-col gap-6">
      <PageHeader title="Publicações" subtitle="Agende envios nos grupos e automatize com regras" />
      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              tab === t.key
                ? "border-brand-500 font-medium text-neutral-900 dark:text-neutral-50"
                : "border-transparent text-neutral-500"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ErrorText error={error} />
      {tab === "fila" && <Queue run={run} onSchedule={() => setTab("agendar")} />}
      {tab === "agendar" && <Schedule run={run} onDone={() => setTab("fila")} />}
      {tab === "regras" && <Rules run={run} />}
      {tab === "modelos" && <Templates run={run} />}
    </div>
  );
}
