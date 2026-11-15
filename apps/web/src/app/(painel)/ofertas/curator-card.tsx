"use client";

import type { CuratorStatus } from "@ofertas/contracts";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LoadingButton, Panel, Tag } from "@/components/ui";
import { api, fmtDate } from "@/lib/api";

type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;

const HOURS = [2, 3, 4, 6, 8, 12, 24];
const MAX_OFFERS = [3, 5, 8, 10, 15, 20];

/**
 * Curador automático: agente de IA que busca na Shopee e na Amazon seguindo as Preferências
 * e manda as melhores ofertas para "Para revisar".
 */
export function CuratorCard({ run, onRan }: { run: Runner; onRan?: () => void }) {
  const [status, setStatus] = useState<CuratorStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    setStatus(await api<CuratorStatus>("/auto-curator"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Rodada pedida: acompanha até o worker terminar.
  const waiting = Boolean(status?.requested_at);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const s = await api<CuratorStatus>("/auto-curator").catch(() => null);
      if (!s) return;
      setStatus(s);
      if (!s.requested_at) onRan?.();
    }, 8000);
    return () => clearInterval(t);
  }, [waiting, onRan]);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    const res = await run(() => api("/workspace/preferences", { method: "PATCH", body: patch }));
    setSaving(false);
    if (res) await load();
  }

  async function runNow() {
    const res = await run(() => api("/auto-curator/request", { method: "POST", body: {} }));
    if (res) await load();
  }

  if (!status) return null;
  const last = status.last_result;
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-neutral-500" />
          Curador automático
          {status.enabled ? (
            <Tag tone="positive" dot>
              Ligado
            </Tag>
          ) : (
            <Tag>Desligado</Tag>
          )}
        </span>
      }
      subtitle={
        <>
          Um agente de IA busca ofertas na Shopee e na Amazon seguindo os nichos, o que nunca
          publicar e as notas das{" "}
          <Link href="/preferencias" className="underline">
            Preferências
          </Link>
          , e manda as melhores para “Para revisar” com o motivo da escolha.
        </>
      }
      actions={
        <LoadingButton
          variant="btn-ghost"
          busy={waiting}
          disabled={!status.configured}
          onClick={runNow}
        >
          {waiting ? "Buscando…" : "Rodar agora"}
        </LoadingButton>
      }
    >
      {!status.configured && (
        <p className="mb-3 text-sm text-amber-600">
          Falta a chave do OpenRouter no servidor (OPENROUTER_API_KEY no .env).
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={saving || !status.configured}
            onChange={(e) => save({ auto_curator: e.target.checked })}
          />
          Rodar sozinho
        </label>
        <label className="inline-flex items-center gap-2">
          a cada
          <select
            className="input !w-auto"
            value={status.every_hours}
            disabled={saving}
            onChange={(e) => save({ auto_curator_every_hours: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h} h
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-2">
          até
          <select
            className="input !w-auto"
            value={status.max_offers}
            disabled={saving}
            onChange={(e) => save({ auto_curator_max_offers: Number(e.target.value) })}
          >
            {MAX_OFFERS.map((n) => (
              <option key={n} value={n}>
                {n} ofertas
              </option>
            ))}
          </select>
          por rodada
        </label>
      </div>
      <div className="mt-3 space-y-1 text-xs text-neutral-500">
        {waiting ? (
          <p>Rodada pedida: começa em até 1 minuto e leva alguns minutos.</p>
        ) : status.enabled && status.next_run_at ? (
          <p>Próxima rodada: {fmtDate(status.next_run_at)} (só entre 7h e 23h).</p>
        ) : null}
        {status.last_run_at && last && (
          <p>
            Última: {fmtDate(status.last_run_at)} ·{" "}
            {last.error ? (
              <span className="text-red-600">erro: {last.error}</span>
            ) : (
              `${last.added} ${last.added === 1 ? "oferta nova" : "ofertas novas"}`
            )}
            {last.searches.length > 0 && ` · buscou: ${last.searches.join(", ")}`}
          </p>
        )}
        {last?.summary && !last.error && <p className="italic">“{last.summary}”</p>}
      </div>
    </Panel>
  );
}
