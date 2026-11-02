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
export function OfferPricePanel({
  offer,
  onClose,
  onSaved,
}: {
  offer: Offer;
  onClose: () => void;
  onSaved: (o: Offer) => void;
}) {
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
    <form onSubmit={save} className="flex h-full flex-col gap-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">Ajustar preços</span>
        <button
          type="button"
          className="text-xs text-neutral-500 hover:underline"
          onClick={onClose}
        >
          Cancelar
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        Copie da página da loja. Deixe “De” vazio se a página não mostra preço riscado.
      </p>
      <label className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs text-neutral-500">Preço</span>
        <input
          className="input"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs text-neutral-500">De</span>
        <input
          className="input"
          inputMode="decimal"
          value={original}
          placeholder="sem preço riscado"
          onChange={(e) => setOriginal(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs text-neutral-500">Pix</span>
        <input
          className="input"
          inputMode="decimal"
          value={pix}
          onChange={(e) => setPix(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs text-neutral-500">Parcelas</span>
        <input
          className="input w-14"
          inputMode="numeric"
          aria-label="Quantidade de parcelas"
          value={count}
          placeholder="12"
          onChange={(e) => setCount(e.target.value.replace(/\D/g, "").slice(0, 2))}
        />
        <span className="text-xs text-neutral-500">x</span>
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
      <LoadingButton busy={busy} type="submit" className="mt-auto">
        Salvar preços
      </LoadingButton>
    </form>
  );
}
