"use client";

import type { OfferLink } from "@ofertas/contracts";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { CopyButton, ErrorText } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

/** Onde o link vai ser divulgado. Vira o sub-id da origem e separa os cliques nas métricas. */
export const LINK_SOURCES = [
  { value: "wa", label: "WhatsApp", hint: "Grupos, status ou conversas" },
  { value: "ig", label: "Post do Instagram", hint: "Legenda ou comentário" },
  { value: "story", label: "Story", hint: "Figurinha de link" },
  { value: "bio", label: "Link da bio", hint: "Instagram, TikTok…" },
  { value: "ads", label: "Anúncio", hint: "Meta, Google…" },
] as const;

const sourceLabel = (v: string) => LINK_SOURCES.find((s) => s.value === v)?.label ?? v;

type Generated = { source: string; campaign: string; url: string; direct: boolean };

/** Gera links rastreados da oferta, um por origem, prontos para copiar. */
export function OfferLinkPanel({ offerId, onClose }: { offerId: string; onClose: () => void }) {
  const [source, setSource] = useState<string>("wa");
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Generated[]>([]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = campaign.trim();
      const res = await api<{ result?: OfferLink }>(`/offers/${offerId}/links`, {
        method: "POST",
        body: { source, ...(c && { campaign: c }) },
      });
      const r = res.result;
      const url = r?.share_url ?? r?.short_url;
      if (r && url) {
        const direct = url !== r.short_url;
        setMade((list) => [{ source, campaign: c, url, direct }, ...list]);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao gerar o link.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={generate}
      className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Link de afiliado rastreado</div>
          <div className="text-xs text-neutral-500">
            Um link por lugar onde você vai divulgar: os cliques aparecem separados em Métricas.
          </div>
        </div>
        <button
          type="button"
          className="text-xs text-neutral-500 hover:underline"
          onClick={onClose}
        >
          Fechar
        </button>
      </div>

      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Onde vai divulgar</legend>
        {LINK_SOURCES.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={source === s.value}
            title={s.hint}
            onClick={() => setSource(s.value)}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${
              source === s.value
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 hover:border-neutral-400 dark:border-neutral-700"
            }`}
          >
            {s.label}
          </button>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          value={campaign}
          maxLength={80}
          onChange={(e) => setCampaign(e.target.value)}
          placeholder="Campanha (opcional), ex.: black-friday"
          aria-label="Campanha"
        />
        <button className="btn inline-flex items-center gap-1.5" type="submit" disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? "Gerando…" : `Gerar link para ${sourceLabel(source)}`}
        </button>
      </div>

      <ErrorText error={error} />

      {made.some((m) => m.direct) && (
        <p className="text-xs text-neutral-500">
          Amazon: o link vai direto para a loja, com a sua tag (a Amazon não permite encurtador
          próprio). Os cliques e vendas aparecem no relatório de Associados.
        </p>
      )}

      {made.length > 0 && (
        <ul className="space-y-1.5">
          {made.map((m) => (
            <li
              key={m.url}
              className="flex flex-wrap items-center gap-2 rounded-md bg-neutral-50 px-2 py-1.5 text-sm dark:bg-neutral-900"
            >
              <span className="w-32 shrink-0 text-xs text-neutral-500">
                {sourceLabel(m.source)}
                {m.campaign && ` · ${m.campaign}`}
              </span>
              <code className="min-w-0 flex-1 truncate">{m.url}</code>
              <CopyButton value={m.url} />
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
