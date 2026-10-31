"use client";

import type { AuditEntry, AuditPage } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { api, fmtDate } from "@/lib/api";

const ORIGIN_LABEL: Record<string, string> = {
  web: "Painel",
  rest: "API",
  mcp: "Agente (MCP)",
  cli: "CLI",
  worker: "Sistema",
};

const RESULT_STYLE: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  error: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-400",
  pending_approval: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
};

export default function AuditoriaPage() {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  const load = useCallback(
    async (next?: string) => {
      const q = new URLSearchParams({ limit: "30" });
      if (origin) q.set("origin", origin);
      if (next) q.set("cursor", next);
      const page = await api<AuditPage>(`/audit-log?${q}`);
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
    },
    [origin],
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Auditoria"
        subtitle="Tudo o que pessoas, agentes e o sistema fizeram no workspace"
        actions={
          <select
            className="input w-auto"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          >
            <option value="">Todas as origens</option>
            {Object.entries(ORIGIN_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        }
      />

      <section className="card overflow-x-auto">
        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">Nenhuma ação registrada.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 font-normal">Quando</th>
                <th className="py-2 font-normal">Quem</th>
                <th className="py-2 font-normal">Origem</th>
                <th className="py-2 font-normal">Ação</th>
                <th className="py-2 font-normal">Motivo</th>
                <th className="py-2 font-normal">Resultado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="py-2 whitespace-nowrap">{fmtDate(a.created_at)}</td>
                  <td className="py-2">{a.actor_label}</td>
                  <td className="py-2">{ORIGIN_LABEL[a.origin] ?? a.origin}</td>
                  <td className="py-2 font-mono text-xs">{a.action}</td>
                  <td className="py-2 text-neutral-500">{a.reason ?? "—"}</td>
                  <td className="py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${RESULT_STYLE[a.result] ?? ""}`}
                    >
                      {a.result}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor && (
          <button type="button" className="btn-ghost mt-4" onClick={() => load(cursor)}>
            Carregar mais
          </button>
        )}
      </section>
    </div>
  );
}
