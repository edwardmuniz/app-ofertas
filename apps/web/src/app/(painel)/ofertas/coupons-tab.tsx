"use client";

import type { StoreCoupon } from "@ofertas/contracts";
import { Clock, Pencil, Plus, Send, Ticket, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ImageField } from "@/components/image-field";
import {
  ChoiceCards,
  ConfirmButton,
  Dialog,
  Empty,
  ErrorText,
  Loading,
  LoadingButton,
  PlatformBadge,
  Segmented,
  Tag,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";

type Platform = StoreCoupon["platform"];

const STORES: { value: Platform; label: string }[] = [
  { value: "shopee", label: "Shopee" },
  { value: "amazon", label: "Amazon" },
  { value: "mercadolivre", label: "Mercado Livre" },
  { value: "magalu", label: "Magalu" },
];

const TZ = "America/Sao_Paulo";
const untilText = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
/** Data e hora (AAAA-MM-DDTHH:MM) no horário de Brasília, para o campo do formulário. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString("sv-SE", { timeZone: TZ });
  const time = d.toLocaleTimeString("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return `${day}T${time}`;
};

/**
 * Cupons da loja inteira (ex.: "R$ 20 OFF acima de R$ 99 na Shopee"): cadastra e divulga nos
 * grupos como um post próprio, sem produto.
 */
export function CouponsTab() {
  const [items, setItems] = useState<StoreCoupon[] | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [editing, setEditing] = useState<StoreCoupon | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(await api<StoreCoupon[]>(`/coupons?status=${filter}`));
  }, [filter]);
  useEffect(() => {
    load();
  }, [load]);

  async function remove(c: StoreCoupon) {
    setError(null);
    try {
      await api(`/coupons/${c.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao apagar.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={filter}
          onChange={(v) => {
            setItems(null);
            setFilter(v);
          }}
          options={[
            { value: "active", label: "Valendo agora" },
            { value: "all", label: "Todos" },
          ]}
        />
        <button
          type="button"
          className="btn h-11 gap-2 text-base"
          onClick={() => setEditing("new")}
        >
          <Plus className="h-5 w-5" /> Novo cupom
        </button>
      </div>
      <p className="text-sm text-neutral-500">
        Cupons que valem para a loja toda, como “R$ 20 OFF acima de R$ 99”. Cada um vira uma
        mensagem própria nos grupos, com o link da sua afiliação.
      </p>
      <ErrorText error={error} />

      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>
          {filter === "active"
            ? "Nenhum cupom valendo agora. Toque em “Novo cupom” para cadastrar um."
            : "Nenhum cupom cadastrado."}
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]">
          {items.map((c) => (
            <div key={c.id} className="card flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <PlatformBadge platform={c.platform} />
                {!c.active && <Tag tone="neutral">Vencido</Tag>}
              </div>
              <div className="text-lg leading-6 font-semibold">{c.title}</div>
              {c.code ? (
                <div className="inline-flex w-fit items-center gap-2 rounded-lg border-2 border-dashed border-emerald-500 px-3 py-1.5 font-mono text-lg font-semibold text-emerald-700 dark:text-emerald-400">
                  <Ticket className="h-5 w-5" /> {c.code}
                </div>
              ) : (
                <div className="text-sm text-neutral-500">Sem código: o resgate é pelo link.</div>
              )}
              {c.details && (
                <p className="text-sm text-neutral-600 dark:text-neutral-400">{c.details}</p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-4 w-4" />
                  {c.valid_until ? `Vale até ${untilText(c.valid_until)}` : "Sem prazo"}
                </span>
                <span>
                  {c.posts_sent
                    ? `Enviado ${c.posts_sent} ${c.posts_sent === 1 ? "vez" : "vezes"}`
                    : "Ainda não enviado"}
                </span>
              </div>
              {!c.affiliate_url && (
                <p className="text-xs text-amber-600">
                  Sem link de afiliado: o envio usa o endereço colado. Confira se ele já tem a sua
                  afiliação.
                </p>
              )}
              <div className="mt-auto flex flex-col gap-2 pt-1">
                {c.active && (
                  <a
                    className="btn h-11 w-full gap-2 text-base"
                    href={`/publicacoes/agendar?coupon=${c.id}`}
                  >
                    <Send className="h-5 w-5" /> Publicar nos grupos
                  </a>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="btn-ghost h-11 gap-2 text-base"
                    onClick={() => setEditing(c)}
                  >
                    <Pencil className="h-4 w-4" /> Editar
                  </button>
                  <ConfirmButton
                    className="h-11 w-full gap-2 text-base"
                    message="Apagar este cupom? Os envios agendados dele são cancelados."
                    confirmLabel="Apagar"
                    onConfirm={() => remove(c)}
                  >
                    <Trash2 className="h-4 w-4" /> Apagar
                  </ConfirmButton>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Dialog
          title={editing === "new" ? "Novo cupom da loja" : "Editar cupom"}
          onClose={() => setEditing(null)}
        >
          <CouponForm
            coupon={editing === "new" ? null : editing}
            onSaved={async () => {
              setEditing(null);
              await load();
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

function CouponForm({
  coupon,
  onSaved,
}: {
  coupon: StoreCoupon | null;
  onSaved: () => Promise<void>;
}) {
  const [platform, setPlatform] = useState<Platform>(coupon?.platform ?? "shopee");
  const [title, setTitle] = useState(coupon?.title ?? "");
  const [code, setCode] = useState(coupon?.code ?? "");
  const [details, setDetails] = useState(coupon?.details ?? "");
  const [url, setUrl] = useState(coupon?.url ?? "");
  const [image, setImage] = useState(coupon?.image_url ?? "");
  const [until, setUntil] = useState(toLocalInput(coupon?.valid_until ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3) return setError("Escreva a chamada do cupom.");
    if (!/^https?:\/\//.test(url.trim())) return setError("Cole o link da página do cupom.");
    setBusy(true);
    setError(null);
    try {
      await api(coupon ? `/coupons/${coupon.id}` : "/coupons", {
        method: coupon ? "PUT" : "POST",
        body: {
          platform,
          title: title.trim(),
          code: code.trim() || null,
          details: details.trim() || null,
          url: url.trim(),
          image_url: image.trim() || null,
          valid_until: until ? `${until}:00-03:00` : null,
        },
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao salvar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <div className="text-sm font-medium">Loja</div>
        <ChoiceCards columns={4} value={platform} onChange={setPlatform} options={STORES} />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="sc_title">
          Chamada do cupom
        </label>
        <input
          className="input"
          id="sc_title"
          value={title}
          maxLength={120}
          placeholder="ex.: R$ 20 OFF acima de R$ 99"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="sc_code">
          Código (opcional)
        </label>
        <input
          className="input font-mono text-base uppercase"
          id="sc_code"
          value={code}
          maxLength={60}
          placeholder="ex.: SHOPEE20"
          onChange={(e) => setCode(e.target.value)}
        />
        <p className="text-xs text-neutral-500">
          Deixe em branco se o cupom é resgatado pelo link, sem código.
        </p>
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="sc_url">
          Link da página do cupom
        </label>
        <input
          className="input"
          id="sc_url"
          type="url"
          value={url}
          placeholder="https://shopee.com.br/m/cupons"
          onChange={(e) => setUrl(e.target.value)}
        />
        <p className="text-xs text-neutral-500">
          Quando a conta da loja está conectada, o link vira link de afiliado sozinho.
        </p>
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="sc_details">
          Regras (opcional)
        </label>
        <input
          className="input"
          id="sc_details"
          value={details}
          maxLength={300}
          placeholder="ex.: só no app, limitado aos primeiros 1.000"
          onChange={(e) => setDetails(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="sc_until">
          Vale até (opcional)
        </label>
        <input
          className="input"
          id="sc_until"
          type="datetime-local"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
        />
        <p className="text-xs text-neutral-500">
          Horário de Brasília. Depois disso, os envios agendados deste cupom não saem.
        </p>
      </div>
      <ImageField
        label="Imagem (opcional)"
        value={image}
        onChange={setImage}
        hint="Vai junto da mensagem. Sem imagem, a mensagem sai só com texto."
        shape="wide"
      />
      <ErrorText error={error} />
      <LoadingButton busy={busy} type="submit" className="h-11 w-full text-base">
        Salvar cupom
      </LoadingButton>
    </form>
  );
}
