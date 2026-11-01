"use client";

import type { Offer, OfferLinkPreview } from "@ofertas/contracts";
import { ImageOff, Link2 } from "lucide-react";
import { useState } from "react";
import { ErrorText, Field, LoadingButton, PlatformBadge, Tag } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { money } from "@/lib/format";

/** "79,90", "1.299,90" ou "79.90" → número. */
function toNumber(v: string): number | null {
  let s = v.replace(/[^\d.,]/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const toText = (n: number | null) => (n ? n.toFixed(2).replace(".", ",") : "");

const FOUND_HINT = (p: OfferLinkPreview) =>
  p.source === "platform" ? "Dados da API da loja" : "Lido da página da loja";

/**
 * Cria uma oferta colando um link de produto: busca título, foto e preço e deixa conferir
 * (e completar o que a loja não mostrou) antes de salvar.
 */
export function FromLinkPanel({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (offer: Offer) => void;
}) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<OfferLinkPreview | null>(null);
  const [title, setTitle] = useState("");
  const [image, setImage] = useState("");
  const [price, setPrice] = useState("");
  const [original, setOriginal] = useState("");
  const [coupon, setCoupon] = useState("");
  const [busy, setBusy] = useState<"read" | "approved" | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageBroken, setImageBroken] = useState(false);

  const fail = (err: unknown, fallback: string) =>
    setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : fallback);

  async function read(e: React.FormEvent) {
    e.preventDefault();
    setBusy("read");
    setError(null);
    try {
      const p = await api<OfferLinkPreview>("/offers/from-link/preview", {
        method: "POST",
        body: { url: url.trim() },
      });
      setPreview(p);
      setTitle(p.title ?? "");
      setImage(p.image_url ?? "");
      setPrice(toText(p.price));
      setOriginal(toText(p.original_price));
      setImageBroken(false);
    } catch (err) {
      fail(err, "Não foi possível abrir o link.");
    } finally {
      setBusy(null);
    }
  }

  const priceN = toNumber(price);
  const originalN = toNumber(original);
  const discount =
    priceN && originalN && originalN > priceN ? Math.round((1 - priceN / originalN) * 100) : null;

  async function save(status: "approved" | "new") {
    if (!preview || !priceN) return;
    setBusy(status);
    setError(null);
    try {
      const res = await api<{ status: string; result?: Offer }>("/offers/from-link", {
        method: "POST",
        body: {
          url: preview.affiliate_url,
          title: title.trim(),
          image_url: image.trim() || null,
          price: priceN,
          original_price: originalN && priceN && originalN > priceN ? originalN : null,
          ...(coupon.trim() && { coupon_code: coupon.trim() }),
          status,
        },
      });
      if (res.result) onSaved(res.result);
    } catch (err) {
      fail(err, "Erro ao salvar a oferta.");
    } finally {
      setBusy(null);
    }
  }

  const needs = (k: OfferLinkPreview["missing"][number]) => preview?.missing.includes(k);

  return (
    <div className="card space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 font-medium">
            <Link2 className="h-4 w-4" /> Oferta por link
          </div>
          <p className="text-sm text-neutral-500">
            Cole o link de afiliado do produto (o que você gera no portal da loja). Funciona com
            Shopee, Mercado Livre, Amazon e Magalu.
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-neutral-500 hover:underline"
          onClick={onClose}
        >
          Fechar
        </button>
      </div>

      <form onSubmit={read} className="flex flex-wrap gap-2">
        <input
          className="input min-w-0 flex-1"
          type="url"
          required
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setPreview(null);
          }}
          placeholder="https://s.shopee.com.br/…"
          aria-label="Link do produto"
        />
        <LoadingButton busy={busy === "read"} type="submit" disabled={!url.trim()}>
          {busy === "read" ? "Buscando…" : "Buscar dados"}
        </LoadingButton>
      </form>

      <ErrorText error={error} />

      {preview && (
        <div className="space-y-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <PlatformBadge platform={preview.platform} />
            <Tag tone={preview.missing.length ? "warning" : "positive"} dot>
              {preview.missing.length
                ? `Faltou: ${preview.missing
                    .map((m) => ({ title: "título", image: "foto", price: "preço" })[m])
                    .join(", ")}`
                : FOUND_HINT(preview)}
            </Tag>
            {preview.existing_offer_id && (
              <Tag tone="info">Já existe oferta deste produto: salvar atualiza ela</Tag>
            )}
          </div>

          {!preview.is_affiliate_link && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
              Esse parece ser o link comum da loja, sem a sua comissão. Gere o link de afiliado no
              portal da loja e cole aquele.
            </p>
          )}
          {preview.platform === "shopee" && (needs("image") || needs("price")) && (
            <p className="text-xs text-neutral-500">
              A Shopee não mostra foto e preço para robôs. Abra o produto no navegador, copie o
              preço e, na foto, clique com o botão direito → <em>Copiar endereço da imagem</em>.
            </p>
          )}

          <div className="grid gap-4 md:grid-cols-[160px_1fr]">
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
              {image && !imageBroken ? (
                // biome-ignore lint/performance/noImgElement: imagem externa da loja
                <img
                  src={image}
                  alt=""
                  className="h-full w-full object-cover"
                  onError={() => setImageBroken(true)}
                />
              ) : (
                <span className="flex flex-col items-center gap-1 text-xs text-neutral-400">
                  <ImageOff className="h-6 w-6" />
                  {imageBroken ? "Foto não abriu" : "Sem foto"}
                </span>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <Field label={needs("title") ? "Título (preencha)" : "Título"} htmlFor="fl_title">
                  <input
                    className="input"
                    id="fl_title"
                    value={title}
                    maxLength={300}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>
              </div>
              <div className="md:col-span-2">
                <Field
                  label={needs("image") ? "Endereço da foto (preencha)" : "Endereço da foto"}
                  htmlFor="fl_image"
                >
                  <input
                    className="input"
                    id="fl_image"
                    type="url"
                    value={image}
                    placeholder="https://…jpg"
                    onChange={(e) => {
                      setImage(e.target.value);
                      setImageBroken(false);
                    }}
                  />
                </Field>
              </div>
              <Field
                label={needs("price") ? "Preço atual (preencha)" : "Preço atual"}
                htmlFor="fl_price"
              >
                <input
                  className="input"
                  id="fl_price"
                  inputMode="decimal"
                  value={price}
                  placeholder="79,90"
                  onChange={(e) => setPrice(e.target.value)}
                />
              </Field>
              <Field label="Preço antigo (opcional)" htmlFor="fl_original">
                <input
                  className="input"
                  id="fl_original"
                  inputMode="decimal"
                  value={original}
                  placeholder="159,90"
                  onChange={(e) => setOriginal(e.target.value)}
                />
              </Field>
              <Field label="Cupom (opcional)" htmlFor="fl_coupon">
                <input
                  className="input"
                  id="fl_coupon"
                  value={coupon}
                  maxLength={60}
                  onChange={(e) => setCoupon(e.target.value)}
                />
              </Field>
              <div className="flex items-end text-sm text-neutral-600 dark:text-neutral-400">
                {priceN ? (
                  <span>
                    Sai como <strong>{money(priceN)}</strong>
                    {discount ? ` · ${discount}% OFF` : ""}
                  </span>
                ) : (
                  <span className="text-neutral-400">Informe o preço para salvar</span>
                )}
              </div>
            </div>
          </div>

          <p className="text-xs text-neutral-500">
            {preview.source === "platform"
              ? "Com a conta da loja conectada, o preço é conferido antes de cada envio."
              : "Sem a API da loja, o preço não é conferido antes do envio: se mudar, atualize colando o link de novo."}
          </p>

          <div className="flex flex-wrap gap-2">
            <LoadingButton
              busy={busy === "approved"}
              disabled={!priceN || title.trim().length < 3 || busy !== null}
              onClick={() => save("approved")}
            >
              Salvar aprovada
            </LoadingButton>
            <LoadingButton
              variant="btn-ghost"
              busy={busy === "new"}
              disabled={!priceN || title.trim().length < 3 || busy !== null}
              onClick={() => save("new")}
            >
              Mandar para curadoria
            </LoadingButton>
          </div>
        </div>
      )}
    </div>
  );
}
