"use client";

import type { Offer, OfferCandidate, OfferCategory, SearchOffersResult } from "@ofertas/contracts";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Chip, Empty, InlineInput, Loading, LoadingButton, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { ProductCard } from "./parts";

type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;
type Mutation<T> = { status: string; result?: T };

const SORTS = [
  ["relevance", "Mais relevantes"],
  ["discount", "Maior desconto"],
  ["price_asc", "Menor preço"],
  ["price_desc", "Maior preço"],
  ["sales", "Mais populares"],
  ["commission", "Maior comissão"],
] as const;
const DISCOUNTS = [0, 10, 20, 30, 50, 70];
const RATINGS = [0, 4, 4.5, 4.8];
const PRICE_RANGES: { label: string; min?: number; max?: number }[] = [
  { label: "Até R$ 50", max: 50 },
  { label: "R$ 50 a 100", min: 50, max: 100 },
  { label: "R$ 100 a 300", min: 100, max: 300 },
  { label: "Acima de R$ 300", min: 300 },
];
const PAGE_SIZE = 24;

const STATUS_TAG: Record<
  NonNullable<OfferCandidate["offer_status"]>,
  { label: string; tone: "positive" | "info" | "negative" | "neutral" }
> = {
  approved: { label: "Aprovada", tone: "positive" },
  new: { label: "Na curadoria", tone: "info" },
  rejected: { label: "Rejeitada", tone: "negative" },
  expired: { label: "Expirada", tone: "neutral" },
};

type Filters = {
  keyword: string;
  category: string;
  priceMin: string;
  priceMax: string;
  minDiscount: number;
  minRating: number;
  sort: string;
};
const EMPTY: Filters = {
  keyword: "",
  category: "",
  priceMin: "",
  priceMax: "",
  minDiscount: 0,
  minRating: 0,
  sort: "relevance",
};

/** Filtros → corpo de /offers/search (sem página). */
function toQuery(f: Filters) {
  const num = (v: string) => (v.trim() && Number(v) >= 0 ? Number(v) : undefined);
  return {
    keyword: f.keyword.trim() || undefined,
    category_id: f.category || undefined,
    price_min: num(f.priceMin),
    price_max: num(f.priceMax),
    min_discount: f.minDiscount || undefined,
    min_rating: f.minRating || undefined,
    sort: f.sort,
    limit: PAGE_SIZE,
  };
}

/**
 * Busca no estilo de vitrine: palavra, categoria, faixa de preço, desconto, avaliação e
 * ordenação. Filtros aplicam na hora; "Ver mais" carrega a próxima página.
 */
export function SearchTab({ run, onSaved }: { run: Runner; onSaved: () => void }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [draftKeyword, setDraftKeyword] = useState("");
  const [categories, setCategories] = useState<OfferCategory[]>([]);
  const [items, setItems] = useState<OfferCandidate[] | null>(null);
  const [errors, setErrors] = useState<SearchOffersResult["errors"]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [saving, setSaving] = useState(false);
  const [interval, setIntervalMin] = useState(60);
  const [msg, setMsg] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    api<OfferCategory[]>("/offers/categories")
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  // `run` muda a cada renderização da página: guarda numa referência para não refazer a busca.
  const runRef = useRef(run);
  runRef.current = run;
  const fetchPage = useCallback(
    (f: Filters, p: number) =>
      runRef.current(() =>
        api<SearchOffersResult>("/offers/search", {
          method: "POST",
          body: { ...toQuery(f), page: p },
        }),
      ),
    [],
  );

  // Filtros mudaram: refaz a busca do começo (ignora respostas antigas que cheguem depois).
  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    setMsg(null);
    setSaving(false);
    const t = setTimeout(async () => {
      const res = await fetchPage(filters, 1);
      if (id !== seq.current) return;
      setLoading(false);
      setItems(res?.items ?? []);
      setErrors(res?.errors ?? []);
      setHasMore(Boolean(res?.has_more));
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [filters, fetchPage]);

  async function loadMore() {
    setMore(true);
    const res = await fetchPage(filters, page + 1);
    setMore(false);
    if (!res) return;
    setItems((cur) => {
      const seen = new Set((cur ?? []).map((i) => i.product_id));
      return [...(cur ?? []), ...res.items.filter((i) => !seen.has(i.product_id))];
    });
    setHasMore(res.has_more);
    setPage((p) => p + 1);
  }

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  async function save(c: OfferCandidate, status: "approved" | "new") {
    setBusy(`${status}:${c.product_id}`);
    const res = await run(() =>
      api<Mutation<Offer>>("/offers", {
        method: "POST",
        body: { product_id: c.product_id, status },
      }),
    );
    setBusy(null);
    if (res?.result) {
      const saved = res.result;
      setItems((cur) =>
        (cur ?? []).map((i) =>
          i.product_id === c.product_id
            ? { ...i, offer_id: saved.id, offer_status: saved.status }
            : i,
        ),
      );
      onSaved();
    }
  }

  async function saveSearch(name: string) {
    const res = await run(() =>
      api("/saved-searches", {
        method: "POST",
        body: { name, query: toQuery(filters), interval_minutes: interval },
      }),
    );
    if (res) {
      setSaving(false);
      setMsg("Busca salva. Ela roda sozinha e manda as ofertas boas para a Curadoria.");
    }
  }

  const priceRange = PRICE_RANGES.find(
    (r) => String(r.min ?? "") === filters.priceMin && String(r.max ?? "") === filters.priceMax,
  );
  const active: { label: string; clear: Partial<Filters> }[] = [
    ...(filters.keyword ? [{ label: `"${filters.keyword}"`, clear: { keyword: "" } }] : []),
    ...(filters.category
      ? [
          {
            label: categories.find((c) => c.id === filters.category)?.name ?? "Categoria",
            clear: { category: "" },
          },
        ]
      : []),
    ...(filters.priceMin || filters.priceMax
      ? [
          {
            label:
              priceRange?.label ??
              `R$ ${filters.priceMin || "0"} a ${filters.priceMax ? `R$ ${filters.priceMax}` : "∞"}`,
            clear: { priceMin: "", priceMax: "" },
          },
        ]
      : []),
    ...(filters.minDiscount
      ? [{ label: `${filters.minDiscount}%+ OFF`, clear: { minDiscount: 0 } }]
      : []),
    ...(filters.minRating ? [{ label: `★ ${filters.minRating}+`, clear: { minRating: 0 } }] : []),
  ];

  const filterPanel = (
    <div className="space-y-5">
      {categories.length > 0 && (
        <div className="space-y-1.5">
          <div className="label">Categoria</div>
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto pr-1">
            <button
              type="button"
              onClick={() => set({ category: "" })}
              className={`rounded-md px-2 py-1 text-left text-sm ${
                filters.category === ""
                  ? "bg-neutral-100 font-medium dark:bg-neutral-800"
                  : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
              }`}
            >
              Todas
            </button>
            {categories.map((c) => (
              <button
                key={`${c.platform}:${c.id}`}
                type="button"
                onClick={() => set({ category: c.id })}
                className={`flex justify-between gap-2 rounded-md px-2 py-1 text-left text-sm ${
                  filters.category === c.id
                    ? "bg-neutral-100 font-medium dark:bg-neutral-800"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
                }`}
              >
                <span className="truncate">{c.name}</span>
                {c.count !== null && (
                  <span className="text-xs text-neutral-400 tabular-nums">
                    {c.count.toLocaleString("pt-BR")}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <div className="label">Preço</div>
        <div className="flex flex-col gap-0.5">
          {PRICE_RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() =>
                set(
                  priceRange === r
                    ? { priceMin: "", priceMax: "" }
                    : { priceMin: String(r.min ?? ""), priceMax: String(r.max ?? "") },
                )
              }
              className={`rounded-md px-2 py-1 text-left text-sm ${
                priceRange === r
                  ? "bg-neutral-100 font-medium dark:bg-neutral-800"
                  : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <PriceInputs
          min={filters.priceMin}
          max={filters.priceMax}
          onApply={(priceMin, priceMax) => set({ priceMin, priceMax })}
        />
      </div>
      <div className="space-y-1.5">
        <div className="label">Desconto mínimo</div>
        <div className="flex flex-wrap gap-1.5">
          {DISCOUNTS.map((d) => (
            <Chip key={d} on={filters.minDiscount === d} onClick={() => set({ minDiscount: d })}>
              {d === 0 ? "Qualquer" : `${d}%+`}
            </Chip>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="label">Avaliação</div>
        <div className="flex flex-wrap gap-1.5">
          {RATINGS.map((r) => (
            <Chip key={r} on={filters.minRating === r} onClick={() => set({ minRating: r })}>
              {r === 0 ? "Qualquer" : `★ ${r}+`}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          set({ keyword: draftKeyword });
        }}
        className="flex flex-wrap gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            className="input pl-9"
            value={draftKeyword}
            onChange={(e) => setDraftKeyword(e.target.value)}
            placeholder="Buscar produtos: air fryer, fone bluetooth, panelas…"
            aria-label="Buscar produtos"
          />
        </div>
        <LoadingButton busy={loading && filters.keyword === draftKeyword} type="submit">
          Buscar
        </LoadingButton>
        <button
          type="button"
          className="btn-ghost inline-flex items-center gap-1.5 lg:hidden"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((s) => !s)}
        >
          <SlidersHorizontal className="h-4 w-4" /> Filtros
          {active.length > 0 && <span className="tabular-nums">({active.length})</span>}
        </button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
        <aside className={`${showFilters ? "block" : "hidden"} card h-fit lg:block`}>
          {filterPanel}
        </aside>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-neutral-500">
              {items && !loading && (
                <span>
                  {items.length}
                  {hasMore ? "+" : ""} produto(s)
                </span>
              )}
              {active.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => {
                    if ("keyword" in a.clear) setDraftKeyword("");
                    set(a.clear);
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {a.label} <X className="h-3 w-3" />
                </button>
              ))}
              {active.length > 1 && (
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => {
                    setDraftKeyword("");
                    setFilters({ ...EMPTY, sort: filters.sort });
                  }}
                >
                  Limpar filtros
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!saving && items && items.length > 0 && (
                <button
                  type="button"
                  className="btn-ghost text-sm"
                  onClick={() => {
                    setMsg(null);
                    setSaving(true);
                  }}
                >
                  Salvar esta busca
                </button>
              )}
              <select
                className="input h-9 w-auto py-1 text-sm"
                value={filters.sort}
                aria-label="Ordenar por"
                onChange={(e) => set({ sort: e.target.value })}
              >
                {SORTS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {saving && (
            <div className="card space-y-3">
              <div>
                <div className="text-sm font-medium">Salvar busca</div>
                <p className="text-xs text-neutral-500">
                  A busca roda sozinha com estes filtros e manda as ofertas com nota boa para a
                  Curadoria.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-neutral-500">Rodar a cada</span>
                {[30, 60, 180, 360].map((m) => (
                  <Chip key={m} on={interval === m} onClick={() => setIntervalMin(m)}>
                    {m < 60 ? `${m} min` : `${m / 60} h`}
                  </Chip>
                ))}
              </div>
              <InlineInput
                label="Nome"
                placeholder="ex.: Fones com 30%+"
                initial={filters.keyword}
                maxLength={80}
                onSubmit={saveSearch}
                onCancel={() => setSaving(false)}
              />
            </div>
          )}
          {msg && <p className="text-sm text-emerald-700">{msg}</p>}
          {errors.map((e) => (
            <p key={e.platform} className="text-sm text-amber-700">
              {e.platform}: {e.message}
            </p>
          ))}

          {loading || !items ? (
            <Loading label="Buscando produtos…" />
          ) : items.length === 0 ? (
            <Empty>
              Nenhum produto com esses filtros. Tente tirar algum filtro ou buscar outra palavra.
            </Empty>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]">
                {items.map((c) => (
                  <ProductCard
                    key={c.product_id}
                    p={c}
                    badge={
                      c.offer_status ? (
                        <Tag tone={STATUS_TAG[c.offer_status].tone} dot>
                          {STATUS_TAG[c.offer_status].label}
                        </Tag>
                      ) : null
                    }
                    footer={
                      c.offer_status === "approved" || c.offer_status === "new" ? (
                        <span className="text-xs text-neutral-500">
                          Já está em {c.offer_status === "approved" ? "Aprovadas" : "Curadoria"}
                        </span>
                      ) : (
                        <>
                          <LoadingButton
                            className="flex-1 px-2"
                            busy={busy === `approved:${c.product_id}`}
                            disabled={busy !== null}
                            onClick={() => save(c, "approved")}
                          >
                            Aprovar
                          </LoadingButton>
                          <LoadingButton
                            variant="btn-ghost"
                            className="flex-1 px-2"
                            busy={busy === `new:${c.product_id}`}
                            disabled={busy !== null}
                            onClick={() => save(c, "new")}
                          >
                            Depois
                          </LoadingButton>
                        </>
                      )
                    }
                  />
                ))}
              </div>
              {hasMore && (
                <div className="flex justify-center pt-2">
                  <LoadingButton variant="btn-ghost" busy={more} onClick={loadMore}>
                    Ver mais produtos
                  </LoadingButton>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Faixa de preço livre (aplica no Enter ou no botão). */
function PriceInputs({
  min,
  max,
  onApply,
}: {
  min: string;
  max: string;
  onApply: (min: string, max: string) => void;
}) {
  const [a, setA] = useState(min);
  const [b, setB] = useState(max);
  useEffect(() => {
    setA(min);
    setB(max);
  }, [min, max]);
  const apply = () => onApply(a.replace(/\D/g, ""), b.replace(/\D/g, ""));
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <input
        className="input h-8 w-full px-2 py-1 text-sm"
        inputMode="numeric"
        placeholder="Mín."
        aria-label="Preço mínimo"
        value={a}
        onChange={(e) => setA(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
      />
      <span className="text-neutral-400">–</span>
      <input
        className="input h-8 w-full px-2 py-1 text-sm"
        inputMode="numeric"
        placeholder="Máx."
        aria-label="Preço máximo"
        value={b}
        onChange={(e) => setB(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
      />
      <button type="button" className="btn-ghost h-8 px-2 text-sm" onClick={apply}>
        OK
      </button>
    </div>
  );
}
