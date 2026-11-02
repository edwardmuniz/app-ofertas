"use client";

import type { Offer, Storefront, StorefrontDesign } from "@ofertas/contracts";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ImageField } from "@/components/image-field";
import { ChoiceCards, Field, LoadingButton, Panel } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { money } from "@/lib/format";

/** Aparência e conteúdo da vitrine: cores, capa, botões, links, destaques e seções. */
export function DesignPanel({ sf, onSaved }: { sf: Storefront; onSaved: (s: Storefront) => void }) {
  const [d, setD] = useState<StorefrontDesign>(sf.design);
  // Chaves estáveis para as linhas de links (o texto muda enquanto digita).
  const [linkKeys, setLinkKeys] = useState<string[]>(() =>
    sf.design.links.map(() => crypto.randomUUID()),
  );
  const [approved, setApproved] = useState<Offer[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setD(sf.design);
    setLinkKeys(sf.design.links.map(() => crypto.randomUUID()));
  }, [sf.design]);
  useEffect(() => {
    api<{ items: Offer[] }>("/offers?status=approved&limit=100").then((p) => setApproved(p.items));
  }, []);

  const set = <K extends keyof StorefrontDesign>(k: K, v: StorefrontDesign[K]) =>
    setD((cur) => ({ ...cur, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await api<{ result?: Storefront }>("/storefront", {
        method: "PATCH",
        body: {
          design: {
            ...d,
            cover_url: d.cover_url?.trim() || null,
            links: d.links.filter((l) => l.label.trim() && l.url.trim()),
          },
        },
      });
      if (res.result) onSaved(res.result);
      setMsg({
        ok: true,
        text: "Aparência salva. Abra a vitrine para conferir (atualiza em até 1 minuto).",
      });
    } catch (err) {
      setMsg({
        ok: false,
        text: err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao salvar.",
      });
    } finally {
      setSaving(false);
    }
  }

  const color = (k: "accent_color" | "background_color" | "text_color", label: string) => (
    <Field label={label} htmlFor={`d_${k}`}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          id={`d_${k}`}
          value={d[k]}
          onChange={(e) => set(k, e.target.value.toUpperCase())}
          className="h-9 w-12 cursor-pointer rounded border border-neutral-200 dark:border-neutral-700"
        />
        <input
          className="input font-mono"
          value={d[k]}
          maxLength={7}
          aria-label={label}
          onChange={(e) => set(k, e.target.value)}
        />
      </div>
    </Field>
  );

  const featured = d.featured_offer_ids;
  return (
    <Panel
      title="Aparência e conteúdo"
      subtitle="Deixe a vitrine com a cara da sua marca. As mudanças aparecem em até 1 minuto."
    >
      <form onSubmit={save} className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          {color("accent_color", "Cor principal (botões)")}
          {color("background_color", "Fundo")}
          {color("text_color", "Texto")}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <ImageField
            label="Imagem de capa (opcional)"
            value={d.cover_url ?? ""}
            onChange={(url) => set("cover_url", url || null)}
            shape="wide"
            hint="Formato largo, ex.: 1200×400."
          />
          <Field label="Texto do botão do grupo" htmlFor="d_join">
            <input
              className="input"
              id="d_join"
              value={d.join_label}
              maxLength={40}
              onChange={(e) => set("join_label", e.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <div className="label">Links extras (Instagram, TikTok, outro grupo…)</div>
          {d.links.map((l, i) => (
            <div key={linkKeys[i] ?? `novo-${i}`} className="flex flex-wrap items-center gap-2">
              <input
                className="input w-40"
                placeholder="Texto"
                aria-label="Texto do link"
                value={l.label}
                maxLength={40}
                onChange={(e) =>
                  set(
                    "links",
                    d.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  )
                }
              />
              <input
                className="input min-w-0 flex-1"
                type="url"
                placeholder="https://instagram.com/suamarca"
                aria-label="Endereço do link"
                value={l.url}
                onChange={(e) =>
                  set(
                    "links",
                    d.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                  )
                }
              />
              <button
                type="button"
                className="btn-ghost px-2"
                aria-label="Remover link"
                onClick={() => {
                  set(
                    "links",
                    d.links.filter((_, j) => j !== i),
                  );
                  setLinkKeys((k) => k.filter((_, j) => j !== i));
                }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {d.links.length < 6 && (
            <button
              type="button"
              className="btn-ghost inline-flex items-center gap-1.5"
              onClick={() => {
                set("links", [...d.links, { label: "", url: "" }]);
                setLinkKeys((k) => [...k, crypto.randomUUID()]);
              }}
            >
              <Plus className="h-4 w-4" /> Adicionar link
            </button>
          )}
        </div>

        <div className="space-y-2">
          <div className="label">Quais ofertas aparecem</div>
          <ChoiceCards
            columns={2}
            value={d.offers_mode}
            onChange={(v) => set("offers_mode", v)}
            options={[
              {
                value: "auto",
                label: "Automático",
                hint: "Seus destaques no topo e, abaixo, as melhores aprovadas dos últimos 7 dias.",
              },
              {
                value: "featured_only",
                label: "Só os destaques",
                hint: "Mostra apenas as ofertas que você fixar abaixo.",
              },
            ]}
          />
        </div>

        <div className="space-y-2">
          <div className="label">Destaques fixados no topo ({featured.length} de 6)</div>
          {approved.length === 0 ? (
            <p className="text-sm text-neutral-500">Nenhuma oferta aprovada agora.</p>
          ) : (
            <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
              {approved.map((o) => {
                const on = featured.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        "featured_offer_ids",
                        on
                          ? featured.filter((x) => x !== o.id)
                          : featured.length < 6
                            ? [...featured, o.id]
                            : featured,
                      )
                    }
                    className={`flex items-center gap-3 rounded-lg border p-2 text-left text-sm ${
                      on
                        ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-900"
                        : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800"
                    }`}
                  >
                    {o.image_url ? (
                      // biome-ignore lint/performance/noImgElement: imagem externa da loja
                      <img
                        src={o.image_url}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded object-contain"
                      />
                    ) : (
                      <span className="h-10 w-10 shrink-0 rounded bg-neutral-100" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-1">{o.title}</span>
                      <span className="text-xs text-neutral-500">{money(o.price)}</span>
                    </span>
                    {on && (
                      <span className="text-xs font-semibold">{featured.indexOf(o.id) + 1}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Título da seção de ofertas" htmlFor="d_title">
            <input
              className="input"
              id="d_title"
              value={d.offers_title}
              maxLength={60}
              onChange={(e) => set("offers_title", e.target.value)}
            />
          </Field>
          <Field label="Quantidade máxima de ofertas" htmlFor="d_max">
            <input
              className="input"
              id="d_max"
              type="number"
              min={4}
              max={48}
              value={d.max_offers}
              onChange={(e) =>
                set("max_offers", Math.min(48, Math.max(4, Number(e.target.value) || 24)))
              }
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={d.group_by_category}
            onChange={(e) => set("group_by_category", e.target.checked)}
          />
          Separar as ofertas por categoria
        </label>
        <Field label="Aviso do rodapé" htmlFor="d_footer">
          <textarea
            className="input"
            id="d_footer"
            rows={2}
            maxLength={300}
            value={d.footer_note}
            onChange={(e) => set("footer_note", e.target.value)}
          />
        </Field>

        <div className="flex items-center gap-3">
          <LoadingButton busy={saving} type="submit">
            Salvar aparência
          </LoadingButton>
          {msg && (
            <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>
              {msg.text}
            </span>
          )}
        </div>
      </form>
    </Panel>
  );
}
