"use client";

import type { Funnel, PerformanceSummary, WorkspaceOverview } from "@ofertas/contracts";
import { useEffect, useState } from "react";
import { type PERIODS, PeriodPicker, WEEKDAYS } from "@/components/metrics";
import { api } from "@/lib/api";

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-neutral-400">sem base</span>;
  const up = value >= 0;
  return (
    <span
      className={`text-xs ${up ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}
    >
      {up ? "▲" : "▼"} {Math.abs(value)}%
    </span>
  );
}

const ALERT_CLASS = {
  critical:
    "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
  warning:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
};

export default function OverviewPage() {
  const [data, setData] = useState<WorkspaceOverview | null>(null);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("7d");
  const [summary, setSummary] = useState<PerformanceSummary | null>(null);
  const [funnel, setFunnel] = useState<Funnel | null>(null);

  useEffect(() => {
    api<WorkspaceOverview>("/workspace/overview").then(setData);
  }, []);
  useEffect(() => {
    api<PerformanceSummary>(`/metrics/summary?period=${period}`).then(setSummary);
    api<Funnel>(`/metrics/funnel?period=${period}`).then(setFunnel);
  }, [period]);

  if (!data) return <p className="text-sm text-neutral-500">Carregando…</p>;

  const s = summary;
  const tiles = s
    ? [
        {
          label: "Membros nos grupos",
          value: s.audience.members_total,
          change: null,
          sub: `${s.audience.channels_active} grupos ativos`,
        },
        {
          label: "Entradas",
          value: s.audience.joins,
          change: s.audience.joins_change_pct,
          sub: `${s.audience.leaves} saídas · saldo ${s.audience.net_growth}`,
        },
        {
          label: "Envios",
          value: s.publishing.posts_sent,
          change: s.publishing.posts_sent_change_pct,
          sub: `${s.publishing.posts_failed} falhas · ${s.publishing.scheduled_next_24h} nas próximas 24h`,
        },
        {
          label: "Cliques em ofertas",
          value: s.clicks.offer_clicks,
          change: s.clicks.offer_clicks_change_pct,
          sub: `${s.clicks.clicks_per_post ?? "—"} por envio · ${s.clicks.bot_clicks} robôs ignorados`,
        },
      ]
    : [];
  const funnelMax = Math.max(1, ...(funnel?.stages.map((x) => x.value ?? 0) ?? [1]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Visão geral</h1>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      {data.alerts.map((a) => (
        <div key={a.message} className={`rounded-lg border p-3 text-sm ${ALERT_CLASS[a.level]}`}>
          <strong className="mr-1">{a.level === "critical" ? "Crítico:" : "Atenção:"}</strong>
          {a.message}
        </div>
      ))}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="card">
            <div className="text-sm text-neutral-500">{t.label}</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums">
                {t.value.toLocaleString("pt-BR")}
              </span>
              {t.change !== undefined && t.label !== "Membros nos grupos" && (
                <Change value={t.change} />
              )}
            </div>
            <div className="mt-1 text-xs text-neutral-500">{t.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 font-medium">Funil</h2>
          <ul className="space-y-3">
            {funnel?.stages.map((st) => (
              <li key={st.key} title={st.note ?? undefined}>
                <div className="flex justify-between text-sm">
                  <span>{st.label}</span>
                  <span className="tabular-nums">
                    {st.value === null ? "em breve" : st.value.toLocaleString("pt-BR")}
                    {st.rate !== null && (
                      <span className="ml-2 text-xs text-neutral-500">
                        {st.key === "offer_clicks"
                          ? `${st.rate}/membro/dia`
                          : `${Math.round(st.rate * 100)}%`}
                        {st.benchmark !== null &&
                          ` (ref. ${st.key === "offer_clicks" ? st.benchmark : `${Math.round(st.benchmark * 100)}%`})`}
                      </span>
                    )}
                  </span>
                </div>
                <div className="mt-1 h-2 rounded bg-neutral-100 dark:bg-neutral-800">
                  <div
                    className="h-2 rounded bg-emerald-600 dark:bg-emerald-500"
                    style={{ width: `${((st.value ?? 0) / funnelMax) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
          {funnel?.bottleneck && (
            <p className="mt-4 rounded-lg bg-neutral-100 p-3 text-sm dark:bg-neutral-800">
              <strong>Gargalo: {funnel.bottleneck.label}.</strong> {funnel.bottleneck.hint}
            </p>
          )}
        </section>

        <section className="card space-y-4">
          <div>
            <h2 className="mb-2 font-medium">O que os números dizem</h2>
            {s?.insights.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {s.insights.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neutral-500">Sem observações no período.</p>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">Ofertas com mais cliques</h3>
            <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
              {s?.top_offers.map((o) => (
                <li key={o.offer_id} className="flex justify-between gap-3 py-1.5">
                  <span className="line-clamp-1">{o.title}</span>
                  <span className="shrink-0 tabular-nums">{o.clicks} cliques</span>
                </li>
              ))}
              {s && !s.top_offers.length && (
                <li className="py-1.5 text-neutral-500">Nenhum clique ainda.</li>
              )}
            </ul>
          </div>
          {s?.best_hours.length ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Melhores horários:{" "}
              {s.best_hours
                .map((h) => `${WEEKDAYS[h.weekday]} ${h.hour}h (${h.clicks_per_post}/envio)`)
                .join(" · ")}
            </p>
          ) : null}
          {s && (
            <p className="text-xs text-neutral-400">
              Cliques atualizados às{" "}
              {new Date(s.data_freshness).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
              . Comissões entram no módulo Financeiro.
            </p>
          )}
        </section>
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
