"use client";

import { AUDIENCE_SOURCES, type Content, type ContentKit } from "@ofertas/contracts";
import { Check, Download, Film, Images, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Chip,
  CopyButton,
  Empty,
  ErrorText,
  Field,
  Loading,
  LoadingButton,
  PageHeader,
  Panel,
  Segmented,
  Tag,
  type Tone,
} from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";
import { money } from "@/lib/format";

const STATUS: Record<Content["status"], { label: string; tone: Tone }> = {
  queued: { label: "Na fila", tone: "info" },
  rendering: { label: "Montando…", tone: "info" },
  pending_review: { label: "Aguardando aprovação", tone: "warning" },
  ready: { label: "Pronto", tone: "positive" },
  rejected: { label: "Recusado", tone: "negative" },
  failed: { label: "Falhou", tone: "negative" },
};

const fullCaption = (c: Content) =>
  c.hashtags.length ? `${c.caption}\n\n${c.hashtags.map((t) => `#${t}`).join(" ")}` : c.caption;

const download = (url: string, name: string) =>
  `${url}&dl=${encodeURIComponent(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40),
  )}`;

type Tab = "review" | "to_post" | "posted" | "rejected" | "all";
const IN_TAB: Record<Tab, (c: Content) => boolean> = {
  review: (c) => c.status === "pending_review",
  to_post: (c) => c.status === "ready" && c.posted_to.length === 0,
  posted: (c) => c.posted_to.length > 0,
  rejected: (c) => c.status === "rejected" || c.status === "failed",
  all: () => true,
};

export default function ConteudoPage() {
  const [items, setItems] = useState<Content[] | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api<Content[]>("/contents?limit=100"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao carregar.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Abre na primeira aba com algo a fazer: aprovar, depois postar.
  const current: Tab =
    tab ??
    (items?.some(IN_TAB.review) ? "review" : items?.some(IN_TAB.to_post) ? "to_post" : "all");
  const count = (t: Tab) => items?.filter(IN_TAB[t]).length ?? 0;
  const shown = items?.filter(IN_TAB[current]) ?? [];

  // Enquanto algo está montando, atualiza a cada 4 s.
  const pending = items?.some((c) => c.status === "queued" || c.status === "rendering");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [pending, load]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Conteúdo"
        subtitle="Vídeos para TikTok, Reels e Shorts (feitos pelo seu agente de IA, com a sua aprovação) e carrosséis do Instagram. Baixe, poste e marque onde postou."
        actions={
          !creating ? (
            <button
              type="button"
              className="btn-accent inline-flex items-center gap-1.5"
              onClick={() => setCreating(true)}
            >
              <Plus className="h-4 w-4" /> Montar carrossel
            </button>
          ) : null
        }
      />
      <ErrorText error={error} />
      {creating && (
        <CreatePanel
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>
          Nenhum conteúdo ainda. Peça um vídeo ao seu agente de IA (ele usa{" "}
          <code>get_content_kit</code> e envia com <code>submit_video</code>; você aprova aqui),
          clique em “Montar carrossel” ou ligue o carrossel diário em{" "}
          <Link href="/preferencias">Preferências</Link>.
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto">
            <Segmented
              value={current}
              onChange={setTab}
              options={[
                { value: "review", label: `Aprovar (${count("review")})` },
                { value: "to_post", label: `Para postar (${count("to_post")})` },
                { value: "posted", label: "Postados" },
                { value: "rejected", label: "Recusados" },
                { value: "all", label: "Todos" },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <Empty>
              {current === "review"
                ? "Nenhum vídeo aguardando aprovação."
                : current === "to_post"
                  ? "Nada pronto para postar. Aprove vídeos ou monte um carrossel."
                  : "Nada por aqui ainda."}
            </Empty>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((c) => (
                <ContentCard key={c.id} c={c} onChange={load} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CreatePanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kit, setKit] = useState<ContentKit | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [hook, setHook] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ContentKit>("/content/kit?limit=20").then((k) => {
      setKit(k);
      const fresh = k.offers.filter((o) => !o.recently_used).slice(0, 5);
      const first = (fresh.length >= 3 ? fresh : k.offers.slice(0, 5)).map((o) => o.offer_id);
      setPicked(first);
      setHook(`${first.length} achadinhos de hoje com desconto`);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/contents", {
        method: "POST",
        body: {
          kind: "carousel",
          offer_ids: picked,
          hook: hook.trim(),
          ...(caption.trim() && { caption: caption.trim() }),
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao criar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Montar carrossel"
      subtitle="Carrossel do Instagram (4:5), uma imagem por oferta. Escolha de 3 a 5 ofertas e uma frase de abertura forte. Fica pronto em segundos e não gasta créditos de IA. Vídeos são feitos pelo seu agente."
      actions={
        <button
          type="button"
          className="text-xs text-neutral-500 hover:underline"
          onClick={onClose}
        >
          Fechar
        </button>
      }
    >
      {!kit ? (
        <Loading />
      ) : kit.offers.length === 0 ? (
        <Empty>
          Nenhuma oferta aprovada nos últimos 7 dias. Aprove algumas em{" "}
          <Link href="/ofertas">Ofertas</Link>.
        </Empty>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {!kit.storefront_url && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
              Crie a <Link href="/vitrine">vitrine</Link> antes: o carrossel termina com o endereço
              dela (o link da bio).
            </p>
          )}
          <div className="space-y-1.5">
            <div className="label">
              Ofertas ({picked.length} de até 8, na ordem em que aparecem)
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {kit.offers.map((o) => {
                const on = picked.includes(o.offer_id);
                return (
                  <button
                    key={o.offer_id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setPicked((p) =>
                        on
                          ? p.filter((x) => x !== o.offer_id)
                          : p.length < 8
                            ? [...p, o.offer_id]
                            : p,
                      )
                    }
                    className={`flex items-center gap-3 rounded-lg border p-2 text-left text-sm transition-colors ${
                      on
                        ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-900"
                        : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800"
                    }`}
                  >
                    {o.image_urls[0] ? (
                      // biome-ignore lint/performance/noImgElement: imagem externa da loja
                      <img
                        src={o.image_urls[0]}
                        alt=""
                        className="h-12 w-12 shrink-0 rounded object-contain"
                      />
                    ) : (
                      <span className="h-12 w-12 shrink-0 rounded bg-neutral-100" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-1">{o.title}</span>
                      <span className="text-xs text-neutral-500">
                        {money(o.price)}
                        {o.discount_pct ? ` · -${o.discount_pct}%` : ""} · {o.platform}
                        {o.recently_used ? " · já usada" : ""}
                      </span>
                    </span>
                    {on && (
                      <span className="shrink-0 text-xs font-semibold">
                        {picked.indexOf(o.offer_id) + 1}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <Field label="Frase de abertura (aparece nos primeiros segundos)" htmlFor="ct_hook">
            <input
              className="input"
              id="ct_hook"
              required
              maxLength={70}
              value={hook}
              placeholder="5 achadinhos de cozinha até R$ 100"
              onChange={(e) => setHook(e.target.value)}
            />
          </Field>
          <Field
            label="Legenda (opcional: sem ela, o sistema monta uma com a lista)"
            htmlFor="ct_caption"
          >
            <textarea
              className="input"
              id="ct_caption"
              rows={3}
              maxLength={2200}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </Field>
          <ErrorText error={error} />
          <LoadingButton
            busy={busy}
            type="submit"
            disabled={picked.length === 0 || hook.trim().length < 3}
          >
            Montar
          </LoadingButton>
        </form>
      )}
    </Panel>
  );
}

function ContentCard({ c, onChange }: { c: Content; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const st = STATUS[c.status];
  const file = c.files[0];
  const reviewable = c.status === "pending_review" || c.status === "ready";

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setRejecting(false);
      setNote("");
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao salvar.");
    } finally {
      setBusy(null);
    }
  }

  const review = (decision: "approve" | "reject") =>
    run(decision, () =>
      api(`/contents/${c.id}/review`, {
        method: "POST",
        body: { decision, ...(note.trim() && { note: note.trim() }) },
      }),
    );

  // Clicar numa rede já marcada desmarca (marcou errado).
  const togglePosted = (platform: string) =>
    run(platform, () =>
      api(`/contents/${c.id}/posted`, {
        method: "POST",
        body: { platforms: [platform], undo: c.posted_to.includes(platform) },
      }),
    );

  const remove = () => {
    if (!window.confirm("Excluir este conteúdo e os arquivos? Não dá para desfazer.")) return;
    run("delete", () => api(`/contents/${c.id}`, { method: "DELETE" }));
  };

  return (
    <div className="card flex flex-col gap-3 !p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          {c.kind === "video" ? (
            <Film className="h-4 w-4 shrink-0" />
          ) : (
            <Images className="h-4 w-4 shrink-0" />
          )}
          <span className="line-clamp-1">{c.title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Tag tone={st.tone} dot>
            {st.label}
          </Tag>
          {c.status !== "rendering" && (
            <button
              type="button"
              className="rounded p-1 text-neutral-400 hover:text-red-600"
              aria-label="Excluir conteúdo"
              title="Excluir"
              disabled={busy !== null}
              onClick={remove}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-900">
        {c.kind === "video" && file ? (
          // biome-ignore lint/a11y/useMediaCaption: vídeo sem fala (só texto na tela)
          <video
            src={file.url}
            poster={c.cover_url ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="aspect-[9/16] w-full"
          />
        ) : c.kind === "carousel" && c.files.length ? (
          <div className="flex snap-x gap-1 overflow-x-auto">
            {c.files.map((f, i) => (
              <a
                key={f.url}
                href={download(f.url, `${c.title}-${i + 1}`)}
                className="shrink-0 snap-start"
              >
                {/* biome-ignore lint/performance/noImgElement: arquivo gerado */}
                <img src={f.url} alt="" className="aspect-[4/5] w-48 object-cover" />
              </a>
            ))}
          </div>
        ) : (
          <div className="flex aspect-[9/16] max-h-80 w-full items-center justify-center p-4 text-center text-sm text-neutral-500">
            {c.status === "failed" ? (c.error ?? "Falhou.") : "Montando… fica pronto em segundos."}
          </div>
        )}
      </div>

      {c.warnings.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
          <div className="font-medium">
            Confira antes de {c.status === "ready" ? "postar" : "aprovar"}:
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {c.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {c.status === "pending_review" && !rejecting && (
        <p className="text-xs text-neutral-500">
          Enviado por {c.created_by}
          {c.seconds ? ` · ${Math.round(c.seconds)} s` : ""}. Assista e confira preços e textos.
        </p>
      )}

      {c.status === "rejected" && c.review_note && (
        <p className="rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          Motivo da recusa: {c.review_note}
        </p>
      )}

      {rejecting ? (
        <div className="space-y-2">
          <textarea
            className="input"
            rows={2}
            maxLength={500}
            placeholder="O que mudar? (o agente lê e faz outro)"
            aria-label="Motivo da recusa"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <LoadingButton busy={busy === "reject"} onClick={() => review("reject")}>
              {c.status === "ready" ? "Reprovar" : "Recusar"}
            </LoadingButton>
            <button type="button" className="btn-ghost" onClick={() => setRejecting(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : c.status === "pending_review" || c.status === "rejected" ? (
        <div className="flex flex-wrap gap-2">
          <LoadingButton
            busy={busy === "approve"}
            className="inline-flex items-center gap-1.5"
            onClick={() => review("approve")}
          >
            <Check className="h-4 w-4" />{" "}
            {c.status === "rejected" ? "Aprovar mesmo assim" : "Aprovar"}
          </LoadingButton>
          {c.status === "pending_review" && (
            <button
              type="button"
              className="btn inline-flex items-center gap-1.5"
              disabled={busy !== null}
              onClick={() => setRejecting(true)}
            >
              <X className="h-4 w-4" /> Recusar
            </button>
          )}
        </div>
      ) : null}

      {c.status === "ready" && !rejecting && (
        <div className="flex flex-wrap items-center gap-2">
          {c.kind === "video" && file ? (
            <a className="btn inline-flex items-center gap-1.5" href={download(file.url, c.title)}>
              <Download className="h-4 w-4" /> Baixar vídeo
            </a>
          ) : (
            <span className="text-xs text-neutral-500">Toque em cada imagem para baixar.</span>
          )}
          <CopyButton value={fullCaption(c)} label="Copiar legenda" />
          {reviewable && (
            <button
              type="button"
              className="text-xs text-neutral-500 hover:text-red-600 hover:underline"
              disabled={busy !== null}
              onClick={() => setRejecting(true)}
            >
              Reprovar
            </button>
          )}
        </div>
      )}

      <ErrorText error={error} />

      <details className="text-sm">
        <summary className="cursor-pointer text-neutral-500">Legenda</summary>
        <p className="mt-2 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
          {fullCaption(c)}
        </p>
      </details>

      {c.status === "ready" && (
        <div className="space-y-1.5">
          <div className="text-xs text-neutral-500">
            {c.posted_to.length
              ? `Postado em ${c.posted_to.join(", ")}${c.posted_at ? ` · ${fmtDate(c.posted_at)}` : ""}. Toque de novo para desmarcar.`
              : "Marque onde postou:"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AUDIENCE_SOURCES.map((s) => (
              <Chip
                key={s.source}
                on={c.posted_to.includes(s.source)}
                disabled={busy !== null}
                onClick={() => togglePosted(s.source)}
              >
                {s.label}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
