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
export function OfferLinkPanel({ offerId }: { offerId: string }) {
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
    <form onSubmit={generate} className="space-y-4">
      <p className="text-sm text-neutral-500">
        Escolha onde vai divulgar. Cada lugar ganha o seu link, e os cliques aparecem separados em
        Métricas.
      </p>

      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">Onde você vai divulgar?</legend>
        {LINK_SOURCES.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={source === s.value}
            title={s.hint}
            onClick={() => setSource(s.value)}
            className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
              source === s.value
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 hover:border-neutral-400 dark:border-neutral-700"
            }`}
          >
            <span className="block font-medium">{s.label}</span>
            <span className="block text-xs opacity-70">{s.hint}</span>
          </button>
        ))}
      </fieldset>

      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="link_campaign">
          Nome da campanha (opcional)
        </label>
        <input
          className="input"
          id="link_campaign"
          value={campaign}
          maxLength={80}
          onChange={(e) => setCampaign(e.target.value)}
          placeholder="ex.: black-friday"
        />
      </div>
      <div>
        <button className="btn h-11 w-full gap-1.5 text-[15px]" type="submit" disabled={busy}>
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
        <ul className="space-y-2">
          {made.map((m) => (
            <li
              key={m.url}
              className="space-y-1.5 rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-900"
            >
              <div className="font-medium">
                Link para {sourceLabel(m.source)}
                {m.campaign && ` · ${m.campaign}`}
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate">{m.url}</code>
                <CopyButton value={m.url} label="Copiar link" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
