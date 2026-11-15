"use client";

import type { AiUsageSummary } from "@ofertas/contracts";
import { useEffect, useState } from "react";
import { Panel } from "@/components/ui";
import { api, fmtDate } from "@/lib/api";
import { usd } from "@/lib/format";

const FEATURE_LABEL: Record<AiUsageSummary["month"]["by_feature"][number]["feature"], string> = {
  copy: "Texto das ofertas",
  curator: "Curador automático",
};

/** Quanto a IA (OpenRouter) custou hoje e no mês, por função. */
export function AiUsagePanel() {
  const [data, setData] = useState<AiUsageSummary | null>(null);
  useEffect(() => {
    api<AiUsageSummary>("/ai-usage")
      .then(setData)
      .catch(() => setData(null));
  }, []);
  if (!data) return null;

  return (
    <Panel
      title="Gasto com IA"
      subtitle={
        data.since
          ? `Valor informado pelo OpenRouter, medido desde ${fmtDate(data.since)}.`
          : "Ainda sem gasto medido. Aparece aqui depois do primeiro texto ou rodada do curador."
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-[var(--surface-sunken)] p-4">
          <div className="text-sm text-neutral-500">Hoje</div>
          <div className="text-2xl font-semibold tabular-nums">{usd(data.today.cost_usd)}</div>
        </div>
        <div className="rounded-lg bg-[var(--surface-sunken)] p-4">
          <div className="text-sm text-neutral-500">Este mês</div>
          <div className="text-2xl font-semibold tabular-nums">{usd(data.month.cost_usd)}</div>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="table text-sm">
          <thead>
            <tr>
              <th>Função</th>
              <th className="text-right">Hoje</th>
              <th className="text-right">Este mês</th>
              <th className="text-right">Gerações no mês</th>
            </tr>
          </thead>
          <tbody>
            {data.month.by_feature.map((m) => {
              const t = data.today.by_feature.find((x) => x.feature === m.feature);
              return (
                <tr key={m.feature}>
                  <td>{FEATURE_LABEL[m.feature]}</td>
                  <td className="text-right tabular-nums">{usd(t?.cost_usd ?? 0)}</td>
                  <td className="text-right tabular-nums">{usd(m.cost_usd)}</td>
                  <td className="text-right tabular-nums">{m.calls.toLocaleString("pt-BR")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.unpriced_calls > 0 && (
        <p className="mt-3 text-sm text-neutral-500">
          {data.unpriced_calls} {data.unpriced_calls === 1 ? "geração" : "gerações"} sem valor
          informado (Gemini não devolve o custo).
        </p>
      )}
    </Panel>
  );
}
