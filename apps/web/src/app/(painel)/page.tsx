"use client";

import type { WorkspaceOverview } from "@ofertas/contracts";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function OverviewPage() {
  const [data, setData] = useState<WorkspaceOverview | null>(null);

  useEffect(() => {
    api<WorkspaceOverview>("/workspace/overview").then(setData);
  }, []);

  if (!data) return <p className="text-sm text-neutral-500">Carregando…</p>;

  const stats = [
    { label: "Membros da equipe", value: data.counts.members },
    { label: "Agentes conectados", value: data.counts.active_tokens },
    { label: "Aprovações pendentes", value: data.counts.pending_approvals },
    { label: "Ações nas últimas 24h", value: data.counts.actions_last_24h },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Visão geral</h1>

      {data.alerts.map((a) => (
        <div
          key={a.message}
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {a.message}
        </div>
      ))}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="card">
            <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
            <div className="text-sm text-neutral-500">{s.label}</div>
          </div>
        ))}
      </div>

      <section className="card">
        <h2 className="mb-3 font-medium">Módulos</h2>
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {data.modules.map((m) => (
            <li key={m.key} className="flex items-center justify-between py-2 text-sm">
              <span>
                <span className="mr-2 text-neutral-400 tabular-nums">Fase {m.phase}</span>
                {m.name}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  m.status === "available"
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                }`}
              >
                {m.status === "available" ? "Disponível" : "Planejado"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
