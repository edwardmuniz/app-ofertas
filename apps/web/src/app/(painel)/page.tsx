"use client";

import type { Funnel, PerformanceSummary, WorkspaceOverview } from "@ofertas/contracts";
import { AlertTriangle, ArrowRight, OctagonAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { type PeriodKey, PeriodPicker, WEEKDAYS } from "@/components/metrics";
import { Loading, PageHeader, Panel, PlatformBadge, StatCard, Tag } from "@/components/ui";
import { api } from "@/lib/api";

const SUBTITLE: Record<PeriodKey, string> = {
  today: "Desempenho dos seus grupos hoje",
  yesterday: "Desempenho dos seus grupos ontem",
  "7d": "Desempenho dos seus grupos nos últimos 7 dias",
  "30d": "Desempenho dos seus grupos nos últimos 30 dias",
};

const fmt = (n: number) => n.toLocaleString("pt-BR");

export default function OverviewPage() {
  const [data, setData] = useState<WorkspaceOverview | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const [summary, setSummary] = useState<PerformanceSummary | null>(null);
  const [funnel, setFunnel] = useState<Funnel | null>(null);

  useEffect(() => {
    api<WorkspaceOverview>("/workspace/overview").then(setData);
  }, []);
  useEffect(() => {
    api<PerformanceSummary>(`/metrics/summary?period=${period}`).then(setSummary);
    api<Funnel>(`/metrics/funnel?period=${period}`).then(setFunnel);
  }, [period]);

  if (!data) return <Loading />;
  const s = summary;
  const funnelMax = Math.max(1, ...(funnel?.stages.map((x) => x.value ?? 0) ?? [1]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Visão geral"
        subtitle={SUBTITLE[period]}
        actions={
          <>
            <PeriodPicker value={period} onChange={setPeriod} />
            <Link href="/metricas" className="btn-ghost !min-h-9">
              Ver métricas
            </Link>
          </>
        }
      />

      {data.alerts.length ? (
        <div className="flex flex-col gap-2">
          {data.alerts.map((a) => (
            <div
              key={a.message}
              className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${
                a.level === "critical"
                  ? "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
                  : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
              }`}
            >
              {a.level === "critical" ? (
                <OctagonAlert size={16} className="mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              )}
              <span>
                <strong className="font-semibold">
                  {a.level === "critical" ? "Crítico" : "Atenção"}:
                </strong>{" "}
                {a.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <StatCard
          label="Cliques em ofertas"
          value={s ? s.clicks.offer_clicks : "—"}
          delta={s ? s.clicks.offer_clicks_change_pct : undefined}
          hint={s ? `${s.clicks.clicks_per_post ?? "—"} por envio` : null}
        />
        <StatCard
          label="Novos membros"
          value={s ? `${s.audience.net_growth >= 0 ? "+" : ""}${fmt(s.audience.net_growth)}` : "—"}
          delta={s ? s.audience.joins_change_pct : undefined}
          hint={s ? `${fmt(s.audience.joins)} entradas · ${fmt(s.audience.leaves)} saídas` : null}
        />
        <StatCard
          label="Envios"
          value={s ? s.publishing.posts_sent : "—"}
          delta={s ? s.publishing.posts_sent_change_pct : undefined}
          hint={s ? `${s.publishing.scheduled_next_24h} nas próximas 24h` : null}
        />
        <StatCard
          label="Membros nos grupos"
          value={s ? s.audience.members_total : "—"}
          hint={s ? `${s.audience.channels_active} grupos ativos` : null}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <Panel title="Funil" subtitle="Do clique no convite ao clique na oferta">
          <ul className="flex flex-col gap-4">
            {funnel?.stages.map((st) => (
              <li key={st.key} title={st.note ?? undefined}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-neutral-600 dark:text-neutral-400">{st.label}</span>
                  <span className="flex items-baseline gap-2 tabular-nums">
                    {st.rate !== null ? (
                      <span className="text-xs text-neutral-500">
                        {st.key === "offer_clicks"
                          ? `${st.rate.toLocaleString("pt-BR")}/membro/dia`
                          : `${Math.round(st.rate * 100)}%`}
                        {st.benchmark !== null
                          ? ` · ref. ${st.key === "offer_clicks" ? st.benchmark.toLocaleString("pt-BR") : `${Math.round(st.benchmark * 100)}%`}`
                          : ""}
                      </span>
                    ) : null}
                    <span className="font-semibold">
                      {st.value === null ? <Tag>em breve</Tag> : fmt(st.value)}
                    </span>
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-[width] duration-[260ms] dark:bg-brand-400"
                    style={{ width: `${((st.value ?? 0) / funnelMax) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
          {funnel?.bottleneck ? (
            <p className="mt-5 rounded-lg bg-brand-50 px-3 py-2.5 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
              <strong className="font-semibold">Gargalo: {funnel.bottleneck.label}.</strong>{" "}
              {funnel.bottleneck.hint}
            </p>
          ) : null}
        </Panel>

        <Panel title="O que os números dizem" subtitle="Observações automáticas do período">
          {s?.insights.length ? (
            <ul className="flex flex-col gap-3 text-sm">
              {s.insights.map((i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-brand-500" />
                  <span>{i}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">Sem observações no período.</p>
          )}
          {s?.best_hours.length ? (
            <div className="mt-5 border-t border-neutral-100 pt-4 dark:border-neutral-800">
              <span className="eyebrow">Melhores horários</span>
              <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                {s.best_hours.map((h) => (
                  <li key={`${h.weekday}-${h.hour}`} className="flex justify-between tabular-nums">
                    <span>
                      {WEEKDAYS[h.weekday]} · {h.hour}h
                    </span>
                    <span className="text-neutral-500">{h.clicks_per_post} cliques/envio</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel
        title="Ofertas com mais cliques"
        subtitle={s?.period.label}
        padding={false}
        actions={
          <Link href="/metricas" className="btn-ghost !min-h-7 !border-transparent !shadow-none">
            Ver todas <ArrowRight size={14} />
          </Link>
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>Oferta</th>
              <th>Loja</th>
              <th className="!text-right">Envios</th>
              <th className="!text-right">Cliques</th>
            </tr>
          </thead>
          <tbody>
            {s?.top_offers.map((o) => (
              <tr key={o.offer_id}>
                <td className="max-w-md font-medium">
                  <span className="line-clamp-1">{o.title}</span>
                </td>
                <td>
                  <PlatformBadge platform={o.platform} />
                </td>
                <td className="text-right">{o.posts_sent}</td>
                <td className="text-right font-semibold">{fmt(o.clicks)}</td>
              </tr>
            ))}
            {s && !s.top_offers.length ? (
              <tr>
                <td colSpan={4} className="text-center text-neutral-500">
                  Nenhum clique em ofertas no período.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <p className="text-xs text-neutral-500">
        {s
          ? `Cliques atualizados às ${new Date(s.data_freshness).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. `
          : ""}
        Receita e comissões entram com o módulo Financeiro.{" "}
        <span className="text-neutral-400">
          Módulos ativos: {data.modules.filter((m) => m.status === "available").length} de{" "}
          {data.modules.length}.
        </span>
      </p>
    </div>
  );
}
