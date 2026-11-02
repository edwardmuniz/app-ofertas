"use client";

import type { Offer, SavedSearch, ValidateOfferResult } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  Empty,
  ErrorText,
  Loading,
  LoadingButton,
  PageHeader,
  Segmented,
  Tag,
} from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";
import { ago, money } from "@/lib/format";
import { CopyEditor } from "./copy-editor";
import { FromLinkPanel } from "./from-link";
import { OfferLinkPanel } from "./link-panel";
import { ProductCard } from "./parts";
import { OfferPricePanel } from "./price-panel";
import { SearchTab } from "./search-tab";

type Tab = "buscar" | "curadoria" | "aprovadas" | "rejeitadas" | "buscas";
type Mutation<T> = { status: string; result?: T };

export default function OfertasPage() {
  const [tab, setTab] = useState<Tab>("buscar");
  const [error, setError] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [pasting, setPasting] = useState(false);
  const [listKey, setListKey] = useState(0);

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
    { key: "rejeitadas", label: "Rejeitadas" },
    { key: "buscas", label: "Buscas salvas" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ofertas"
        subtitle="Busque, aprove e acompanhe ofertas das lojas conectadas"
        actions={
          !pasting && (
            <button type="button" className="btn" onClick={() => setPasting(true)}>
              Colar link
            </button>
          )
        }
      />
      {pasting && (
        <FromLinkPanel
          onClose={() => setPasting(false)}
          onSaved={(o) => {
            setPasting(false);
            setTab(o.status === "approved" ? "aprovadas" : "curadoria");
            setListKey((k) => k + 1);
            refreshCount();
          }}
        />
      )}
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
      {tab === "curadoria" && (
        <OfferList key={`new-${listKey}`} status="new" run={run} onChange={refreshCount} />
      )}
      {tab === "aprovadas" && (
        <OfferList key={`ok-${listKey}`} status="approved" run={run} onChange={refreshCount} />
      )}
      {tab === "rejeitadas" && (
        <OfferList key={`rej-${listKey}`} status="rejected" run={run} onChange={refreshCount} />
      )}
      {tab === "buscas" && <SavedSearchesTab run={run} />}
    </div>
  );
}

type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;

/** Motivos rápidos de rejeição: ajudam a calibrar as buscas salvas e as regras. */
const REJECT_REASONS = [
  "Fora do nicho",
  "Preço não compensa",
  "Desconto falso",
  "Loja ou avaliação ruim",
  "Já divulgada",
];

function OfferList({
  status,
  run,
  onChange,
}: {
  status: "new" | "approved" | "rejected";
  run: Runner;
  onChange: () => void;
}) {
  const [items, setItems] = useState<Offer[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** Oferta com a escolha do motivo da rejeição aberta */
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Oferta com o painel "Gerar link" aberto */
  const [linkFor, setLinkFor] = useState<string | null>(null);
  /** Oferta com o ajuste de preços aberto */
  const [priceFor, setPriceFor] = useState<string | null>(null);
  /** Oferta com o editor de texto aberto */
  const [copyFor, setCopyFor] = useState<Offer | null>(null);
  /** Aprovadas: primeiro as que ainda não foram enviadas */
  const [sentFilter, setSentFilter] = useState<"no" | "yes" | "all">("no");

  function openCopy(o: Offer) {
    setCopyFor(o);
    setTimeout(
      () => document.getElementById("copy-editor")?.scrollIntoView({ behavior: "smooth" }),
      50,
    );
  }

  const load = useCallback(async () => {
    const sent = status === "approved" && sentFilter !== "all" ? `&sent=${sentFilter}` : "";
    const page = await api<{ items: Offer[] }>(`/offers?status=${status}&limit=100${sent}`);
    setItems(page.items);
  }, [status, sentFilter]);
  useEffect(() => {
    load();
  }, [load]);

  async function setStatus(o: Offer, next: "approved" | "rejected", reason?: string) {
    setBusy(`${next}:${o.id}`);
    const res = await run(() =>
      api(`/offers/${o.id}/status`, { method: "POST", body: { status: next, reason } }),
    );
    setBusy(null);
    if (res) {
      setRejecting(null);
      await load();
      onChange();
    }
  }

  async function validate(o: Offer) {
    setBusy(`validate:${o.id}`);
    const res = await run(() =>
      api<Mutation<ValidateOfferResult>>(`/offers/${o.id}/validate`, { method: "POST" }),
    );
    setBusy(null);
    const r = res?.result;
    if (r) {
      setNotes({ ...notes, [o.id]: r.ok ? `✓ Válida (${money(r.price_now)})` : `✗ ${r.reason}` });
      if (!r.ok) await load();
    }
  }

  const sentTabs =
    status === "approved" ? (
      <Segmented
        value={sentFilter}
        onChange={(v) => {
          setItems(null);
          setSentFilter(v);
        }}
        options={[
          { value: "no", label: "Não enviadas" },
          { value: "yes", label: "Já enviadas" },
          { value: "all", label: "Todas" },
        ]}
      />
    ) : null;

  if (!items) return <Loading />;
  if (items.length === 0) {
    if (status === "approved" && sentFilter !== "all") {
      return (
        <div className="space-y-4">
          {sentTabs}
          <Empty>
            {sentFilter === "no"
              ? "Todas as ofertas aprovadas já foram enviadas. Aprove novas em “Buscar” ou “Revisar”."
              : "Nenhuma oferta aprovada foi enviada ainda."}
          </Empty>
        </div>
      );
    }
    return (
      <Empty>
        {status === "new"
          ? "Nada para revisar. Ofertas de buscas salvas e as marcadas como “Revisar depois” aparecem aqui."
          : status === "rejected"
            ? "Nenhuma oferta rejeitada."
            : "Nenhuma oferta aprovada ainda. Busque em “Buscar” e aprove as boas."}
      </Empty>
    );
  }

  const textButton = (o: Offer) => (
    <button
      type="button"
      className="text-neutral-500 hover:underline"
      aria-expanded={copyFor?.id === o.id}
      onClick={() => (copyFor?.id === o.id ? setCopyFor(null) : openCopy(o))}
    >
      {o.copy ? "Editar texto" : "Escrever texto"}
    </button>
  );

  return (
    <div className="space-y-4">
      {sentTabs}
      {copyFor && (
        <CopyEditor
          key={copyFor.id}
          offer={copyFor}
          onClose={() => setCopyFor(null)}
          onSaved={(saved) =>
            setItems((list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? null)
          }
        />
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {items.map((o) => {
          return (
            <div key={o.id}>
              <ProductCard
                p={o}
                overlay={
                  rejecting === o.id ? (
                    <div className="flex h-full flex-col gap-1.5 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">Por que rejeitar?</span>
                        <button
                          type="button"
                          className="text-xs text-neutral-500 hover:underline"
                          onClick={() => setRejecting(null)}
                        >
                          Cancelar
                        </button>
                      </div>
                      {REJECT_REASONS.map((reason) => (
                        <button
                          key={reason}
                          type="button"
                          disabled={busy !== null}
                          onClick={() => setStatus(o, "rejected", reason)}
                          className="rounded-lg border border-neutral-200 px-3 py-1.5 text-left hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700"
                        >
                          {reason}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => setStatus(o, "rejected")}
                        className="px-3 py-1 text-left text-neutral-500 hover:underline disabled:opacity-50"
                      >
                        {busy === `rejected:${o.id}` ? "Rejeitando…" : "Sem motivo"}
                      </button>
                    </div>
                  ) : linkFor === o.id ? (
                    <OfferLinkPanel offerId={o.id} onClose={() => setLinkFor(null)} />
                  ) : priceFor === o.id ? (
                    <OfferPricePanel
                      offer={o}
                      onClose={() => setPriceFor(null)}
                      onSaved={(saved) => {
                        setPriceFor(null);
                        setItems(
                          (list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? null,
                        );
                      }}
                    />
                  ) : null
                }
                badge={
                  o.origin === "link" || o.copy || (status === "approved" && o.sent) ? (
                    <span className="flex flex-wrap gap-1">
                      {status === "approved" &&
                        o.sent &&
                        (o.sent.posts > 0 ? (
                          <Tag tone="neutral" dot>
                            {`Enviada em ${o.sent.channels} ${o.sent.channels === 1 ? "grupo" : "grupos"} · ${ago(o.sent.last_at)}`}
                          </Tag>
                        ) : (
                          <Tag tone="warning" dot>
                            Ainda não enviada
                          </Tag>
                        ))}
                      {o.origin === "link" && (
                        <Tag tone="info" dot>
                          Por link
                        </Tag>
                      )}
                      {o.copy && (
                        <Tag tone="positive" dot>
                          Texto próprio
                        </Tag>
                      )}
                    </span>
                  ) : null
                }
                footer={
                  status === "rejected" ? (
                    <LoadingButton
                      className="flex-1 px-2"
                      busy={busy === `approved:${o.id}`}
                      onClick={() => setStatus(o, "approved")}
                    >
                      Aprovar de novo
                    </LoadingButton>
                  ) : status === "new" ? (
                    <>
                      <LoadingButton
                        className="flex-1 px-2"
                        busy={busy === `approved:${o.id}`}
                        onClick={() => setStatus(o, "approved")}
                      >
                        Aprovar
                      </LoadingButton>
                      <button
                        type="button"
                        className="btn-ghost flex-1 px-2"
                        aria-expanded={rejecting === o.id}
                        onClick={() => setRejecting(rejecting === o.id ? null : o.id)}
                      >
                        Rejeitar
                      </button>
                      <div className="flex w-full justify-center text-xs">{textButton(o)}</div>
                    </>
                  ) : (
                    <>
                      <a
                        className="btn flex-1 px-2 text-center"
                        href={`/publicacoes?offer=${o.id}`}
                      >
                        Publicar
                      </a>
                      <button
                        type="button"
                        className="btn-ghost flex-1 px-2"
                        aria-expanded={linkFor === o.id}
                        onClick={() => setLinkFor(linkFor === o.id ? null : o.id)}
                      >
                        Gerar link
                      </button>
                      <div className="flex w-full justify-between text-xs">
                        {o.origin === "platform" ? (
                          <button
                            type="button"
                            className="text-neutral-500 hover:underline disabled:opacity-50"
                            disabled={busy === `validate:${o.id}`}
                            onClick={() => validate(o)}
                          >
                            {busy === `validate:${o.id}` ? "Conferindo…" : "Conferir preço"}
                          </button>
                        ) : (
                          <span />
                        )}
                        {textButton(o)}
                        <button
                          type="button"
                          className="text-neutral-500 hover:underline"
                          aria-expanded={priceFor === o.id}
                          onClick={() => setPriceFor(priceFor === o.id ? null : o.id)}
                        >
                          Preços
                        </button>
                        <button
                          type="button"
                          className="text-neutral-500 hover:text-red-600 hover:underline"
                          aria-expanded={rejecting === o.id}
                          onClick={() => setRejecting(rejecting === o.id ? null : o.id)}
                        >
                          Remover
                        </button>
                      </div>
                    </>
                  )
                }
              >
                <div className="text-xs text-neutral-500">
                  {status === "rejected"
                    ? `Rejeitada${o.reject_reason ? `: ${o.reject_reason}` : ""}`
                    : o.origin === "link"
                      ? `Criada por link · ${fmtDate(o.created_at)}`
                      : `Conferida ${fmtDate(o.last_validated_at)}`}
                </div>
                {notes[o.id] && <div className="text-xs">{notes[o.id]}</div>}
              </ProductCard>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SavedSearchesTab({ run }: { run: Runner }) {
  const [items, setItems] = useState<SavedSearch[] | null>(null);
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

  if (!items) return <Loading />;
  if (items.length === 0) {
    return (
      <Empty>
        Nenhuma busca salva. Faça uma busca e clique em “Salvar esta busca”: ela vai rodar sozinha e
        mandar as ofertas boas para a Curadoria.
      </Empty>
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
