"use client";

import type { Offer, SavedSearch, ValidateOfferResult } from "@ofertas/contracts";
import {
  BadgeDollarSign,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronRight,
  Clock,
  Link2,
  Loader2,
  MoreHorizontal,
  PenLine,
  RefreshCw,
  RotateCcw,
  Send,
  Ticket,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  Empty,
  ErrorText,
  Loading,
  LoadingButton,
  PageHeader,
  Segmented,
} from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";
import { ago, money } from "@/lib/format";
import { TabBar, useRouteTab } from "@/lib/tabs";
import { CopyEditor } from "./copy-editor";
import { OfferCouponPanel } from "./coupon-panel";
import { CouponsTab } from "./coupons-tab";
import { FromLinkPanel } from "./from-link";
import { OfferLinkPanel } from "./link-panel";
import { ProductCard } from "./parts";
import { OfferPricePanel } from "./price-panel";
import { SearchTab } from "./search-tab";

const TABS = ["buscar", "revisar", "aprovadas", "cupons", "rejeitadas", "buscas-salvas"] as const;
type Tab = (typeof TABS)[number];
type Mutation<T> = { status: string; result?: T };

export default function OfertasPage() {
  const [tab, setTab] = useRouteTab<Tab>("/ofertas", TABS, "buscar");
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
    { key: "revisar", label: `Para revisar${newCount ? ` (${newCount})` : ""}` },
    { key: "aprovadas", label: "Aprovadas" },
    { key: "cupons", label: "Cupons" },
    { key: "rejeitadas", label: "Rejeitadas" },
    { key: "buscas-salvas", label: "Buscas salvas" },
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
            setTab(o.status === "approved" ? "aprovadas" : "revisar");
            setListKey((k) => k + 1);
            refreshCount();
          }}
        />
      )}
      <TabBar base="/ofertas" tabs={tabs} active={tab} />
      <ErrorText error={error} />
      {tab === "buscar" && <SearchTab run={run} onSaved={refreshCount} />}
      {tab === "revisar" && (
        <OfferList key={`new-${listKey}`} status="new" run={run} onChange={refreshCount} />
      )}
      {tab === "aprovadas" && (
        <OfferList key={`ok-${listKey}`} status="approved" run={run} onChange={refreshCount} />
      )}
      {tab === "rejeitadas" && (
        <OfferList key={`rej-${listKey}`} status="rejected" run={run} onChange={refreshCount} />
      )}
      {tab === "cupons" && <CouponsTab />}
      {tab === "buscas-salvas" && <SavedSearchesTab run={run} />}
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

/** O que a janela da oferta está mostrando. */
type View = "menu" | "link" | "price" | "coupon" | "copy" | "reject";

const VIEW_TITLE: Record<View, string> = {
  menu: "O que você quer fazer?",
  link: "Pegar link para divulgar",
  price: "Corrigir preços",
  coupon: "Cupom de desconto",
  copy: "Texto da mensagem",
  reject: "Por que tirar esta oferta?",
};

/** Opção grande e escrita da janela "Mais opções". */
function MenuOption({
  icon: Icon,
  title,
  hint,
  onClick,
  busy = false,
  danger = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  onClick: () => void;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl border border-neutral-200 p-3 text-left transition-colors hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-800 dark:hover:bg-neutral-800/50 ${danger ? "text-red-600" : ""}`}
    >
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${danger ? "bg-red-50 dark:bg-red-500/10" : "bg-neutral-100 dark:bg-neutral-800"}`}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-neutral-500">{hint}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-neutral-400" />
    </button>
  );
}

/** Situação da oferta em uma frase, com cor: o que importa primeiro ao olhar o card. */
function OfferStatus({ o, status }: { o: Offer; status: Offer["status"] }) {
  if (status === "rejected") {
    return (
      <span className="text-neutral-500">
        Rejeitada{o.reject_reason ? `: ${o.reject_reason}` : ""}
      </span>
    );
  }
  if (status !== "approved" || !o.sent) return null;
  return o.sent.posts > 0 ? (
    <span className="inline-flex items-center gap-1.5 text-emerald-600">
      <CheckCircle2 className="h-4 w-4" />
      Enviada em {o.sent.channels} {o.sent.channels === 1 ? "grupo" : "grupos"} ·{" "}
      {ago(o.sent.last_at)}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-amber-600">
      <Clock className="h-4 w-4" /> Ainda não enviada
    </span>
  );
}

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
  const [busy, setBusy] = useState<string | null>(null);
  /** Oferta com a janela aberta e o que ela mostra. */
  const [open, setOpen] = useState<{ id: string; view: View } | null>(null);
  /** Resultado do "Conferir preço", mostrado na janela. */
  const [check, setCheck] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  /** Aprovadas: primeiro as que ainda não foram enviadas */
  const [sentFilter, setSentFilter] = useState<"no" | "yes" | "all">("no");
  /** Modo seleção: marca várias ofertas para agir de uma vez. */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rejectMany, setRejectMany] = useState(false);

  const load = useCallback(async () => {
    const sent = status === "approved" && sentFilter !== "all" ? `&sent=${sentFilter}` : "";
    const page = await api<{ items: Offer[] }>(`/offers?status=${status}&limit=100${sent}`);
    setItems(page.items);
  }, [status, sentFilter]);
  useEffect(() => {
    load();
  }, [load]);

  const close = useCallback(() => {
    setOpen(null);
    setCheck(null);
  }, []);
  const replace = (saved: Offer) =>
    setItems((list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? null);

  async function setStatus(o: Offer, next: "approved" | "rejected", reason?: string) {
    setBusy(`${next}:${o.id}`);
    const res = await run(() =>
      api(`/offers/${o.id}/status`, { method: "POST", body: { status: next, reason } }),
    );
    setBusy(null);
    if (res) {
      close();
      await load();
      onChange();
    }
  }

  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
    setRejectMany(false);
  };

  /** Muda a situação das ofertas marcadas. */
  async function setMany(next: "approved" | "rejected" | "new", reason?: string) {
    setBusy(`many:${next}`);
    const res = await run(() =>
      api("/offers/bulk-status", {
        method: "POST",
        body: { offer_ids: [...picked], status: next, reason },
      }),
    );
    setBusy(null);
    if (res) {
      stopSelecting();
      await load();
      onChange();
    }
  }

  async function validate(o: Offer) {
    setBusy(`validate:${o.id}`);
    setCheck(null);
    const res = await run(() =>
      api<Mutation<ValidateOfferResult>>(`/offers/${o.id}/validate`, { method: "POST" }),
    );
    setBusy(null);
    const r = res?.result;
    if (r) {
      setCheck({
        id: o.id,
        ok: r.ok,
        text: r.ok
          ? `O preço confere na loja: ${money(r.price_now)}.`
          : `${r.reason}. A oferta saiu das aprovadas.`,
      });
      if (!r.ok) await load();
    }
  }

  const sentTabs =
    status === "approved" ? (
      <Segmented
        value={sentFilter}
        onChange={(v) => {
          setItems(null);
          stopSelecting();
          setSentFilter(v);
        }}
        options={[
          { value: "no", label: "Não enviadas" },
          { value: "yes", label: "Já enviadas" },
          { value: "all", label: "Todas" },
        ]}
      />
    ) : null;
  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {sentTabs ?? <span />}
      {items && items.length > 0 && (
        <button
          type="button"
          className="btn-ghost h-10 gap-2"
          onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
        >
          {selecting ? (
            <>
              <X className="h-4 w-4" /> Cancelar seleção
            </>
          ) : (
            <>
              <CheckSquare className="h-4 w-4" /> Selecionar várias
            </>
          )}
        </button>
      )}
    </div>
  );

  if (!items) return <Loading />;
  if (items.length === 0) {
    if (status === "approved" && sentFilter !== "all") {
      return (
        <div className="space-y-4">
          {toolbar}
          <Empty>
            {sentFilter === "no"
              ? "Todas as ofertas aprovadas já foram enviadas. Aprove novas em “Buscar” ou “Para revisar”."
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

  const current = open ? items.find((x) => x.id === open.id) : undefined;
  const bigBtn = "h-11 w-full gap-2 text-base";

  const allPicked = picked.size === items.length;
  const pickedLabel = `${picked.size} ${picked.size === 1 ? "oferta marcada" : "ofertas marcadas"}`;

  return (
    <div className="space-y-4">
      {toolbar}
      {selecting && (
        <p className="text-sm text-neutral-500">
          Toque na foto das ofertas para marcar. Depois escolha o que fazer na barra de baixo.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
        {items.map((o) => (
          <ProductCard
            key={o.id}
            p={o}
            selected={picked.has(o.id)}
            onSelect={selecting ? () => toggle(o.id) : undefined}
            showScore={status === "new"}
            status={<OfferStatus o={o} status={o.status} />}
            meta={
              o.origin === "link" ? (
                <span title={fmtDate(o.created_at)}>Criada por link</span>
              ) : status === "rejected" ? null : (
                <span title={`Preço conferido em ${fmtDate(o.last_validated_at)}`}>
                  Preço conferido {ago(o.last_validated_at)}
                </span>
              )
            }
            coupon={
              o.coupon_code || o.coupon_description ? (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-sm font-medium ${o.coupon_active ? "border-emerald-500 text-emerald-700 dark:text-emerald-400" : "border-neutral-300 text-neutral-500 dark:border-neutral-700"}`}
                  title={o.coupon_active ? (o.coupon_description ?? undefined) : "Cupom vencido"}
                >
                  <Ticket className="h-4 w-4" />
                  <span className={o.coupon_active ? "" : "line-through"}>
                    {o.coupon_code ?? "Cupom na página"}
                  </span>
                  {!o.coupon_active && <span>(vencido)</span>}
                </span>
              ) : null
            }
            footer={
              selecting ? (
                <button
                  type="button"
                  className={`${picked.has(o.id) ? "btn" : "btn-ghost"} ${bigBtn}`}
                  onClick={() => toggle(o.id)}
                >
                  {picked.has(o.id) ? (
                    <>
                      <Check className="h-5 w-5" /> Marcada
                    </>
                  ) : (
                    "Marcar"
                  )}
                </button>
              ) : status === "rejected" ? (
                <LoadingButton
                  className={bigBtn}
                  busy={busy === `approved:${o.id}`}
                  onClick={() => setStatus(o, "approved")}
                >
                  Aprovar de novo
                </LoadingButton>
              ) : status === "new" ? (
                <>
                  <LoadingButton
                    className={bigBtn}
                    busy={busy === `approved:${o.id}`}
                    onClick={() => setStatus(o, "approved")}
                  >
                    <Check className="h-5 w-5" /> Aprovar
                  </LoadingButton>
                  <button
                    type="button"
                    className={`btn-ghost ${bigBtn}`}
                    onClick={() => setOpen({ id: o.id, view: "reject" })}
                  >
                    <X className="h-5 w-5" /> Rejeitar
                  </button>
                </>
              ) : (
                <>
                  <a className={`btn ${bigBtn}`} href={`/publicacoes/agendar?offer=${o.id}`}>
                    <Send className="h-5 w-5" /> Publicar nos grupos
                  </a>
                  <button
                    type="button"
                    className={`btn-ghost ${bigBtn}`}
                    onClick={() => setOpen({ id: o.id, view: "menu" })}
                  >
                    <MoreHorizontal className="h-5 w-5" /> Mais opções
                  </button>
                </>
              )
            }
          />
        ))}
      </div>

      {selecting && (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
          <span className="font-medium">{pickedLabel}</span>
          <button
            type="button"
            className="text-sm text-neutral-600 underline dark:text-neutral-400"
            onClick={() => setPicked(allPicked ? new Set() : new Set(items.map((x) => x.id)))}
          >
            {allPicked ? "Desmarcar todas" : `Marcar todas (${items.length})`}
          </button>
          <div className="ml-auto flex flex-wrap gap-2">
            {status !== "approved" && (
              <LoadingButton
                className="h-11 gap-2"
                disabled={!picked.size || busy !== null}
                busy={busy === "many:approved"}
                onClick={() => setMany("approved")}
              >
                <Check className="h-5 w-5" /> Aprovar
              </LoadingButton>
            )}
            {status !== "new" && (
              <LoadingButton
                variant="btn-ghost"
                className="h-11 gap-2"
                disabled={!picked.size || busy !== null}
                busy={busy === "many:new"}
                onClick={() => setMany("new")}
              >
                <RotateCcw className="h-5 w-5" /> Voltar para revisar
              </LoadingButton>
            )}
            {status !== "rejected" && (
              <button
                type="button"
                className="btn-ghost h-11 gap-2 text-red-600 dark:text-red-400"
                disabled={!picked.size || busy !== null}
                onClick={() => setRejectMany(true)}
              >
                <Trash2 className="h-5 w-5" />
                {status === "approved" ? "Tirar das aprovadas" : "Rejeitar"}
              </button>
            )}
          </div>
        </div>
      )}

      {rejectMany && (
        <Dialog
          title={status === "approved" ? "Tirar das aprovadas" : "Rejeitar"}
          subtitle={pickedLabel}
          onClose={() => setRejectMany(false)}
        >
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              O motivo ajuda as buscas automáticas a trazer ofertas melhores.
            </p>
            {REJECT_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                disabled={busy !== null}
                onClick={() => setMany("rejected", reason)}
                className="w-full rounded-xl border border-neutral-200 p-3 text-left font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
              >
                {reason}
              </button>
            ))}
            <LoadingButton
              variant="btn-ghost"
              className={bigBtn}
              busy={busy === "many:rejected"}
              disabled={busy !== null}
              onClick={() => setMany("rejected")}
            >
              Tirar sem dizer o motivo
            </LoadingButton>
          </div>
        </Dialog>
      )}

      {open && current && (
        <Dialog
          title={VIEW_TITLE[open.view]}
          subtitle={current.title}
          wide={open.view === "copy"}
          onClose={close}
          onBack={
            open.view !== "menu" && status === "approved"
              ? () => setOpen({ id: current.id, view: "menu" })
              : undefined
          }
        >
          {open.view === "menu" && (
            <div className="space-y-2">
              {check?.id === current.id && (
                <p
                  className={`rounded-lg p-3 text-sm font-medium ${check.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400" : "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400"}`}
                >
                  {check.text}
                </p>
              )}
              <MenuOption
                icon={Link2}
                title="Pegar link para divulgar"
                hint="Para Instagram, story, link da bio ou conversa"
                onClick={() => setOpen({ id: current.id, view: "link" })}
              />
              <MenuOption
                icon={PenLine}
                title={current.copy ? "Mudar o texto da mensagem" : "Escrever o texto da mensagem"}
                hint={
                  current.copy
                    ? "Já tem texto próprio. Toque para ver ou mudar."
                    : "A frase que vai junto da oferta no grupo"
                }
                onClick={() => setOpen({ id: current.id, view: "copy" })}
              />
              {current.origin === "platform" && (
                <MenuOption
                  icon={RefreshCw}
                  title="Conferir o preço agora"
                  hint="Olha na loja se o preço e o estoque continuam iguais"
                  busy={busy === `validate:${current.id}`}
                  onClick={() => validate(current)}
                />
              )}
              <MenuOption
                icon={Ticket}
                title={
                  current.coupon_code
                    ? `Cupom ${current.coupon_code}`
                    : current.coupon_source === "store"
                      ? "Cupom da loja"
                      : "Adicionar cupom"
                }
                hint={
                  current.coupon_source === "store" && !current.coupon_code
                    ? (current.coupon_description ?? "Lido da página da loja")
                    : !current.coupon_code
                      ? "Código de desconto que vai junto na mensagem"
                      : current.coupon_active
                        ? "Toque para mudar, mudar a validade ou tirar"
                        : "Venceu e não está saindo. Toque para atualizar."
                }
                onClick={() => setOpen({ id: current.id, view: "coupon" })}
              />
              <MenuOption
                icon={BadgeDollarSign}
                title="Corrigir preços"
                hint="Preço no Pix, preço De e parcelas, como aparecem na loja"
                onClick={() => setOpen({ id: current.id, view: "price" })}
              />
              <MenuOption
                icon={Trash2}
                title="Tirar das aprovadas"
                hint="A oferta não será mais divulgada"
                danger
                onClick={() => setOpen({ id: current.id, view: "reject" })}
              />
            </div>
          )}
          {open.view === "link" && <OfferLinkPanel offerId={current.id} />}
          {open.view === "price" && (
            <OfferPricePanel
              offer={current}
              onSaved={(saved) => {
                replace(saved);
                setOpen({ id: saved.id, view: "menu" });
              }}
            />
          )}
          {open.view === "coupon" && (
            <OfferCouponPanel
              offer={current}
              onSaved={(saved) => {
                replace(saved);
                setOpen({ id: saved.id, view: "menu" });
              }}
            />
          )}
          {open.view === "copy" && <CopyEditor offer={current} onSaved={replace} />}
          {open.view === "reject" && (
            <div className="space-y-2">
              <p className="text-sm text-neutral-500">
                O motivo ajuda as buscas automáticas a trazer ofertas melhores.
              </p>
              {REJECT_REASONS.map((reason) => (
                <button
                  key={reason}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setStatus(current, "rejected", reason)}
                  className="w-full rounded-xl border border-neutral-200 p-3 text-left font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
                >
                  {reason}
                </button>
              ))}
              <LoadingButton
                variant="btn-ghost"
                className={bigBtn}
                busy={busy === `rejected:${current.id}`}
                disabled={busy !== null}
                onClick={() => setStatus(current, "rejected")}
              >
                Tirar sem dizer o motivo
              </LoadingButton>
            </div>
          )}
        </Dialog>
      )}
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
        mandar as ofertas boas para “Para revisar”.
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
