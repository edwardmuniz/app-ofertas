"use client";

import type { BrandKit, Creative, Offer, UploadTicket } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { ErrorText, Field } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

type Mutation<T> = { status: string; result?: T };

const FORMATS = [
  { key: "wa_image", label: "1:1 WhatsApp" },
  { key: "feed_4x5", label: "4:5 Feed" },
  { key: "story_9x16", label: "9:16 Story" },
];

/** Upload passa pelo proxy do painel (/api) para evitar CORS. */
const viaProxy = (url: string) => {
  const u = new URL(url);
  return `/api${u.pathname}${u.search}`;
};

export default function CriativosPage() {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [items, setItems] = useState<Creative[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formats, setFormats] = useState<string[]>(["wa_image"]);

  const load = useCallback(async () => {
    const [k, o, c] = await Promise.all([
      api<BrandKit>("/brand-kit"),
      api<{ items: Offer[] }>("/offers?status=approved&limit=100"),
      api<{ items: Creative[] }>("/creatives?limit=60"),
    ]);
    setKit(k);
    setOffers(o.items);
    setItems(c.items);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
    } finally {
      setBusy(false);
    }
  }

  async function saveKit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(() =>
      api("/brand-kit", {
        method: "PATCH",
        body: {
          name: f.get("name"),
          primary_color: f.get("primary_color"),
          secondary_color: f.get("secondary_color"),
          text_color: f.get("text_color"),
          cta: f.get("cta"),
        },
      }),
    );
  }

  async function generate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(() =>
      api<Mutation<Creative>>("/creatives/generate", {
        method: "POST",
        body: {
          offer_id: f.get("offer_id"),
          template: f.get("template"),
          formats,
          headline: String(f.get("headline") ?? "") || undefined,
        },
      }),
    );
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await run(async () => {
      const t = await api<Mutation<UploadTicket>>("/creatives/uploads", {
        method: "POST",
        body: { filename: file.name, mime: file.type, size_bytes: file.size },
      });
      if (!t.result) throw new Error("Sem link de upload");
      const res = await fetch(viaProxy(t.result.put_url), {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      await api(`/creatives/uploads/${t.result.upload_id}/complete`, {
        method: "POST",
        body: { title: file.name },
      });
    });
  }

  if (!kit) return <p className="text-sm text-neutral-500">Carregando…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Criativos</h1>
      <ErrorText error={error} />

      <form onSubmit={saveKit} className="card grid gap-3 md:grid-cols-5 md:items-end">
        <h2 className="font-medium md:col-span-5">Identidade visual</h2>
        <Field label="Nome" htmlFor="name">
          <input className="input" id="name" name="name" defaultValue={kit.name} />
        </Field>
        {(["primary_color", "secondary_color", "text_color"] as const).map((k) => (
          <Field
            key={k}
            label={{ primary_color: "Destaque", secondary_color: "Fundo", text_color: "Texto" }[k]}
            htmlFor={k}
          >
            <input
              className="h-10 w-full rounded-lg border border-neutral-300 dark:border-neutral-700"
              type="color"
              id={k}
              name={k}
              defaultValue={kit[k]}
            />
          </Field>
        ))}
        <Field label="Chamada" htmlFor="cta">
          <input className="input" id="cta" name="cta" defaultValue={kit.cta} />
        </Field>
        <div className="md:col-span-5">
          <button className="btn" type="submit" disabled={busy}>
            Salvar identidade
          </button>
        </div>
      </form>

      <form onSubmit={generate} className="card grid gap-3 md:grid-cols-3">
        <h2 className="font-medium md:col-span-3">Gerar card de uma oferta</h2>
        <div className="md:col-span-3">
          <Field label="Oferta aprovada" htmlFor="offer_id">
            <select className="input" id="offer_id" name="offer_id" required>
              {offers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Template" htmlFor="template">
          <select className="input" id="template" name="template" defaultValue="card_preco">
            <option value="card_preco">Card de preço</option>
            <option value="cupom_destaque">Cupom em destaque</option>
          </select>
        </Field>
        <Field label="Texto no topo (opcional)" htmlFor="headline">
          <input className="input" id="headline" name="headline" placeholder="BLACK FRIDAY" />
        </Field>
        <div>
          <span className="label">Formatos</span>
          <div className="flex flex-wrap gap-3 text-sm">
            {FORMATS.map((f) => (
              <label key={f.key} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={formats.includes(f.key)}
                  onChange={() =>
                    setFormats((s) =>
                      s.includes(f.key) ? s.filter((x) => x !== f.key) : [...s, f.key],
                    )
                  }
                />
                {f.label}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-3">
          <button
            className="btn"
            type="submit"
            disabled={busy || !offers.length || !formats.length}
          >
            {busy ? "Gerando…" : "Gerar"}
          </button>
          <label className="btn-ghost cursor-pointer">
            Enviar imagem própria
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={upload}
            />
          </label>
        </div>
      </form>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <div key={c.id} className="card space-y-2 p-3">
            <div className="flex gap-2 overflow-x-auto">
              {c.variants.map((v) => (
                <a
                  key={v.format}
                  href={v.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0"
                >
                  {/* biome-ignore lint/performance/noImgElement: imagens servidas pela API */}
                  <img
                    src={v.preview_url ?? v.url}
                    alt={v.format}
                    className="h-40 rounded-lg border border-neutral-200 object-contain dark:border-neutral-800"
                  />
                </a>
              ))}
            </div>
            <div className="line-clamp-1 text-sm">{c.title}</div>
            <div className="text-xs text-neutral-500">
              {c.origin === "template"
                ? `Template ${c.template}`
                : c.origin === "upload"
                  ? "Enviado"
                  : "Importado"}
              {c.ai_generated ? " · gerado por IA" : ""} · por {c.created_by}
            </div>
            {c.variants.some((v) => v.validation.length > 0) && (
              <div className="text-xs text-amber-700">
                {c.variants
                  .flatMap((v) => v.validation.map((i) => `${v.format}: ${i.message}`))
                  .join(" · ")}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
