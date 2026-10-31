"use client";

import type { MetricsBreakdown } from "@ofertas/contracts";
import { useEffect, useState } from "react";
import { type PeriodKey, PeriodPicker, WEEKDAYS } from "@/components/metrics";
import { PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { money } from "@/lib/format";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function MetricasPage() {
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const [channels, setChannels] = useState<MetricsBreakdown | null>(null);
  const [offers, setOffers] = useState<MetricsBreakdown | null>(null);
  const [hours, setHours] = useState<MetricsBreakdown | null>(null);

  useEffect(() => {
    const q = (view: string) => `/metrics/breakdown?view=${view}&period=${period}`;
    api<MetricsBreakdown>(q("channels")).then(setChannels);
    api<MetricsBreakdown>(q("offers")).then(setOffers);
    api<MetricsBreakdown>(q("hours")).then(setHours);
  }, [period]);

  const cells = new Map((hours?.hours ?? []).map((c) => [`${c.weekday}-${c.hour}`, c]));
  const maxCpp = Math.max(0, ...(hours?.hours ?? []).map((c) => c.clicks_per_post ?? 0));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Métricas"
        subtitle="Grupos, ofertas e horários que trazem mais cliques"
        actions={<PeriodPicker value={period} onChange={setPeriod} />}
      />

      <section className="card overflow-x-auto">
        <h2 className="mb-1 font-medium">Cliques por envio, por horário</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Cada célula soma os cliques dos posts enviados naquele dia da semana e hora. Mais escuro =
          mais cliques por envio. Passe o mouse para ver os números.
        </p>
        <table className="border-separate border-spacing-0.5 text-xs">
          <thead>
            <tr>
              <th />
              {HOURS.map((h) => (
                <th key={h} className="w-7 font-normal text-neutral-500 tabular-nums">
                  {h % 3 === 0 ? h : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEKDAYS.map((d, wd) => (
              <tr key={d}>
                <th className="pr-2 text-right font-normal text-neutral-500">{d}</th>
                {HOURS.map((h) => {
                  const c = cells.get(`${wd}-${h}`);
                  const t = c && maxCpp > 0 ? (c.clicks_per_post ?? 0) / maxCpp : 0;
                  return (
                    <td
                      key={h}
                      title={
                        c
                          ? `${d} ${h}h: ${c.posts} envio(s), ${c.clicks} cliques, ${c.clicks_per_post ?? 0} por envio`
                          : `${d} ${h}h: sem envios`
                      }
                      className="h-6 w-7 rounded-sm bg-neutral-100 dark:bg-neutral-800"
                      style={
                        c
                          ? {
                              backgroundColor: `color-mix(in oklab, var(--accent) ${Math.round(15 + t * 85)}%, transparent)`,
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 font-medium">Grupos</h2>
        <table className="table text-sm">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1 font-normal">Grupo</th>
              <th className="font-normal">Membros</th>
              <th className="font-normal">Entradas</th>
              <th className="font-normal">Saídas</th>
              <th className="font-normal">Envios</th>
              <th className="font-normal">Cliques</th>
              <th className="font-normal" title="Cliques por envio">
                Cliq./envio
              </th>
              <th className="font-normal" title="Cliques por envio a cada 100 membros">
                Por 100 membros
              </th>
              <th className="font-normal">Saídas/envio</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 tabular-nums dark:divide-neutral-800">
            {channels?.channels?.map((c) => {
              const fill = c.member_limit ? c.members / c.member_limit : 0;
              return (
                <tr key={c.channel_id}>
                  <td className="py-1.5 font-sans">{c.name}</td>
                  <td>
                    {c.members}
                    <span
                      className={`ml-1 text-xs ${fill >= 0.9 ? "text-red-700 dark:text-red-400" : "text-neutral-400"}`}
                    >
                      {Math.round(fill * 100)}%
                    </span>
                  </td>
                  <td>{c.joins}</td>
                  <td>{c.leaves}</td>
                  <td>{c.posts_sent}</td>
                  <td>{c.clicks}</td>
                  <td>{c.clicks_per_post ?? "—"}</td>
                  <td>{c.clicks_per_100_members ?? "—"}</td>
                  <td>{c.leaves_per_post ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 font-medium">Ofertas</h2>
        <table className="table text-sm">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1 font-normal">Oferta</th>
              <th className="font-normal">Preço</th>
              <th className="font-normal">Desconto</th>
              <th className="font-normal">Envios</th>
              <th className="font-normal">Cliques</th>
              <th className="font-normal">Cliq./envio</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 tabular-nums dark:divide-neutral-800">
            {offers?.offers?.map((o) => (
              <tr key={o.offer_id}>
                <td className="max-w-md py-1.5">
                  <span className="line-clamp-1">{o.title}</span>
                </td>
                <td>{money(o.price)}</td>
                <td>{o.discount_pct !== null ? `${o.discount_pct}%` : "—"}</td>
                <td>{o.posts_sent}</td>
                <td>{o.clicks}</td>
                <td>{o.clicks_per_post ?? "—"}</td>
              </tr>
            ))}
            {offers && !offers.offers?.length && (
              <tr>
                <td className="py-2 text-neutral-500" colSpan={6}>
                  Nenhuma oferta enviada no período.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
