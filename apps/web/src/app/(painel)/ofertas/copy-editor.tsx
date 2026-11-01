"use client";

import type { Offer } from "@ofertas/contracts";
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ErrorText, Field, LoadingButton, Tag } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

type Mutation<T> = { status: string; result?: T; preview?: T };
type Draft = { headline: string; body: string; extra: string };

const SOURCE_LABEL: Record<NonNullable<Offer["copy"]>["source"], string> = {
  ai: "Gerado por IA",
  agent: "Escrito pelo agente",
  human: "Escrito à mão",
};

const errText = (err: unknown) =>
  err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.";

/**
 * Texto próprio da mensagem da oferta: chamada, descrição e fechamento. A IA (Gemini) sugere,
 * a pessoa revisa e salva. Preço, Pix, parcelas e link entram sozinhos no envio.
 */
export function CopyEditor({
  offer,
  onClose,
  onSaved,
}: {
  offer: Offer;
  onClose: () => void;
  onSaved: (o: Offer) => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    headline: offer.copy?.headline ?? "",
    body: offer.copy?.body ?? "",
    extra: offer.copy?.extra ?? "",
  });
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState<"ai" | "save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [current, setCurrent] = useState<Offer>(offer);

  const loadPreview = useCallback(async () => {
    const res = await api<{ body: string }>("/posts/preview", {
      method: "POST",
      body: { offer_id: offer.id },
    }).catch(() => null);
    setPreview(res?.body ?? null);
  }, [offer.id]);
  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  async function generate() {
    setBusy("ai");
    setError(null);
    try {
      // dry_run: a IA sugere e nada é salvo até a pessoa revisar.
      const res = await api<Mutation<{ copy: NonNullable<Offer["copy"]> }>>(
        `/offers/${offer.id}/copy/generate?dry_run=true`,
        { method: "POST", body: hint.trim() ? { hint: hint.trim() } : {} },
      );
      const c = res.preview?.copy;
      if (c) setDraft({ headline: c.headline, body: c.body, extra: c.extra ?? "" });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function save(clear = false) {
    setBusy(clear ? "clear" : "save");
    setError(null);
    try {
      const res = await api<Mutation<Offer>>(`/offers/${offer.id}/copy`, {
        method: "PUT",
        body: {
          copy: clear
            ? null
            : {
                headline: draft.headline.trim(),
                body: draft.body.trim(),
                extra: draft.extra.trim() || null,
              },
        },
      });
      if (res.result) {
        setCurrent(res.result);
        if (clear) setDraft({ headline: "", body: "", extra: "" });
        onSaved(res.result);
        await loadPreview();
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  const ready = draft.headline.trim().length >= 3 && draft.body.trim().length >= 3;
  const set = (k: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <section id="copy-editor" className="card space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            Texto da mensagem
            {current.copy && <Tag tone="info">{SOURCE_LABEL[current.copy.source]}</Tag>}
          </div>
          <p className="line-clamp-1 text-sm text-neutral-500">{offer.title}</p>
        </div>
        <button
          type="button"
          className="text-xs text-neutral-500 hover:underline"
          onClick={onClose}
        >
          Fechar
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              className="input min-w-0 flex-1"
              value={hint}
              maxLength={200}
              onChange={(e) => setHint(e.target.value)}
              placeholder="Pedido para a IA (opcional), ex.: foque em quem joga"
              aria-label="Pedido para a IA"
            />
            <LoadingButton busy={busy === "ai"} onClick={generate} disabled={busy !== null}>
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5" />
                {busy === "ai" ? "Gerando…" : draft.headline ? "Gerar outro" : "Gerar com IA"}
              </span>
            </LoadingButton>
          </div>
          <Field label="Chamada (em negrito no topo)" htmlFor="cp_headline">
            <input
              className="input"
              id="cp_headline"
              value={draft.headline}
              maxLength={90}
              onChange={set("headline")}
              placeholder="Garanta o tão esperado GTA VI para PS5!"
            />
          </Field>
          <Field label="Descrição" htmlFor="cp_body">
            <textarea
              className="input"
              id="cp_body"
              rows={3}
              value={draft.body}
              maxLength={320}
              onChange={set("body")}
              placeholder="Prepare-se para Vice City! Reserve o seu e garanta seu lugar no lançamento."
            />
          </Field>
          <Field label="Fechamento (opcional)" htmlFor="cp_extra">
            <input
              className="input"
              id="cp_extra"
              value={draft.extra}
              maxLength={200}
              onChange={set("extra")}
              placeholder="Aproveite antes que o estoque acabe."
            />
          </Field>
          <p className="text-xs text-neutral-500">
            Não escreva preço nem link: a linha “De ~R$ X~ por R$ Y no Pix ou 12x sem juros” e o
            link entram sozinhos no envio, com o preço conferido na hora.
          </p>
          <ErrorText error={error} />
          <div className="flex flex-wrap gap-2">
            <LoadingButton
              busy={busy === "save"}
              disabled={!ready || busy !== null}
              onClick={() => save()}
            >
              Salvar texto
            </LoadingButton>
            {current.copy && (
              <LoadingButton
                variant="btn-ghost"
                busy={busy === "clear"}
                disabled={busy !== null}
                onClick={() => save(true)}
              >
                Voltar ao modelo padrão
              </LoadingButton>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-neutral-500">
            Como a mensagem vai ficar {current.copy ? "" : "(modelo padrão)"}
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg bg-[#e7ffdb] p-3 text-xs whitespace-pre-wrap text-neutral-900 dark:bg-emerald-950 dark:text-emerald-50">
            {preview ?? "…"}
          </pre>
        </div>
      </div>
    </section>
  );
}
