"use client";

import type { Channel, Segment } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { Badge, ErrorText, Field } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

export default function GruposPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([api<Channel[]>("/channels"), api<Segment[]>("/segments")]);
    setChannels(c);
    setSegments(s);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro inesperado.");
    }
  }

  async function createSegment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name") ?? "");
    await run(() => api("/segments", { method: "POST", body: { name } }));
    form.reset();
  }

  async function createChannel(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const segmentId = String(f.get("segment_id") ?? "");
    await run(() =>
      api("/channels", {
        method: "POST",
        body: {
          name: f.get("name"),
          invite_url: String(f.get("invite_url") ?? "") || null,
          member_count: Number(f.get("member_count") || 0),
          member_limit: Number(f.get("member_limit") || 1024),
          segment_ids: segmentId ? [segmentId] : [],
        },
      }),
    );
    form.reset();
  }

  function editMembers(ch: Channel) {
    const v = prompt(`Membros atuais de "${ch.name}":`, String(ch.member_count));
    if (v === null || Number.isNaN(Number(v))) return;
    run(() => api(`/channels/${ch.id}`, { method: "PATCH", body: { member_count: Number(v) } }));
  }

  function toggleAdminOnly(ch: Channel) {
    run(() =>
      api(`/channels/${ch.id}/admin-only`, {
        method: "POST",
        body: { admin_only: !ch.admin_only },
      }),
    );
  }

  function toggleStatus(ch: Channel) {
    const status = ch.status === "active" ? "paused" : "active";
    run(() => api(`/channels/${ch.id}`, { method: "PATCH", body: { status } }));
  }

  const segName = (id: string) => segments.find((s) => s.id === id)?.name ?? "?";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Grupos</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Importe os grupos do seu número em WhatsApp, ou cadastre manualmente.
        </p>
      </div>
      <ErrorText error={error} />

      <section className="card space-y-3">
        <h2 className="font-medium">Segmentos (nichos)</h2>
        <div className="flex flex-wrap gap-2">
          {segments.map((s) => (
            <span
              key={s.id}
              className="rounded-full border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700"
            >
              {s.name} <span className="text-neutral-500 tabular-nums">· {s.channel_count}</span>
            </span>
          ))}
          {segments.length === 0 && (
            <span className="text-sm text-neutral-500">Nenhum segmento ainda.</span>
          )}
        </div>
        <form onSubmit={createSegment} className="flex gap-2">
          <input className="input" name="name" placeholder="Novo segmento, ex.: casa" required />
          <button className="btn" type="submit">
            Adicionar
          </button>
        </form>
      </section>

      <form onSubmit={createChannel} className="card grid gap-4 md:grid-cols-2">
        <h2 className="font-medium md:col-span-2">Novo grupo</h2>
        <Field label="Nome" htmlFor="name">
          <input className="input" id="name" name="name" required />
        </Field>
        <Field label="Segmento" htmlFor="segment_id">
          <select className="input" id="segment_id" name="segment_id">
            <option value="">Nenhum</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Link de convite do WhatsApp" htmlFor="invite_url">
          <input
            className="input"
            id="invite_url"
            name="invite_url"
            type="url"
            placeholder="https://chat.whatsapp.com/..."
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Membros" htmlFor="member_count">
            <input
              className="input"
              id="member_count"
              name="member_count"
              type="number"
              min={0}
              defaultValue={0}
            />
          </Field>
          <Field label="Limite" htmlFor="member_limit">
            <input
              className="input"
              id="member_limit"
              name="member_limit"
              type="number"
              min={1}
              defaultValue={1024}
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <button className="btn" type="submit">
            Cadastrar grupo
          </button>
        </div>
      </form>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 font-medium">Grupos cadastrados</h2>
        {channels.length === 0 ? (
          <p className="text-sm text-neutral-500">Nenhum grupo ainda.</p>
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
                return (
                  <tr key={c.id}>
                    <td className="py-2">
                      {c.name}
                      {c.messaging_account_id && (
                        <div className="text-xs text-neutral-500">
                          WhatsApp{c.admin_only ? " · só admins" : " · todos enviam"}
                        </div>
                      )}
                    </td>
                    <td className="py-2">{c.segment_ids.map(segName).join(", ") || "—"}</td>
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
                      <Badge
                        on={c.status === "active"}
                        onLabel="Ativo"
                        offLabel={c.status === "paused" ? "Pausado" : "Arquivado"}
                      />
                    </td>
                    <td className="space-x-1 py-2 text-right whitespace-nowrap">
                      <button type="button" className="btn-ghost" onClick={() => editMembers(c)}>
                        Membros
                      </button>
                      {c.messaging_account_id && (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => toggleAdminOnly(c)}
                        >
                          {c.admin_only ? "Liberar envio" : "Só admins"}
                        </button>
                      )}
                      <button type="button" className="btn-ghost" onClick={() => toggleStatus(c)}>
                        {c.status === "active" ? "Pausar" : "Ativar"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
