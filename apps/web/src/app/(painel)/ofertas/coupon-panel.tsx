"use client";

import type { Offer } from "@ofertas/contracts";
import { useState } from "react";
import { ErrorText, LoadingButton } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

/** Data (AAAA-MM-DD) no fuso de São Paulo, para o campo de data. */
const toDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) : "";

/** Cupom da oferta: código, regra e até quando vale. Vencido, some da mensagem sozinho. */
export function OfferCouponPanel({
  offer,
  onSaved,
}: {
  offer: Offer;
  onSaved: (o: Offer) => void;
}) {
  const manual = offer.coupon_source !== "store";
  const [code, setCode] = useState(manual ? (offer.coupon_code ?? "") : "");
  const [rule, setRule] = useState(manual ? (offer.coupon_description ?? "") : "");
  const [day, setDay] = useState(toDay(offer.coupon_valid_until));
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = toDay(new Date().toISOString());

  async function send(remove: boolean) {
    const c = code.trim().toUpperCase();
    if (!remove && c.length < 2) return setError("Digite o código do cupom.");
    setBusy(remove ? "remove" : "save");
    setError(null);
    try {
      const res = await api<{ result?: Offer }>(`/offers/${offer.id}/coupon`, {
        method: "PUT",
        body: remove
          ? { coupon_code: null }
          : {
              coupon_code: c,
              coupon_description: rule.trim() || null,
              // Vale até o fim do dia escolhido, no horário de Brasília.
              coupon_valid_until: day ? `${day}T23:59:59-03:00` : null,
            },
      });
      if (res.result) onSaved(res.result);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao salvar.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        send(false);
      }}
    >
      <p className="text-sm text-neutral-500">
        O cupom aparece na mensagem e no card. Quando a data passar, ele sai sozinho.
      </p>
      {offer.coupon_source === "store" && (
        <p className="rounded-lg bg-sky-50 p-3 text-sm text-sky-800 dark:bg-sky-500/10 dark:text-sky-300">
          Lido da página da loja: {offer.coupon_description}. Ele é atualizado sozinho a cada
          conferência de preço. Se você salvar um cupom aqui, ele passa a valer no lugar e não muda
          mais sozinho.
        </p>
      )}
      {offer.coupon_code && !offer.coupon_active && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
          O cupom {offer.coupon_code} venceu e não está saindo nas mensagens.
        </p>
      )}
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="cp_code">
          Código do cupom
        </label>
        <input
          className="input font-mono text-base uppercase"
          id="cp_code"
          value={code}
          maxLength={60}
          placeholder="ex.: BLACK20"
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="cp_rule">
          Regra do cupom (opcional)
        </label>
        <input
          className="input"
          id="cp_rule"
          value={rule}
          maxLength={200}
          placeholder="ex.: R$ 20 OFF acima de R$ 99"
          onChange={(e) => setRule(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="cp_day">
          Vale até (opcional)
        </label>
        <input
          className="input"
          id="cp_day"
          type="date"
          min={today}
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
        <p className="text-xs text-neutral-500">
          Vale até 23h59 do dia escolhido. Em branco, vale até você tirar.
        </p>
      </div>
      <ErrorText error={error} />
      <LoadingButton
        busy={busy === "save"}
        disabled={busy !== null}
        type="submit"
        className="h-11 w-full text-base"
      >
        Salvar cupom
      </LoadingButton>
      {(offer.coupon_code || offer.coupon_description) && (
        <LoadingButton
          variant="btn-ghost"
          busy={busy === "remove"}
          disabled={busy !== null}
          onClick={() => send(true)}
          className="h-11 w-full text-base"
        >
          Tirar o cupom
        </LoadingButton>
      )}
    </form>
  );
}
