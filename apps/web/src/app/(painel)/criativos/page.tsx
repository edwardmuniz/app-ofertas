"use client";

import type { BrandKit, Creative, Offer, UploadTicket } from "@ofertas/contracts";
import { Check, Loader2, Search, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Chip,
  ChoiceCards,
  ConfirmButton,
  Empty,
  ErrorText,
  Field,
  Loading,
  LoadingButton,
  PageHeader,
  Tag,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { money } from "@/lib/format";

type Mutation<T> = { status: string; result?: T };

const FORMATS = [
  { key: "wa_image", label: "1:1 · WhatsApp", box: "h-4 w-4" },
  { key: "feed_4x5", label: "4:5 · Feed", box: "h-5 w-4" },
  { key: "story_9x16", label: "9:16 · Story", box: "h-6 w-3.5" },
];

const TEMPLATES = [
  { value: "card_preco", label: "Card de preço", hint: "Foto, preço, preço antigo e desconto" },
  { value: "cupom_destaque", label: "Cupom em destaque", hint: "O cupom em evidência no card" },
] as const;

const COLORS = [
  ["primary_color", "Destaque"],
  ["secondary_color", "Fundo"],
  ["text_color", "Texto"],
] as const;

/** Upload passa pelo proxy do painel (/api) para evitar CORS. */
const viaProxy = (url: string) => {
  const u = new URL(url);
  return `/api${u.pathname}${u.search}`;
};

export default function CriativosPage() {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [offers, setOffers] = useState<Offer[]>([]);
  const [items, setItems] = useState<Creative[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"kit" | "generate" | "upload" | null>(null);
  const [formats, setFormats] = useState<string[]>(["wa_image"]);
  const [template, setTemplate] = useState<string>("card_preco");
  const [offerId, setOfferId] = useState("");
  const [query, setQuery] = useState("");
  const [kitOpen, setKitOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(c: Creative) {
    setError(null);
    setRemoving(c.id);
    try {
      await api(`/creatives/${c.id}`, { method: "DELETE" });
      // Some da galeria na hora, sem recarregar tudo.
      setItems((list) => list.filter((x) => x.id !== c.id));
      setMsg("Criativo removido.");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao remover.");
    } finally {
      setRemoving(null);
    }
  }

  const load = useCallback(async () => {
    const [k, o, c] = await Promise.all([
      api<BrandKit>("/brand-kit"),
      api<{ items: Offer[] }>("/offers?status=approved&limit=100"),
      api<{ items: Creative[] }>("/creatives?limit=60"),
    ]);
    setKit(k);
    setColors({
      primary_color: k.primary_color,
      secondary_color: k.secondary_color,
      text_color: k.text_color,
    });
    setOffers(o.items);
    setOfferId((cur) => cur || o.items[0]?.id || "");
    setItems(c.items);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(kind: "kit" | "generate" | "upload", fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMsg(null);
    setBusy(kind);
    try {
      await fn();
      await load();
      setMsg(ok);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
    } finally {
      setBusy(null);
    }
  }

  async function saveKit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(
      "kit",
      () =>
        api("/brand-kit", {
          method: "PATCH",
          body: { name: f.get("name"), ...colors, cta: f.get("cta") },
        }),
      "Identidade visual salva. Os próximos cards já saem com ela.",
    );
  }

  async function generate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(
      "generate",
      () =>
        api<Mutation<Creative>>("/creatives/generate", {
          method: "POST",
          body: {
            offer_id: offerId,
            template,
            formats,
            headline: String(f.get("headline") ?? "") || undefined,
          },
        }),
      "Card gerado. Ele aparece primeiro na galeria abaixo.",
    );
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await run(
      "upload",
      async () => {
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
      },
      "Imagem enviada.",
    );
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return offers.filter((o) => !q || o.title.toLowerCase().includes(q));
  }, [offers, query]);

  if (!kit) return <Loading />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Criativos"
        subtitle="Cards de oferta com a sua identidade visual e imagens próprias"
        actions={
          <label
            className={`btn-ghost inline-flex cursor-pointer items-center gap-1.5 ${busy === "upload" ? "pointer-events-none opacity-60" : ""}`}
          >
            {busy === "upload" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {busy === "upload" ? "Enviando…" : "Enviar imagem própria"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={upload}
            />
          </label>
        }
      />
      <ErrorText error={error} />
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}

      <form onSubmit={generate} className="card space-y-4">
        <h2 className="font-medium">Gerar card de uma oferta</h2>
        {offers.length === 0 ? (
          <Empty>
            Nenhuma oferta aprovada. Aprove em{" "}
            <Link className="underline" href="/ofertas">
              Ofertas
            </Link>
            .
          </Empty>
        ) : (
          <div className="space-y-2">
            <div className="relative max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                className="input pl-8"
                placeholder="Buscar oferta"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((o) => {
                const on = offerId === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setOfferId(o.id)}
                    className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-colors ${
                      on
                        ? "border-brand-500 bg-brand-50/60 dark:bg-brand-500/10"
                        : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
                    }`}
                  >
                    {o.image_url ? (
                      // biome-ignore lint/performance/noImgElement: imagens externas das plataformas
                      <img
                        src={o.image_url}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="h-10 w-10 shrink-0 rounded bg-neutral-100 dark:bg-neutral-800" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-1 text-sm">{o.title}</span>
                      <span className="text-xs text-neutral-500 tabular-nums">
                        {money(o.price)}
                        {o.discount_pct ? ` · -${o.discount_pct}%` : ""}
                      </span>
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <div className="label">Modelo</div>
          <ChoiceCards
            columns={2}
            options={TEMPLATES}
            value={template as (typeof TEMPLATES)[number]["value"]}
            onChange={setTemplate}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <div className="label">Formatos</div>
            <div className="flex flex-wrap gap-2">
              {FORMATS.map((f) => (
                <Chip
                  key={f.key}
                  on={formats.includes(f.key)}
                  onClick={() =>
                    setFormats((s) =>
                      s.includes(f.key) ? s.filter((x) => x !== f.key) : [...s, f.key],
                    )
                  }
                >
                  <span className={`inline-block rounded-sm border border-current ${f.box}`} />
                  {f.label}
                </Chip>
              ))}
            </div>
          </div>
          <Field label="Texto no topo (opcional)" htmlFor="headline">
            <input className="input" id="headline" name="headline" placeholder="BLACK FRIDAY" />
          </Field>
        </div>
        <LoadingButton
          busy={busy === "generate"}
          type="submit"
          disabled={!offerId || !formats.length}
        >
          {busy === "generate" ? "Gerando…" : "Gerar card"}
        </LoadingButton>
      </form>

      <section className="card space-y-4">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 text-left"
          aria-expanded={kitOpen}
          onClick={() => setKitOpen(!kitOpen)}
        >
          <span>
            <span className="block font-medium">Identidade visual</span>
            <span className="text-sm text-neutral-500">
              {kit.name} · chamada “{kit.cta}”
            </span>
          </span>
          <span className="flex items-center gap-1">
            {COLORS.map(([k]) => (
              <span
                key={k}
                className="h-6 w-6 rounded-full border border-neutral-200 dark:border-neutral-700"
                style={{ background: colors[k] }}
              />
            ))}
            <span className="ml-2 text-sm text-neutral-500">{kitOpen ? "Fechar" : "Editar"}</span>
          </span>
        </button>
        {kitOpen && (
          <form onSubmit={saveKit} className="grid gap-4 md:grid-cols-2">
            <Field label="Nome da marca" htmlFor="name">
              <input className="input" id="name" name="name" defaultValue={kit.name} />
            </Field>
            <Field label="Chamada do card" htmlFor="cta">
              <input className="input" id="cta" name="cta" defaultValue={kit.cta} />
            </Field>
            <div className="flex flex-wrap gap-4 md:col-span-2">
              {COLORS.map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input
                    className="h-9 w-12 cursor-pointer rounded-md border border-neutral-300 dark:border-neutral-700"
                    type="color"
                    value={colors[k] ?? "#000000"}
                    onChange={(e) => setColors({ ...colors, [k]: e.target.value })}
                  />
                  <span>
                    <span className="block">{label}</span>
                    <span className="font-mono text-xs text-neutral-500 uppercase">
                      {colors[k]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="md:col-span-2">
              <LoadingButton busy={busy === "kit"} type="submit">
                Salvar identidade
              </LoadingButton>
            </div>
          </form>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Galeria</h2>
        {items.length === 0 ? (
          <Empty>Os cards gerados e as imagens enviadas aparecem aqui.</Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                <div className="flex items-start justify-between gap-2">
                  <div className="line-clamp-2 text-sm">{c.title}</div>
                  <ConfirmButton
                    className="shrink-0 px-2 py-1 text-xs"
                    busy={removing === c.id}
                    onConfirm={() => remove(c)}
                    message="Remover este criativo e as imagens dele?"
                  >
                    Remover
                  </ConfirmButton>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                  <Tag>
                    {c.origin === "template"
                      ? (TEMPLATES.find((t) => t.value === c.template)?.label ?? "Card")
                      : c.origin === "upload"
                        ? "Enviada"
                        : "Importada"}
                  </Tag>
                  {c.ai_generated && <Tag tone="info">IA</Tag>}
                  <span>por {c.created_by}</span>
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
          </div>
        )}
      </section>
    </div>
  );
}
