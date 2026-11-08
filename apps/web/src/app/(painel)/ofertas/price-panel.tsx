"use client";

import type { Offer } from "@ofertas/contracts";
import { useState } from "react";
import { ErrorText, LoadingButton } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

const toNumber = (v: string): number | null => {
  let s = v.replace(/[^\d.,]/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const toText = (n: number | null | undefined) => (n ? n.toFixed(2).replace(".", ",") : "");

/** Corrige preço, "De", Pix e parcelas com o que a página da loja mostra. */
export function OfferPricePanel({ offer, onSaved }: { offer: Offer; onSaved: (o: Offer) => void }) {
  const [price, setPrice] = useState(toText(offer.price));
  const [original, setOriginal] = useState(toText(offer.original_price));
  const [pix, setPix] = useState(toText(offer.pix_price));
  const [count, setCount] = useState(offer.installments ? String(offer.installments.count) : "");
  const [value, setValue] = useState(toText(offer.installments?.value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const p = toNumber(price);
    if (!p) return setError("Informe o preço.");
    const n = Number(count);
    const v = toNumber(value);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ result?: Offer }>(`/offers/${offer.id}/prices`, {
        method: "PATCH",
        body: {
          price: p,
          original_price: toNumber(original),
          pix_price: toNumber(pix),
          installments:
            Number.isInteger(n) && n >= 2 && v ? { count: n, value: v, interest_free: true } : null,
        },
      });
      if (res.result) onSaved(res.result);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao salvar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <p className="text-sm text-neutral-500">
        Copie os valores da página da loja. Deixe “Preço De” vazio se a página não mostra preço
        riscado.
      </p>
      <label className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-sm font-medium">Preço</span>
        <input
          className="input"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-sm font-medium">Preço De</span>
        <input
          className="input"
          inputMode="decimal"
          value={original}
          placeholder="sem preço riscado"
          onChange={(e) => setOriginal(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-sm font-medium">No Pix</span>
        <input
          className="input"
          inputMode="decimal"
          value={pix}
          onChange={(e) => setPix(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-sm font-medium">Parcelas</span>
        <input
          className="input w-16"
          inputMode="numeric"
          aria-label="Quantidade de parcelas"
          value={count}
          placeholder="12"
          onChange={(e) => setCount(e.target.value.replace(/\D/g, "").slice(0, 2))}
        />
        <span className="text-sm text-neutral-500">x de R$</span>
        <input
          className="input min-w-0 flex-1"
          inputMode="decimal"
          aria-label="Valor da parcela"
          value={value}
          placeholder="20,18"
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <ErrorText error={error} />
      <LoadingButton busy={busy} type="submit" className="mt-2 h-11 w-full text-base">
        Salvar preços
      </LoadingButton>
    </form>
  );
}
