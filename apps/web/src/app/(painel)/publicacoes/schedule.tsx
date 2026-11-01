"use client";

import type { Channel, Offer, Segment } from "@ofertas/contracts";
import { Check, Image as ImageIcon, Loader2, Search, Tag as TagIcon, Type } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Segmented } from "@/components/ui";
import { api, fmtDate } from "@/lib/api";
import { money, scoreClass } from "@/lib/format";
import { useCardsEnabled } from "@/lib/prefs";

type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;
type Mutation<T> = { status: string; result?: T; preview?: T };
type Plan = {
  posts: { channel_name: string; title: string | null; scheduled_at: string; body: string }[];
  skipped: { reason: string }[];
};

const MAX_OFFERS = 50;

const IMAGES = [
  {
    value: "card_preco",
    label: "Card de preço",
    hint: "Gerado na hora do envio, com o preço atualizado",
    icon: TagIcon,
  },
  {
    value: "cupom_destaque",
    label: "Cupom em destaque",
    hint: "Card com o cupom em evidência",
    icon: TagIcon,
  },
  { value: "photo", label: "Foto do produto", hint: "A foto da loja, sem card", icon: ImageIcon },
  { value: "none", label: "Só texto", hint: "Mensagem sem imagem", icon: Type },
] as const;

const SPACINGS = [5, 10, 15, 30, 60];

function Step({
  n,
  title,
  children,
  aside,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-medium">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-xs text-white dark:bg-white dark:text-neutral-900">
            {n}
          </span>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors ${
        on
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
          : "border-neutral-300 hover:border-neutral-400 dark:border-neutral-700"
      }`}
    >
      {on && <Check className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

const toggleIn = (list: string[], id: string) =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

export function Schedule({ run, onDone }: { run: Runner; onDone: () => void }) {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<"segments" | "groups">("segments");
  const [segIds, setSegIds] = useState<string[]>([]);
  const [chIds, setChIds] = useState<string[]>([]);
  const [image, setImage] = useState<string>("card_preco");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [spacing, setSpacing] = useState(10);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"plan" | "confirm" | null>(null);
  const cards = useCardsEnabled();
  const imageOptions = cards === false ? IMAGES.filter((o) => !o.value.includes("_")) : IMAGES;
  useEffect(() => {
    if (cards === false) setImage((v) => (v.includes("_") ? "photo" : v));
  }, [cards]);

  useEffect(() => {
    Promise.all([
      api<{ items: Offer[] }>("/offers?status=approved&limit=100"),
      api<Segment[]>("/segments"),
      api<Channel[]>("/channels"),
    ]).then(([o, s, c]) => {
      setOffers(o.items);
      setSegments(s);
      setChannels(
        c.filter((x) => x.status === "active" && x.messaging_account_id && x.external_id),
      );
      const pre = new URLSearchParams(window.location.search).get("offer");
      if (pre) setSelected([pre]);
    });
  }, []);

  // Qualquer mudança invalida o plano mostrado.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependências são os gatilhos
  useEffect(() => setPlan(null), [selected, target, segIds, chIds, image, when, at, spacing]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (offers ?? []).filter((o) => !q || o.title.toLowerCase().includes(q));
  }, [offers, query]);
  const allVisible = visible.length > 0 && visible.every((o) => selected.includes(o.id));

  // Grupos que vão receber (segmentos podem compartilhar grupos: conta cada grupo uma vez).
  const targetGroups = useMemo(() => {
    if (target === "groups") return channels.filter((c) => chIds.includes(c.id));
    return channels.filter((c) => c.segment_ids.some((s) => segIds.includes(s)));
  }, [target, channels, chIds, segIds]);

  const missing = !selected.length
    ? "Escolha ao menos uma oferta."
    : !targetGroups.length
      ? target === "segments" && segIds.length
        ? "Os segmentos escolhidos não têm grupos ativos."
        : "Escolha onde publicar."
      : when === "later" && !at
        ? "Escolha a data e a hora."
        : null;

  const body = () => ({
    offer_ids: selected,
    ...(target === "segments" ? { segment_ids: segIds } : { channel_ids: chIds }),
    ...(when === "later" && at ? { at: new Date(at).toISOString() } : {}),
    spacing_minutes: spacing,
    with_image: image !== "none",
    ...(image === "card_preco" || image === "cupom_destaque" ? { creative_template: image } : {}),
  });

  async function preview() {
    setBusy("plan");
    const res = await run(() =>
      api<Mutation<Plan>>("/posts?dry_run=true", { method: "POST", body: body() }),
    );
    setBusy(null);
    if (res?.preview) {
      setPlan(res.preview);
      setTimeout(
        () => document.getElementById("plano")?.scrollIntoView({ behavior: "smooth" }),
        50,
      );
    }
  }

  async function confirmSchedule() {
    setBusy("confirm");
    const res = await run(() => api<Mutation<unknown>>("/posts", { method: "POST", body: body() }));
    setBusy(null);
    if (res?.status === "done") onDone();
  }

  function toggleAllVisible() {
    if (allVisible) {
      const ids = new Set(visible.map((o) => o.id));
      setSelected((s) => s.filter((x) => !ids.has(x)));
    } else {
      setSelected((s) => [...new Set([...s, ...visible.map((o) => o.id)])].slice(0, MAX_OFFERS));
    }
  }

  const minDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  const total = selected.length * targetGroups.length;
  const byGroup = plan
    ? Object.entries(
        plan.posts.reduce<Record<string, Plan["posts"]>>((acc, p) => {
          acc[p.channel_name] = [...(acc[p.channel_name] ?? []), p];
          return acc;
        }, {}),
      )
    : [];

  if (!offers) {
    return (
      <p className="flex items-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </p>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      <Step
        n={1}
        title="O que publicar"
        aside={
          offers.length > 0 && (
            <span className="text-sm text-neutral-500 tabular-nums">
              {selected.length} selecionada(s)
            </span>
          )
        }
      >
        {offers.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nenhuma oferta aprovada. Aprove em{" "}
            <Link className="underline" href="/ofertas">
              Ofertas
            </Link>
            .
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative max-w-xs flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <input
                  className="input pl-8"
                  placeholder="Buscar oferta"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button type="button" className="btn-ghost" onClick={toggleAllVisible}>
                {allVisible ? "Desmarcar visíveis" : "Marcar visíveis"}
              </button>
              {selected.length > 0 && (
                <button
                  type="button"
                  className="text-sm text-neutral-500 hover:underline"
                  onClick={() => setSelected([])}
                >
                  Limpar
                </button>
              )}
            </div>
            <div className="grid max-h-[26rem] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {visible.map((o) => {
                const on = selected.includes(o.id);
                const full = !on && selected.length >= MAX_OFFERS;
                return (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={on}
                    disabled={full}
                    onClick={() => setSelected((s) => toggleIn(s, o.id))}
                    className={`flex items-center gap-3 rounded-lg border p-2 text-left transition-colors disabled:opacity-40 ${
                      on
                        ? "border-brand-500 bg-brand-50/60 dark:bg-brand-500/10"
                        : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                        on
                          ? "border-brand-500 bg-brand-500 text-white"
                          : "border-neutral-300 dark:border-neutral-600"
                      }`}
                    >
                      {on && <Check className="h-3.5 w-3.5" />}
                    </span>
                    {o.image_url ? (
                      // biome-ignore lint/performance/noImgElement: imagens externas das plataformas
                      <img
                        src={o.image_url}
                        alt=""
                        className="h-12 w-12 shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <span className="h-12 w-12 shrink-0 rounded-md bg-neutral-100 dark:bg-neutral-800" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-1 text-sm">{o.title}</span>
                      <span className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
                        <span className="font-semibold tabular-nums">{money(o.price)}</span>
                        {o.original_price && o.original_price > o.price && (
                          <span className="text-xs text-neutral-400 line-through tabular-nums">
                            {money(o.original_price)}
                          </span>
                        )}
                        {o.discount_pct ? (
                          <span className="text-xs text-emerald-600 tabular-nums">
                            -{o.discount_pct}%
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-neutral-500">
                        Comissão {money(o.commission_value)}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${scoreClass(o.score)}`}
                    >
                      {o.score}
                    </span>
                  </button>
                );
              })}
              {visible.length === 0 && (
                <p className="text-sm text-neutral-500">Nenhuma oferta com “{query}”.</p>
              )}
            </div>
            {selected.length >= MAX_OFFERS && (
              <p className="text-xs text-amber-600">Até {MAX_OFFERS} ofertas por vez.</p>
            )}
          </>
        )}
      </Step>

      <Step
        n={2}
        title="Onde"
        aside={
          <Segmented
            options={[
              { value: "segments", label: "Segmentos" },
              { value: "groups", label: "Grupos" },
            ]}
            value={target}
            onChange={setTarget}
          />
        }
      >
        {channels.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nenhum grupo ativo com WhatsApp. Importe ou crie grupos em{" "}
            <Link className="underline" href="/grupos">
              Grupos
            </Link>
            .
          </p>
        ) : target === "segments" ? (
          segments.length === 0 ? (
            <p className="text-sm text-neutral-500">
              Nenhum segmento. Crie em{" "}
              <Link className="underline" href="/grupos">
                Grupos
              </Link>{" "}
              ou escolha “Grupos”.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {segments.map((s) => {
                const n = channels.filter((c) => c.segment_ids.includes(s.id)).length;
                return (
                  <Chip
                    key={s.id}
                    on={segIds.includes(s.id)}
                    onClick={() => setSegIds((x) => toggleIn(x, s.id))}
                  >
                    {s.name}
                    <span className="opacity-60 tabular-nums">
                      · {n} grupo{n === 1 ? "" : "s"}
                    </span>
                  </Chip>
                );
              })}
            </div>
          )
        ) : (
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => (
              <Chip
                key={c.id}
                on={chIds.includes(c.id)}
                onClick={() => setChIds((x) => toggleIn(x, c.id))}
              >
                {c.name}
                <span className="opacity-60 tabular-nums">· {c.member_count}</span>
              </Chip>
            ))}
          </div>
        )}
        {targetGroups.length > 0 && target === "segments" && (
          <p className="text-xs text-neutral-500">
            Vai para: {targetGroups.map((c) => c.name).join(", ")}
          </p>
        )}
      </Step>

      <Step n={3} title="Imagem">
        {cards === false && (
          <p className="text-xs text-neutral-500">
            Cards desligados nas{" "}
            <Link className="underline" href="/preferencias">
              Preferências
            </Link>
            : os envios vão com a foto do produto.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {imageOptions.map((opt) => {
            const on = image === opt.value;
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={on}
                onClick={() => setImage(opt.value)}
                className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
                  on
                    ? "border-brand-500 bg-brand-50/60 dark:bg-brand-500/10"
                    : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
                }`}
              >
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${on ? "text-brand-600" : "text-neutral-400"}`}
                />
                <span>
                  <span className="block text-sm font-medium">{opt.label}</span>
                  <span className="block text-xs text-neutral-500">{opt.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Step>

      <Step n={4} title="Quando">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            options={[
              { value: "now", label: "Começar agora" },
              { value: "later", label: "Agendar" },
            ]}
            value={when}
            onChange={setWhen}
          />
          {when === "later" && (
            <input
              className="input w-auto"
              type="datetime-local"
              min={minDate}
              value={at}
              onChange={(e) => setAt(e.target.value)}
              aria-label="Data e hora de início"
            />
          )}
        </div>
        <div className="space-y-1.5">
          <div className="text-sm">Intervalo entre ofertas no mesmo grupo</div>
          <div className="flex flex-wrap gap-2">
            {SPACINGS.map((m) => (
              <Chip key={m} on={spacing === m} onClick={() => setSpacing(m)}>
                {m < 60 ? `${m} min` : "1 h"}
              </Chip>
            ))}
          </div>
          <p className="text-xs text-neutral-500">
            Os envios respeitam as janelas de horário e os limites anti-banimento das Preferências.
          </p>
        </div>
      </Step>

      {plan && (
        <section id="plano" className="card space-y-4">
          <div>
            <h2 className="font-medium">Plano de envio</h2>
            <p className="text-sm text-neutral-500">
              {plan.posts.length} publicação(ões)
              {plan.posts[0] && ` · primeira ${fmtDate(plan.posts[0].scheduled_at)}`}
              {plan.posts.length > 1 &&
                ` · última ${fmtDate(plan.posts[plan.posts.length - 1]?.scheduled_at ?? "")}`}
            </p>
          </div>
          {plan.skipped.length > 0 && (
            <div className="rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-500/10">
              <div className="font-medium">{plan.skipped.length} não vão sair</div>
              <ul className="mt-1 list-disc pl-5 text-neutral-700 dark:text-neutral-300">
                {[...new Set(plan.skipped.map((s) => s.reason))].map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,22rem)]">
            <div className="space-y-3">
              {byGroup.map(([group, posts]) => (
                <div key={group}>
                  <div className="text-sm font-medium">{group}</div>
                  <ol className="mt-1 space-y-0.5 border-l border-neutral-200 pl-3 text-sm dark:border-neutral-800">
                    {posts.map((p) => (
                      <li key={`${group}-${p.scheduled_at}`} className="flex gap-2">
                        <span className="w-28 shrink-0 text-neutral-500 tabular-nums">
                          {fmtDate(p.scheduled_at)}
                        </span>
                        <span className="line-clamp-1">{p.title}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
            {plan.posts[0] && (
              <div>
                <div className="mb-1 text-xs text-neutral-500">
                  Como a primeira mensagem vai ficar
                </div>
                <pre className="max-h-80 overflow-auto rounded-lg bg-[#e7ffdb] p-3 text-xs whitespace-pre-wrap text-neutral-900 dark:bg-emerald-950 dark:text-emerald-50">
                  {plan.posts[0].body}
                </pre>
              </div>
            )}
          </div>
        </section>
      )}

      <div className="sticky bottom-4 z-10">
        <div className="card flex flex-wrap items-center justify-between gap-3 shadow-lg">
          <div className="text-sm">
            {missing ? (
              <span className="text-neutral-500">{missing}</span>
            ) : (
              <>
                <span className="font-medium tabular-nums">
                  {selected.length} oferta(s) × {targetGroups.length} grupo(s) = até {total}{" "}
                  envio(s)
                </span>
                <span className="text-neutral-500">
                  {" "}
                  · 1 a cada {spacing < 60 ? `${spacing} min` : "1 h"} por grupo ·{" "}
                  {when === "now"
                    ? "começa agora"
                    : `começa ${at ? fmtDate(new Date(at).toISOString()) : ""}`}
                </span>
              </>
            )}
          </div>
          {plan ? (
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => setPlan(null)}>
                Ajustar
              </button>
              <button
                type="button"
                className="btn-accent inline-flex items-center gap-1.5"
                disabled={!plan.posts.length || busy !== null}
                onClick={confirmSchedule}
              >
                {busy === "confirm" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Agendar {plan.posts.length} publicação(ões)
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn inline-flex items-center gap-1.5"
              disabled={Boolean(missing) || busy !== null}
              onClick={preview}
            >
              {busy === "plan" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Ver plano
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
