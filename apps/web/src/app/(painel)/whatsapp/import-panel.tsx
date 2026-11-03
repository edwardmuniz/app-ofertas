"use client";

import type {
  MessagingAccount,
  Segment,
  SyncGroupsPreview,
  SyncGroupsResult,
} from "@ofertas/contracts";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ErrorText, Tag } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

type Group = SyncGroupsPreview["groups"][number];

/** Já ligado a este número: não precisa escolher de novo. */
const inPlatform = (g: Group) => g.linked && g.channel_status !== "archived";
/** Está na plataforma mas sem número (o número antigo foi removido): dá para religar. */
const orphan = (g: Group) => !g.linked && g.channel_id !== null && g.channel_status !== "archived";

/** Escolha dos grupos do número que entram na plataforma. */
export function ImportPanel({
  account,
  onClose,
  onDone,
}: {
  account: MessagingAccount;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [preview, setPreview] = useState<SyncGroupsPreview | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [segIds, setSegIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ preview: SyncGroupsPreview }>(
        `/whatsapp/accounts/${account.id}/sync-groups?dry_run=true`,
        { method: "POST", body: {} },
      ),
      api<Segment[]>("/segments"),
    ])
      .then(([p, s]) => {
        if (!alive) return;
        setPreview(p.preview);
        setSegments(s);
        // Grupos que ficaram sem número já vêm marcados para religar.
        setPicked(new Set(p.preview.groups.filter(orphan).map((g) => g.jid)));
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro.");
      });
    return () => {
      alive = false;
    };
  }, [account.id]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = preview?.groups ?? [];
    return (q ? list.filter((g) => g.name.toLowerCase().includes(q)) : list)
      .slice()
      .sort(
        (a, b) => Number(inPlatform(a)) - Number(inPlatform(b)) || a.name.localeCompare(b.name),
      );
  }, [preview, query]);

  const choosable = groups.filter((g) => !inPlatform(g));
  const allVisiblePicked = choosable.length > 0 && choosable.every((g) => picked.has(g.jid));

  function toggle(set: Set<string>, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function toggleVisible() {
    const next = new Set(picked);
    for (const g of choosable) {
      if (allVisiblePicked) next.delete(g.jid);
      else next.add(g.jid);
    }
    setPicked(next);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ result?: SyncGroupsResult }>(
        `/whatsapp/accounts/${account.id}/sync-groups`,
        { method: "POST", body: { group_jids: [...picked], segment_ids: [...segIds] } },
      );
      const r = res.result;
      if (!r) throw new Error();
      const parts = [`${picked.size} grupo(s) importado(s).`];
      if (r.no_invite.length) {
        parts.push(`Sem link de convite (o número não é admin): ${r.no_invite.join(", ")}.`);
      }
      parts.push("Veja em Grupos.");
      onDone(parts.join(" "));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao importar.");
      setBusy(false);
    }
  }

  async function archive(channelId: string) {
    setError(null);
    try {
      await api(`/channels/${channelId}`, { method: "PATCH", body: { status: "archived" } });
      setArchived((s) => new Set(s).add(channelId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao remover o grupo.");
    }
  }

  if (!preview) {
    return (
      <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        {error ? (
          <div className="space-y-2">
            <ErrorText error={error} />
            <button type="button" className="btn-ghost" onClick={onClose}>
              Fechar
            </button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando os grupos do número…
          </p>
        )}
      </div>
    );
  }

  const left = preview.left.filter((l) => !archived.has(l.channel_id));

  return (
    <div className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div>
        <h3 className="font-medium">Escolha os grupos de ofertas</h3>
        <p className="text-sm text-neutral-500">
          O número está em {preview.groups.length} grupo(s). Marque só os que a plataforma vai usar;
          grupos pessoais ficam de fora.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder="Buscar grupo"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {choosable.length > 0 && (
          <button type="button" className="btn-ghost" onClick={toggleVisible}>
            {allVisiblePicked ? "Desmarcar visíveis" : "Marcar visíveis"}
          </button>
        )}
      </div>

      <ul className="max-h-96 divide-y divide-neutral-200 overflow-y-auto rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {groups.map((g) => {
          const already = inPlatform(g);
          const cantPost = g.admin_only === true && g.number_is_admin === false;
          return (
            <li key={g.jid}>
              <label
                className={`flex items-center gap-3 px-3 py-2 text-sm ${already ? "opacity-60" : "cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50"}`}
              >
                <input
                  type="checkbox"
                  checked={already || picked.has(g.jid)}
                  disabled={already}
                  onChange={() => setPicked((s) => toggle(s, g.jid))}
                />
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  {already && <Tag tone="positive">Na plataforma</Tag>}
                  {g.channel_status === "archived" && <Tag>Removido antes</Tag>}
                  {orphan(g) && <Tag tone="warning">Sem número: religar</Tag>}
                  {cantPost ? (
                    <Tag tone="negative">Só admins enviam e o número não é admin</Tag>
                  ) : g.number_is_admin === false ? (
                    <Tag tone="warning">Número não é admin</Tag>
                  ) : null}
                  <span className="w-20 text-right text-xs text-neutral-500 tabular-nums">
                    {g.participant_count} membros
                  </span>
                </span>
              </label>
            </li>
          );
        })}
        {groups.length === 0 && (
          <li className="px-3 py-4 text-sm text-neutral-500">Nenhum grupo encontrado.</li>
        )}
      </ul>

      {segments.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm">Colocar os escolhidos nos segmentos</div>
          <div className="flex flex-wrap gap-2">
            {segments.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={segIds.has(s.id)}
                onClick={() => setSegIds((set) => toggle(set, s.id))}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  segIds.has(s.id)
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 dark:border-neutral-700"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {left.length > 0 && (
        <div className="space-y-1.5 rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-500/10">
          <div className="font-medium">O número não está mais nestes grupos</div>
          <p className="text-neutral-600 dark:text-neutral-400">
            Publicações para eles vão falhar. Remova da plataforma se não for voltar.
          </p>
          <ul className="space-y-1">
            {left.map((l) => (
              <li key={l.channel_id} className="flex items-center justify-between gap-2">
                <span className="truncate">{l.name}</span>
                <button type="button" className="btn-ghost" onClick={() => archive(l.channel_id)}>
                  Remover
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn inline-flex items-center gap-1.5"
          disabled={busy || picked.size === 0}
          onClick={submit}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? "Importando…" : `Importar ${picked.size} grupo(s)`}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
