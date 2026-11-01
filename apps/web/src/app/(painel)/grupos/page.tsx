"use client";

import type { Channel, Segment } from "@ofertas/contracts";
import { Loader2, Pencil, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Badge, ErrorText, InlineInput, PageHeader, Tag } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { CreatePanel } from "./create-panel";

const errText = (err: unknown, fallback = "Erro inesperado.") =>
  err instanceof ApiError ? `${err.message} ${err.hint ?? ""}`.trim() : fallback;

/** Editor de segmentos de um grupo (substitui a lista inteira ao salvar). */
function SegmentEditor({
  channel,
  segments,
  onSave,
  onCancel,
}: {
  channel: Channel;
  segments: Segment[];
  onSave: (ids: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [ids, setIds] = useState(new Set(channel.segment_ids));
  const [saving, setSaving] = useState(false);
  if (segments.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        Crie um segmento acima (ex.: casa, tech) para organizar os grupos.{" "}
        <button type="button" className="underline" onClick={onCancel}>
          Fechar
        </button>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {segments.map((s) => {
        const on = ids.has(s.id);
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={on}
            onClick={() => {
              const next = new Set(ids);
              if (on) next.delete(s.id);
              else next.add(s.id);
              setIds(next);
            }}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${
              on
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {s.name}
          </button>
        );
      })}
      <button
        type="button"
        className="btn inline-flex items-center gap-1.5"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          await onSave([...ids]);
          setSaving(false);
        }}
      >
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Salvar
      </button>
      <button type="button" className="btn-ghost" disabled={saving} onClick={onCancel}>
        Cancelar
      </button>
    </div>
  );
}

export default function GruposPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState<"group" | "community" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Grupo com ação em andamento (linha esmaecida) e o que acabou de sair (linha sumindo). */
  const [busy, setBusy] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([
      api<Channel[]>(`/channels${showArchived ? "?include_archived=true" : ""}`),
      api<Segment[]>("/segments"),
    ]);
    setChannels(c);
    setSegments(s);
  }, [showArchived]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function createSegment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name") ?? "");
    await run(() => api("/segments", { method: "POST", body: { name } }));
    form.reset();
  }

  async function renameSegment(s: Segment, name: string) {
    setRenaming(null);
    if (!name || name === s.name) return;
    await run(
      () => api(`/segments/${s.id}`, { method: "PATCH", body: { name } }),
      "Segmento renomeado.",
    );
  }

  async function deleteSegment(s: Segment) {
    setError(null);
    setMsg(null);
    try {
      // A prévia já recusa se o segmento estiver em uso por regra ou convite.
      await api(`/segments/${s.id}?dry_run=true`, { method: "DELETE" });
      const extra = s.channel_count
        ? `\n${s.channel_count} grupo(s) continuam, só perdem este segmento.`
        : "";
      if (!confirm(`Apagar o segmento "${s.name}"?${extra}`)) return;
      await api(`/segments/${s.id}`, { method: "DELETE" });
      setMsg(`Segmento "${s.name}" apagado.`);
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function saveSegments(ch: Channel, ids: string[]) {
    await run(async () => {
      await api(`/channels/${ch.id}`, { method: "PATCH", body: { segment_ids: ids } });
      setEditing(null);
    });
  }

  async function withBusy(ch: Channel, fn: () => Promise<unknown>, ok?: string) {
    setBusy(ch.id);
    await run(fn, ok);
    setBusy(null);
  }

  function toggleAdminOnly(ch: Channel) {
    withBusy(ch, () =>
      api(`/channels/${ch.id}/admin-only`, {
        method: "POST",
        body: { admin_only: !ch.admin_only },
      }),
    );
  }

  function toggleStatus(ch: Channel) {
    const status = ch.status === "active" ? "paused" : "active";
    withBusy(ch, () => api(`/channels/${ch.id}`, { method: "PATCH", body: { status } }));
  }

  async function removeChannel(ch: Channel) {
    setError(null);
    setMsg(null);
    try {
      const prev = await api<{ preview: { scheduled_posts_canceled: number } }>(
        `/channels/${ch.id}?dry_run=true`,
        { method: "PATCH", body: { status: "archived" } },
      );
      const n = prev.preview.scheduled_posts_canceled;
      const text = [
        `Remover "${ch.name}" da plataforma?`,
        "O grupo continua no WhatsApp; aqui ele para de receber ofertas. Histórico e métricas ficam guardados.",
        n ? `${n} publicação(ões) agendada(s) serão canceladas.` : null,
      ]
        .filter(Boolean)
        .join("\n");
      if (!confirm(text)) return;
      setBusy(ch.id);
      await api(`/channels/${ch.id}`, { method: "PATCH", body: { status: "archived" } });
      if (!showArchived) {
        setLeaving(ch.id);
        await new Promise((ok) => setTimeout(ok, 300));
        setChannels((list) => list.filter((x) => x.id !== ch.id));
      }
      setMsg(`"${ch.name}" removido. Para trazer de volta, marque "Mostrar removidos".`);
      await load();
    } catch (err) {
      setError(errText(err, "Erro ao remover."));
    } finally {
      setBusy(null);
      setLeaving(null);
    }
  }

  function restoreChannel(ch: Channel) {
    withBusy(
      ch,
      () => api(`/channels/${ch.id}`, { method: "PATCH", body: { status: "active" } }),
      `"${ch.name}" voltou a receber ofertas.`,
    );
  }

  const segName = (id: string) => segments.find((s) => s.id === id)?.name ?? "?";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Grupos"
        subtitle={
          <>
            Os grupos vêm do seu número em WhatsApp → Importar grupos. Organize-os em segmentos para
            as regras automáticas e os links de convite.
          </>
        }
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setCreating("community")}>
              Criar comunidade
            </button>
            <button type="button" className="btn" onClick={() => setCreating("group")}>
              Criar grupo
            </button>
          </>
        }
      />
      <ErrorText error={error} />
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      {creating && (
        <CreatePanel
          key={creating}
          mode={creating}
          segments={segments}
          onClose={() => setCreating(null)}
          onDone={(text) => {
            setCreating(null);
            setMsg(text);
            load();
          }}
        />
      )}

      <section className="card space-y-3">
        <h2 className="font-medium">Segmentos (nichos)</h2>
        <div className="flex flex-wrap gap-2">
          {segments.map((s) => (
            <span
              key={s.id}
              className="inline-flex items-center gap-1 rounded-full border border-neutral-300 py-1 pr-1 pl-3 text-sm dark:border-neutral-700"
            >
              {s.name} <span className="text-neutral-500 tabular-nums">· {s.channel_count}</span>
              <button
                type="button"
                title="Renomear"
                aria-label={`Renomear ${s.name}`}
                className="rounded-full p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onClick={() => setRenaming(renaming === s.id ? null : s.id)}
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="Apagar"
                aria-label={`Apagar ${s.name}`}
                className="rounded-full p-1 text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                onClick={() => deleteSegment(s)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {segments.length === 0 && (
            <span className="text-sm text-neutral-500">Nenhum segmento ainda.</span>
          )}
        </div>
        {(() => {
          const s = segments.find((x) => x.id === renaming);
          return s ? (
            <InlineInput
              key={s.id}
              label={`Novo nome para “${s.name}”`}
              initial={s.name}
              maxLength={60}
              submitLabel="Renomear"
              onSubmit={(name) => renameSegment(s, name)}
              onCancel={() => setRenaming(null)}
            />
          ) : null;
        })()}
        <form onSubmit={createSegment} className="flex gap-2">
          <input className="input" name="name" placeholder="Novo segmento, ex.: casa" required />
          <button className="btn" type="submit">
            Adicionar
          </button>
        </form>
      </section>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Grupos</h2>
          <label className="flex items-center gap-2 text-sm text-neutral-500">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Mostrar removidos
          </label>
        </div>
        {channels.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nenhum grupo ainda. Conecte um número em WhatsApp e clique em Importar grupos.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 font-normal">Nome</th>
                <th className="py-2 font-normal">Segmentos</th>
                <th className="py-2 font-normal">Ocupação</th>
                <th className="py-2 font-normal">Convite</th>
                <th className="py-2 font-normal">Status</th>
                <th className="py-2 font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {channels.map((c) => {
                const pct = Math.min(100, Math.round((c.member_count / c.member_limit) * 100));
                const fromWhatsApp = Boolean(c.external_id);
                const archived = c.status === "archived";
                const cantPost = c.admin_only === true && c.number_is_admin === false;
                return (
                  <Fragment key={c.id}>
                    <tr
                      aria-busy={busy === c.id}
                      className={`transition-all duration-300 ${
                        leaving === c.id
                          ? "opacity-0"
                          : busy === c.id
                            ? "pointer-events-none opacity-50"
                            : archived
                              ? "opacity-60"
                              : ""
                      }`}
                    >
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {fromWhatsApp && c.messaging_account_id && !archived ? (
                            <Link href={`/grupos/${c.id}`} className="font-medium hover:underline">
                              {c.name}
                            </Link>
                          ) : (
                            c.name
                          )}
                          {c.type === "wa_community" && <Tag tone="info">Comunidade</Tag>}
                          {c.provider_state !== "ok" && (
                            <Tag tone="negative">
                              {c.provider_state === "deleted" ? "Apagado no WhatsApp" : "Suspenso"}
                            </Tag>
                          )}
                          {cantPost && !archived && (
                            <Tag tone="negative">Número não é admin: não publica</Tag>
                          )}
                        </div>
                        <div className="text-xs text-neutral-500">
                          {fromWhatsApp
                            ? c.messaging_account_id
                              ? `WhatsApp${c.admin_only ? " · só admins" : " · todos enviam"}`
                              : "Sem número ligado (reimporte em WhatsApp)"
                            : "Sem WhatsApp (cadastro antigo): só para convites"}
                        </div>
                      </td>
                      <td className="py-2">
                        <button
                          type="button"
                          className="text-left hover:underline disabled:no-underline"
                          disabled={archived}
                          onClick={() => setEditing(editing === c.id ? null : c.id)}
                        >
                          {c.segment_ids.map(segName).join(", ") || (
                            <span className="text-amber-600">sem segmento</span>
                          )}
                        </button>
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
                            <div
                              className={`h-full ${pct >= 95 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="tabular-nums">
                            {c.member_count}/{c.member_limit}
                          </span>
                        </div>
                      </td>
                      <td className="py-2">
                        {c.invite_url ? "✓" : <span className="text-amber-600">sem link</span>}
                      </td>
                      <td className="py-2">
                        {archived ? (
                          <Tag>Removido</Tag>
                        ) : (
                          <Badge on={c.status === "active"} onLabel="Ativo" offLabel="Pausado" />
                        )}
                      </td>
                      <td className="space-x-1 py-2 text-right whitespace-nowrap">
                        {busy === c.id && (
                          <Loader2 className="inline h-3.5 w-3.5 animate-spin text-neutral-500" />
                        )}
                        {archived ? (
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => restoreChannel(c)}
                          >
                            Restaurar
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => setEditing(editing === c.id ? null : c.id)}
                            >
                              Segmentos
                            </button>
                            {c.messaging_account_id && c.number_is_admin !== false && (
                              <button
                                type="button"
                                className="btn-ghost"
                                onClick={() => toggleAdminOnly(c)}
                              >
                                {c.admin_only ? "Liberar envio" : "Só admins"}
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => toggleStatus(c)}
                            >
                              {c.status === "active" ? "Pausar" : "Ativar"}
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => removeChannel(c)}
                            >
                              Remover
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {editing === c.id && !archived && (
                      <tr>
                        <td colSpan={6} className="bg-neutral-50 px-3 py-3 dark:bg-neutral-900">
                          <SegmentEditor
                            channel={c}
                            segments={segments}
                            onSave={(ids) => saveSegments(c, ids)}
                            onCancel={() => setEditing(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
