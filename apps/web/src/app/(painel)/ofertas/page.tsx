"use client";

import type {
  Offer,
  OfferCandidate,
  OfferLink,
  SavedSearch,
  SearchOffersResult,
  ValidateOfferResult,
} from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { CopyButton, ErrorText, Field, PageHeader } from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";
import { FLAG_LABELS, money, scoreClass, TONE_CLASS } from "@/lib/format";

type Tab = "buscar" | "curadoria" | "aprovadas" | "buscas";
type Mutation<T> = { status: string; result?: T };

function Flags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => {
        const meta = FLAG_LABELS[f] ?? { label: f, tone: "info" as const };
        return (
          <span key={f} className={`rounded px-1.5 py-0.5 text-xs ${TONE_CLASS[meta.tone]}`}>
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}

function Price({
  price,
  original,
  discount,
}: {
  price: number;
  original: number | null;
  discount: number | null;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-semibold">{money(price)}</span>
      {original && <span className="text-xs text-neutral-500 line-through">{money(original)}</span>}
      {discount ? <span className="text-xs font-medium text-emerald-600">-{discount}%</span> : null}
    </div>
  );
}

function Score({ value }: { value: number }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums ${scoreClass(value)}`}
      title="Nota 0–100"
    >
      {value}
    </span>
  );
}

export default function OfertasPage() {
  const [tab, setTab] = useState<Tab>("buscar");
  const [error, setError] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);

  const refreshCount = useCallback(async () => {
    const page = await api<{ items: Offer[] }>("/offers?status=new&limit=100");
    setNewCount(page.items.length);
  }, []);
  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
      return null;
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "buscar", label: "Buscar" },
    { key: "curadoria", label: `Curadoria${newCount ? ` (${newCount})` : ""}` },
    { key: "aprovadas", label: "Aprovadas" },
    { key: "buscas", label: "Buscas salvas" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ofertas"
        subtitle="Busque, aprove e acompanhe ofertas das lojas conectadas"
      />
      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              tab === t.key
                ? "border-brand-500 font-medium text-neutral-900 dark:text-neutral-50"
                : "border-transparent text-neutral-500"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ErrorText error={error} />
      {tab === "buscar" && <SearchTab run={run} onSaved={refreshCount} />}
      {tab === "curadoria" && <OfferList status="new" run={run} onChange={refreshCount} />}
      {tab === "aprovadas" && <OfferList status="approved" run={run} onChange={refreshCount} />}
      {tab === "buscas" && <SavedSearchesTab run={run} />}
    </div>
  );
}

type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;

function SearchTab({ run, onSaved }: { run: Runner; onSaved: () => void }) {
  const [query, setQuery] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<SearchOffersResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function search(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
    const q = {
      keyword: String(f.get("keyword") ?? "") || undefined,
      min_discount: num("min_discount"),
      price_max: num("price_max"),
      sort: f.get("sort"),
      limit: 24,
    };
    setLoading(true);
    const res = await run(() =>
      api<SearchOffersResult>("/offers/search", { method: "POST", body: q }),
    );
    setLoading(false);
    if (res) {
      setResult(res);
      setQuery(q);
    }
  }

  async function save(c: OfferCandidate, status: "approved" | "new") {
    const res = await run(() =>
      api<Mutation<Offer>>("/offers", {
        method: "POST",
        body: { product_id: c.product_id, status },
      }),
    );
    if (res?.result && result) {
      setResult({
        ...result,
        items: result.items.map((i) =>
          i.product_id === c.product_id
            ? { ...i, offer_id: res.result?.id ?? null, offer_status: res.result?.status ?? null }
            : i,
        ),
      });
      onSaved();
    }
  }

  async function saveSearch() {
    const name = prompt("Nome da busca salva (roda sozinha a cada hora):");
    if (!name || !query) return;
    const res = await run(() =>
      api("/saved-searches", { method: "POST", body: { name, query, interval_minutes: 60 } }),
    );
    if (res) alert("Busca salva. As ofertas boas vão aparecer em Curadoria.");
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={search}
        className="card grid gap-3 md:grid-cols-[2fr_1fr_1fr_1fr_auto] md:items-end"
      >
        <Field label="Produto" htmlFor="keyword">
          <input
            className="input"
            id="keyword"
            name="keyword"
            placeholder="air fryer, fone, panelas…"
          />
        </Field>
        <Field label="Desconto mín. %" htmlFor="min_discount">
          <input
            className="input"
            id="min_discount"
            name="min_discount"
            type="number"
            min={0}
            max={95}
          />
        </Field>
        <Field label="Preço máx. R$" htmlFor="price_max">
          <input className="input" id="price_max" name="price_max" type="number" min={0} />
        </Field>
        <Field label="Ordenar" htmlFor="sort">
          <select className="input" id="sort" name="sort" defaultValue="relevance">
            <option value="relevance">Melhor nota</option>
            <option value="sales">Mais vendidos</option>
            <option value="commission">Maior comissão</option>
            <option value="price_asc">Menor preço</option>
          </select>
        </Field>
        <button className="btn" type="submit" disabled={loading}>
          {loading ? "Buscando…" : "Buscar"}
        </button>
      </form>

      {result && (
        <>
          <div className="flex items-center justify-between text-sm text-neutral-500">
            <span>{result.items.length} resultado(s)</span>
            <button type="button" className="btn-ghost" onClick={saveSearch}>
              Salvar esta busca
            </button>
          </div>
          {result.errors.map((e) => (
            <p key={e.platform} className="text-sm text-amber-700">
              {e.platform}: {e.message}
            </p>
          ))}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {result.items.map((c) => (
              <div key={c.product_id} className="card flex flex-col gap-2 p-3">
                <div className="flex gap-3">
                  {c.image_url && (
                    // biome-ignore lint/performance/noImgElement: imagens externas das plataformas
                    <img
                      src={c.image_url}
                      alt=""
                      className="h-20 w-20 shrink-0 rounded-lg object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm">{c.title}</div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {c.rating ? `★ ${c.rating.toFixed(1)}` : ""}{" "}
                      {c.sold_count ? `· ${c.sold_count} vendidos` : ""}
                    </div>
                  </div>
                  <Score value={c.score} />
                </div>
                <Price price={c.price} original={c.original_price} discount={c.discount_pct} />
                <div className="text-xs text-neutral-500">
                  Comissão: {money(c.commission_value)}
                </div>
                <Flags flags={c.flags} />
                <div className="mt-auto flex gap-2 pt-1">
                  {c.offer_status ? (
                    <span className="text-sm text-neutral-500">
                      Na curadoria ({c.offer_status === "approved" ? "aprovada" : c.offer_status})
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn flex-1"
                        onClick={() => save(c, "approved")}
                      >
                        Aprovar
                      </button>
                      <button
                        type="button"
                        className="btn-ghost flex-1"
                        onClick={() => save(c, "new")}
                      >
                        Revisar depois
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OfferList({
  status,
  run,
  onChange,
}: {
  status: "new" | "approved";
  run: Runner;
  onChange: () => void;
}) {
  const [items, setItems] = useState<Offer[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const page = await api<{ items: Offer[] }>(`/offers?status=${status}&limit=100`);
    setItems(page.items);
  }, [status]);
  useEffect(() => {
    load();
  }, [load]);

  async function setStatus(o: Offer, next: "approved" | "rejected") {
    const reason =
      next === "rejected" ? (prompt("Motivo da rejeição (opcional):") ?? undefined) : undefined;
    const res = await run(() =>
      api(`/offers/${o.id}/status`, { method: "POST", body: { status: next, reason } }),
    );
    if (res) {
      await load();
      onChange();
    }
  }

  async function validate(o: Offer) {
    const res = await run(() =>
      api<Mutation<ValidateOfferResult>>(`/offers/${o.id}/validate`, { method: "POST" }),
    );
    const r = res?.result;
    if (r) {
      setNotes({ ...notes, [o.id]: r.ok ? `✓ Válida (${money(r.price_now)})` : `✗ ${r.reason}` });
      if (!r.ok) await load();
    }
  }

  async function makeLink(o: Offer) {
    const source = prompt("Onde vai divulgar? (wa, ig, story, bio, ads)", "wa");
    if (!source) return;
    const res = await run(() =>
      api<Mutation<OfferLink>>(`/offers/${o.id}/links`, { method: "POST", body: { source } }),
    );
    if (res?.result) setLinks({ ...links, [o.id]: res.result.short_url });
  }

  if (items.length === 0) {
    return (
      <p className="card text-sm text-neutral-500">
        {status === "new"
          ? "Nada para revisar. Ofertas de buscas salvas e as marcadas como “Revisar depois” aparecem aqui."
          : "Nenhuma oferta aprovada ainda."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((o) => (
        <div key={o.id} className="card flex flex-col gap-3 p-3 md:flex-row md:items-center">
          {o.image_url && (
            // biome-ignore lint/performance/noImgElement: imagens externas das plataformas
            <img src={o.image_url} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-start gap-2">
              <Score value={o.score} />
              <span className="line-clamp-1 text-sm">{o.title}</span>
            </div>
            <Price price={o.price} original={o.original_price} discount={o.discount_pct} />
            <Flags flags={o.flags} />
            <div className="text-xs text-neutral-500">
              Comissão {money(o.commission_value)} · validada {fmtDate(o.last_validated_at)}
            </div>
            {notes[o.id] && <div className="text-sm">{notes[o.id]}</div>}
            {links[o.id] && (
              <div className="flex items-center gap-2 text-sm">
                <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
                  {links[o.id]}
                </code>
                <CopyButton value={links[o.id] ?? ""} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1 md:justify-end">
            {status === "new" ? (
              <>
                <button type="button" className="btn" onClick={() => setStatus(o, "approved")}>
                  Aprovar
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setStatus(o, "rejected")}
                >
                  Rejeitar
                </button>
              </>
            ) : (
              <>
                <a className="btn" href={`/publicacoes?offer=${o.id}`}>
                  Publicar
                </a>
                <button type="button" className="btn-ghost" onClick={() => makeLink(o)}>
                  Gerar link
                </button>
                <button type="button" className="btn-ghost" onClick={() => validate(o)}>
                  Validar
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setStatus(o, "rejected")}
                >
                  Remover
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SavedSearchesTab({ run }: { run: Runner }) {
  const [items, setItems] = useState<SavedSearch[]>([]);
  const load = useCallback(async () => setItems(await api<SavedSearch[]>("/saved-searches")), []);
  useEffect(() => {
    load();
  }, [load]);

  async function toggle(s: SavedSearch) {
    const res = await run(() =>
      api(`/saved-searches/${s.id}`, { method: "PATCH", body: { active: !s.active } }),
    );
    if (res) await load();
  }

  if (items.length === 0) {
    return (
      <p className="card text-sm text-neutral-500">
        Nenhuma busca salva. Faça uma busca e clique em “Salvar esta busca”: ela vai rodar sozinha e
        mandar as ofertas boas para a Curadoria.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((s) => {
        const r = s.last_result as { added?: number; found?: number; error?: string } | null;
        return (
          <div key={s.id} className="card flex flex-wrap items-center justify-between gap-3 p-3">
            <div>
              <div className="font-medium">{s.name}</div>
              <div className="text-xs text-neutral-500">
                {s.query.keyword ?? "(sem termo)"}
                {s.query.min_discount ? ` · ≥${s.query.min_discount}%` : ""} · a cada{" "}
                {s.interval_minutes} min · nota ≥ {s.min_score}
              </div>
              <div className="text-xs text-neutral-500">
                Última: {fmtDate(s.last_run_at)}
                {r?.error
                  ? ` · erro: ${r.error}`
                  : r
                    ? ` · ${r.found ?? 0} achadas, ${r.added ?? 0} novas`
                    : ""}
              </div>
            </div>
            <button type="button" className="btn-ghost" onClick={() => toggle(s)}>
              {s.active ? "Pausar" : "Ativar"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
