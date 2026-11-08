"use client";

import { useEffect, useState } from "react";
import { ErrorText, PageHeader } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { TabBar, useRouteTab } from "@/lib/tabs";
import { Schedule } from "./schedule";
import { Queue, Rules, Templates } from "./tabs";

const TABS = ["fila", "agendar", "regras", "modelos"] as const;
type Tab = (typeof TABS)[number];

export default function PublicacoesPage() {
  const [tab, setTab] = useRouteTab<Tab>("/publicacoes", TABS, "fila");
  const [error, setError] = useState<string | null>(null);

  // Links antigos (/publicacoes?offer=... ou ?coupon=...) abrem direto em Agendar.
  useEffect(() => {
    const q = window.location.search;
    if (/[?&](offer|coupon)=/.test(q) && window.location.pathname === "/publicacoes") {
      setTab("agendar", q.slice(1));
    }
  }, [setTab]);

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
      <TabBar base="/publicacoes" tabs={tabs} active={tab} />
      <ErrorText error={error} />
      {tab === "fila" && <Queue run={run} onSchedule={() => setTab("agendar")} />}
      {tab === "agendar" && <Schedule run={run} onDone={() => setTab("fila")} />}
      {tab === "regras" && <Rules run={run} />}
      {tab === "modelos" && <Templates run={run} />}
    </div>
  );
}
