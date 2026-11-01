"use client";

import type { AffiliateAccount } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  ChoiceCards,
  ConfirmButton,
  Empty,
  ErrorText,
  Field,
  Loading,
  LoadingButton,
  PageHeader,
  PlatformBadge,
  Tag,
} from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";

type CredField = {
  key: string;
  label: string;
  optional?: boolean;
  secret?: boolean;
  placeholder?: string;
};
type Platforms = { credential_fields: Record<string, CredField[]> };
type ReadyPlatform = "shopee" | "amazon";

/** Lojas com integração e os modos de cada uma (as demais aparecem como "em breve"). */
const PLATFORM_MODES: Record<ReadyPlatform, AffiliateAccount["mode"][]> = {
  shopee: ["feed", "live", "fake"],
  amazon: ["live", "fake"],
};
const isReady = (p: string): p is ReadyPlatform => p in PLATFORM_MODES;

const modeLabel = (a: AffiliateAccount) =>
  a.platform === "amazon" && a.mode === "live"
    ? "Associado (tag): busca e links"
    : MODE_LABEL[a.mode];

const MODE_LABEL: Record<AffiliateAccount["mode"], string> = {
  fake: "Simulado",
  live: "Real (API)",
  feed: "Feed de produtos",
};

const mb = (n: number) => `${(n / 1_048_576).toFixed(n > 100 * 1_048_576 ? 0 : 1)} MB`;

/** Situação do catálogo de uma conta em modo feed, com barra de progresso durante a importação. */
function FeedStatus({ feed }: { feed: NonNullable<AffiliateAccount["feed"]> }) {
  if (feed.running) {
    const p = feed.progress;
    // Progresso total: arquivos concluídos + fração do arquivo atual.
    const pct =
      p?.total && p.files
        ? Math.min(100, Math.round(((p.file - 1 + p.bytes / p.total) / p.files) * 100))
        : null;
    return (
      <div className="mt-1 space-y-1 text-xs text-neutral-500">
        <div className="flex items-center justify-between gap-2">
          <span>
            Importando{p ? ` arquivo ${p.file} de ${p.files}` : "…"}
            {pct !== null && ` · ${pct}%`}
          </span>
          {p && (
            <span className="tabular-nums">
              {mb(p.bytes)}
              {p.total ? ` de ${mb(p.total)}` : ""}
            </span>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            className={`h-full rounded-full bg-brand-500 transition-[width] duration-500 ${
              pct === null ? "w-1/3 animate-pulse" : ""
            }`}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
        <div className="tabular-nums">
          {feed.read.toLocaleString("pt-BR")} lidos · {feed.items.toLocaleString("pt-BR")} em
          desconto guardados
        </div>
      </div>
    );
  }
  if (!feed.synced_at && !feed.error) {
    return <span className="text-xs text-neutral-500">Importação começa em até 1 minuto</span>;
  }
  return (
    <span className="text-xs text-neutral-500">
      {feed.items.toLocaleString("pt-BR")} produtos em desconto
      {feed.read ? ` (de ${feed.read.toLocaleString("pt-BR")} lidos)` : ""}
      {feed.synced_at && ` · atualizado ${fmtDate(feed.synced_at)}`}
      {feed.error && <span className="block text-red-600">{feed.error}</span>}
    </span>
  );
}

/** Edição de nome e credenciais. Campos em branco mantêm o valor atual. */
function EditAccount({
  account,
  liveFields,
  onDone,
  onCancel,
}: {
  account: AffiliateAccount;
  liveFields: CredField[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields =
    account.mode === "feed"
      ? [
          { key: "affiliate_id", label: "ID de afiliado" },
          { key: "feed_urls", label: "Links do feed (um por linha)" },
        ]
      : account.mode === "live"
        ? liveFields
        : [];

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const credentials = Object.fromEntries(
      fields.map((c) => [c.key, String(f.get(c.key) ?? "").trim()]).filter(([, v]) => v),
    );
    setSaving(true);
    setError(null);
    try {
      await api(`/affiliate-accounts/${account.id}`, {
        method: "PUT",
        body: {
          label: String(f.get("label") ?? "").trim() || undefined,
          ...(Object.keys(credentials).length ? { credentials } : {}),
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={save}
      className="mt-3 grid gap-3 rounded-lg border border-neutral-200 p-3 md:grid-cols-2 dark:border-neutral-800"
    >
      <Field label="Nome da conta" htmlFor={`label-${account.id}`}>
        <input
          className="input"
          id={`label-${account.id}`}
          name="label"
          defaultValue={account.label}
          required
        />
      </Field>
      {fields.map((c) => (
        <div key={c.key} className={c.key === "feed_urls" ? "md:col-span-2" : ""}>
          <Field label={c.label} htmlFor={`${c.key}-${account.id}`}>
            {c.key === "feed_urls" ? (
              <textarea
                className="input font-mono text-xs"
                id={`${c.key}-${account.id}`}
                name={c.key}
                rows={3}
                placeholder="Em branco mantém os links atuais. Novos links pedem nova importação."
              />
            ) : (
              <input
                className="input font-mono"
                id={`${c.key}-${account.id}`}
                name={c.key}
                type={c.secret ? "password" : "text"}
                autoComplete="off"
                placeholder="Em branco mantém o atual"
              />
            )}
          </Field>
        </div>
      ))}
      <div className="space-y-2 md:col-span-2">
        {fields.length > 0 && (
          <p className="text-xs text-neutral-500">
            Por segurança, as credenciais salvas não são mostradas. As novas são testadas antes de
            salvar.
          </p>
        )}
        <ErrorText error={error} />
        <div className="flex gap-2">
          <LoadingButton busy={saving} type="submit">
            {saving && fields.length ? "Testando…" : "Salvar"}
          </LoadingButton>
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
        </div>
      </div>
    </form>
  );
}

const PLATFORM_LABEL: Record<string, string> = {
  shopee: "Shopee",
  amazon: "Amazon",
  mercadolivre: "Mercado Livre",
  magalu: "Magazine Luiza",
};

const AMAZON_MODES: { value: AffiliateAccount["mode"]; label: string; hint: string }[] = [
  {
    value: "live",
    label: "Associado",
    hint: "Sua tag de associado. Busque produtos ou cole links da Amazon; o preço é conferido antes de cada envio.",
  },
  {
    value: "fake",
    label: "Simulado",
    hint: "Catálogo de teste com links da Amazon, sem credenciais.",
  },
];

export default function AfiliadosPage() {
  const [accounts, setAccounts] = useState<AffiliateAccount[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [fields, setFields] = useState<Platforms["credential_fields"]>({});
  const [platform, setPlatform] = useState<ReadyPlatform>("shopee");
  const [mode, setMode] = useState<AffiliateAccount["mode"]>("feed");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [acc, plat] = await Promise.all([
      api<AffiliateAccount[]>("/affiliate-accounts"),
      api<Platforms>("/affiliate-accounts/platforms"),
    ]);
    setAccounts(acc);
    setFields(plat.credential_fields);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const form = e.currentTarget;
    const f = new FormData(form);
    setMsg(null);
    const credentials =
      mode === "feed"
        ? {
            affiliate_id: String(f.get("affiliate_id") ?? "").trim(),
            feed_urls: String(f.get("feed_urls") ?? "").trim(),
          }
        : Object.fromEntries(
            (fields[platform] ?? [])
              .map((c) => [c.key, String(f.get(`cred_${c.key}`) ?? "").trim()])
              .filter(([, v]) => v),
          );
    try {
      await api("/affiliate-accounts", {
        method: "POST",
        body: {
          platform,
          label: f.get("label"),
          mode,
          ...(mode !== "fake" ? { credentials } : {}),
        },
      });
      form.reset();
      await load();
      setMsg(
        mode === "feed"
          ? "Feed conectado. A importação começa em até 1 minuto e pode levar alguns minutos."
          : mode === "live"
            ? platform === "amazon"
              ? "Conta Amazon conectada. Cole links da Amazon em Ofertas › Colar link: a sua tag entra sozinha."
              : "Conta conectada e testada."
            : "Conta simulada conectada.",
      );
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
    } finally {
      setSaving(false);
    }
  }

  async function resync(a: AffiliateAccount) {
    setError(null);
    setBusy(`sync:${a.id}`);
    try {
      await api(`/affiliate-accounts/${a.id}/feed-sync`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(a: AffiliateAccount) {
    setError(null);
    setBusy(`del:${a.id}`);
    try {
      await api(`/affiliate-accounts/${a.id}`, { method: "DELETE" });
      setMsg(`Conta "${a.label}" removida.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao remover.");
    } finally {
      setBusy(null);
    }
  }

  // Enquanto algum feed importa, atualiza a lista sozinho (mais rápido com importação em curso).
  const running = accounts?.some((a) => a.feed?.running);
  const waiting = accounts?.some((a) => a.feed && !a.feed.running && !a.feed.synced_at);
  useEffect(() => {
    if (!running && !waiting) return;
    const t = setInterval(load, running ? 3_000 : 10_000);
    return () => clearInterval(t);
  }, [running, waiting, load]);

  async function toggle(a: AffiliateAccount) {
    setError(null);
    setBusy(a.id);
    try {
      await api(`/affiliate-accounts/${a.id}`, {
        method: "PATCH",
        body: { status: a.status === "disabled" ? "active" : "disabled" },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro inesperado.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Contas de afiliado"
        subtitle={<>As credenciais ficam cifradas no servidor e nunca são mostradas a agentes.</>}
      />

      <form onSubmit={connect} className="card grid gap-4 md:grid-cols-2">
        <h2 className="font-medium md:col-span-2">Conectar conta</h2>
        <div className="space-y-1.5 md:col-span-2">
          <div className="label">Plataforma</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(PLATFORM_LABEL).map(([key, label]) => {
              const ready = isReady(key);
              const selected = key === platform;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!ready}
                  aria-pressed={selected}
                  onClick={() => {
                    if (!isReady(key)) return;
                    setPlatform(key);
                    setMode(PLATFORM_MODES[key][0] ?? "fake");
                  }}
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    selected
                      ? "border-brand-500 bg-brand-50/60 dark:bg-brand-500/10"
                      : ready
                        ? "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800"
                        : "border-neutral-200 text-neutral-400 dark:border-neutral-800"
                  }`}
                >
                  <PlatformBadge platform={key} showLabel={false} />
                  {label}
                  {!ready && <span className="text-xs">em breve</span>}
                </button>
              );
            })}
          </div>
        </div>
        <Field label="Nome da conta" htmlFor="label">
          <input
            key={platform}
            className="input"
            id="label"
            name="label"
            required
            defaultValue={PLATFORM_LABEL[platform]}
          />
        </Field>
        <div className="space-y-1.5 md:col-span-2">
          <div className="label">Modo</div>
          <ChoiceCards
            columns={3}
            value={mode}
            onChange={setMode}
            options={
              platform === "amazon"
                ? AMAZON_MODES
                : [
                    {
                      value: "feed",
                      label: "Feed de produtos",
                      hint: "CSV oficial da Shopee, atualizado todo dia. Ofertas reais sem precisar da API.",
                    },
                    {
                      value: "live",
                      label: "Real (API)",
                      hint: "API de Afiliados da Shopee: precisa de App ID e senha.",
                    },
                    {
                      value: "fake",
                      label: "Simulado",
                      hint: "Catálogo de teste, sem credenciais. Bom para conhecer a plataforma.",
                    },
                  ]
            }
          />
        </div>
        {platform === "shopee" && mode === "feed" && (
          <>
            <Field label="ID de afiliado" htmlFor="affiliate_id">
              <input
                className="input font-mono"
                id="affiliate_id"
                name="affiliate_id"
                inputMode="numeric"
                placeholder="14354840000"
                autoComplete="off"
                required
              />
            </Field>
            <p className="self-end text-xs text-neutral-500">
              Só os números. Aparece nos seus links de afiliado como <code>utm_source=an_</code>
              <em>número</em>, ou no portal em Minha conta.
            </p>
            <div className="md:col-span-2">
              <Field label="Links do feed (um por linha)" htmlFor="feed_urls">
                <textarea
                  className="input font-mono text-xs"
                  id="feed_urls"
                  name="feed_urls"
                  rows={3}
                  required
                  placeholder="https://affiliate.shopee.com.br/api/v1/datafeed/download?id=…"
                />
              </Field>
              <p className="mt-1 text-xs text-neutral-500">
                No portal de afiliados: Criativo › Feed de Produtos › View Link › Copy. Cole um link
                por linha (pode juntar vários feeds). Só entram produtos com 10% de desconto ou mais
                e avaliação 4+; o catálogo é refeito todo dia.
              </p>
            </div>
          </>
        )}
        {mode === "live" && (
          <p className="text-xs text-neutral-500 md:col-span-2">
            {platform === "amazon" ? (
              <>
                A tag fica em Associados Amazon › Gerenciar IDs de rastreamento (termina em -20). A
                busca lê a página de resultados da Amazon. A Creators API é opcional (o acesso sai
                depois de 10 vendas em 30 dias, em Associados › Ferramentas). A Amazon não permite
                encurtador próprio, então os posts levam o link da Amazon direto.
              </>
            ) : (
              <>
                Pegue o App ID e a senha no painel de afiliados da Shopee (Open API). A plataforma
                testa a conexão antes de salvar.
              </>
            )}
          </p>
        )}
        {mode === "live" &&
          (fields[platform] ?? []).map((c) => (
            <Field
              key={`${platform}-${c.key}`}
              label={c.optional ? `${c.label} (opcional)` : c.label}
              htmlFor={`cred_${c.key}`}
            >
              <input
                className="input font-mono"
                id={`cred_${c.key}`}
                name={`cred_${c.key}`}
                type={c.secret ? "password" : "text"}
                placeholder={c.placeholder}
                autoComplete="off"
                required={!c.optional}
              />
            </Field>
          ))}
        <div className="md:col-span-2">
          <ErrorText error={error} />
          {msg && <p className="text-sm text-emerald-700">{msg}</p>}
          <LoadingButton busy={saving} type="submit" className="mt-2">
            {saving ? (mode === "fake" ? "Conectando…" : "Testando conexão…") : "Conectar"}
          </LoadingButton>
        </div>
      </form>

      <section className="card">
        <h2 className="mb-3 font-medium">Contas</h2>
        {!accounts ? (
          <Loading />
        ) : accounts.length === 0 ? (
          <Empty>Nenhuma conta conectada. Sem conta não há ofertas para buscar.</Empty>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {accounts.map((a) => (
              <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.label}</span>
                      <PlatformBadge platform={a.platform} />
                      {a.status === "error" ? (
                        <Tag tone="negative" dot>
                          Com erro
                        </Tag>
                      ) : (
                        <Badge on={a.status === "active"} onLabel="Ativa" offLabel="Desativada" />
                      )}
                    </div>
                    <div className="text-sm text-neutral-600 dark:text-neutral-400">
                      {modeLabel(a)}
                    </div>
                    {a.feed && <FeedStatus feed={a.feed} />}
                    {a.status === "error" && a.last_error && (
                      <div className="text-xs text-red-600">{a.last_error}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {a.feed && a.status !== "disabled" && (
                      <LoadingButton
                        variant="btn-ghost"
                        busy={busy === `sync:${a.id}`}
                        disabled={a.feed.running}
                        onClick={() => resync(a)}
                      >
                        Atualizar agora
                      </LoadingButton>
                    )}
                    <button
                      type="button"
                      className="btn-ghost"
                      aria-expanded={editing === a.id}
                      onClick={() => setEditing(editing === a.id ? null : a.id)}
                    >
                      Editar
                    </button>
                    <LoadingButton
                      variant="btn-ghost"
                      busy={busy === a.id}
                      onClick={() => toggle(a)}
                    >
                      {a.status === "disabled" ? "Ativar" : "Desativar"}
                    </LoadingButton>
                    <ConfirmButton
                      busy={busy === `del:${a.id}`}
                      onConfirm={() => remove(a)}
                      message={
                        <>
                          Remover <strong>{a.label}</strong>? As ofertas e publicações ficam
                          {a.mode === "feed" ? "; o catálogo do feed é apagado" : ""}.
                        </>
                      }
                    >
                      Remover
                    </ConfirmButton>
                  </div>
                </div>
                {editing === a.id && (
                  <EditAccount
                    account={a}
                    liveFields={fields[a.platform] ?? []}
                    onCancel={() => setEditing(null)}
                    onDone={() => {
                      setEditing(null);
                      setMsg("Conta atualizada.");
                      load();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
