"use client";

import type { CuratorStatus } from "@ofertas/contracts";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LoadingButton, Panel, SettingRow, Switch, Tag } from "@/components/ui";
import { api, fmtDate } from "@/lib/api";
import { usd } from "@/lib/format";

type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;

const HOURS = [2, 3, 4, 6, 8, 12, 24];
const MAX_OFFERS = [2, 3, 5, 8, 10, 15];

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
          Um agente de IA busca ofertas em cada conta de afiliado ativa seguindo os nichos, o que
          nunca publicar e as notas das{" "}
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
        <p className="mb-4 text-sm text-amber-600">
          Falta a chave do OpenRouter no servidor (OPENROUTER_API_KEY no .env).
        </p>
      )}
      <div className="divide-y divide-[var(--border-subtle)]">
        <SettingRow
          label="Rodar sozinho"
          htmlFor="curator_enabled"
          help={
            waiting
              ? "Rodada pedida: começa em até 1 minuto e leva alguns minutos."
              : status.enabled && status.next_run_at
                ? `Próxima rodada: ${fmtDate(status.next_run_at)}. Só roda entre 7h e 23h.`
                : "Só roda entre 7h e 23h."
          }
        >
          <Switch
            id="curator_enabled"
            checked={status.enabled}
            disabled={saving || !status.configured}
            onChange={(v) => save({ auto_curator: v })}
          />
        </SettingRow>
        <SettingRow label="Frequência" htmlFor="curator_every">
          <select
            id="curator_every"
            className="input !w-auto"
            value={status.every_hours}
            disabled={saving}
            onChange={(e) => save({ auto_curator_every_hours: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                a cada {h} h
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label="Ofertas por conta"
          help={
            status.accounts.length
              ? `Máximo por rodada em cada conta ativa: ${status.accounts.map((a) => a.label).join(", ")}.`
              : "Nenhuma conta de afiliado ativa com busca. Conecte ou reative em Afiliados."
          }
          htmlFor="curator_max"
        >
          <select
            id="curator_max"
            className="input !w-auto"
            value={status.max_offers}
            disabled={saving}
            onChange={(e) => save({ auto_curator_max_offers: Number(e.target.value) })}
          >
            {[...new Set([...MAX_OFFERS, status.max_offers])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  até {n}
                </option>
              ))}
          </select>
        </SettingRow>
      </div>
      {status.last_run_at && last && (
        <div className="mt-4 space-y-2 rounded-lg bg-[var(--surface-sunken)] p-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">Última rodada</span>
            <span className="text-neutral-500">{fmtDate(status.last_run_at)}</span>
            {last.error ? (
              <Tag tone="negative">erro</Tag>
            ) : (
              <Tag tone="positive">
                {last.added} {last.added === 1 ? "oferta nova" : "ofertas novas"}
              </Tag>
            )}
            {last.cost_usd !== null && (
              <span className="text-neutral-500">· custou {usd(last.cost_usd)}</span>
            )}
          </div>
          {!last.error && Object.keys(last.by_account).length > 0 && (
            <p>
              {Object.entries(last.by_account)
                .map(([label, n]) => `${label}: ${n}`)
                .join(" · ")}
            </p>
          )}
          {last.error && <p className="text-red-600">{last.error}</p>}
          {last.summary && !last.error && (
            <p className="text-[var(--text-secondary)]">{last.summary}</p>
          )}
          {last.searches.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {last.searches.map((q) => (
                <Tag key={q}>{q}</Tag>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
