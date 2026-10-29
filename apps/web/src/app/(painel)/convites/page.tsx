"use client";

import type { InviteLink, LinkStats, Segment } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { Badge, CopyButton, ErrorText, Field } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

export default function ConvitesPage() {
  const [invites, setInvites] = useState<InviteLink[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [clicks, setClicks] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [inv, segs, stats] = await Promise.all([
      api<InviteLink[]>("/invite-links"),
      api<Segment[]>("/segments"),
      api<LinkStats>("/stats/clicks?group_by=invite"),
    ]);
    setInvites(inv);
    setSegments(segs);
    setClicks(Object.fromEntries(stats.rows.map((r) => [r.key ?? "", r.human])));
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

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const opt = (k: string) => String(f.get(k) ?? "").trim() || undefined;
    await run(() =>
      api("/invite-links", {
        method: "POST",
        body: {
          segment_id: f.get("segment_id"),
          name: f.get("name"),
          slug: opt("slug"),
          strategy: f.get("strategy"),
          reserve: Number(f.get("reserve") || 10),
          fallback_url: opt("fallback_url"),
        },
      }),
    );
    form.reset();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Convites rotativos</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Um link fixo para a bio, anúncios e stories. Cada pessoa cai num grupo do segmento que
          ainda tem vaga.
        </p>
      </div>

      {segments.length === 0 ? (
        <p className="card text-sm text-neutral-500">
          Crie um segmento e cadastre grupos com link de convite em <strong>Grupos</strong>{" "}
          primeiro.
        </p>
      ) : (
        <form onSubmit={create} className="card grid gap-4 md:grid-cols-2">
          <h2 className="font-medium md:col-span-2">Novo convite</h2>
          <Field label="Nome" htmlFor="name">
            <input
              className="input"
              id="name"
              name="name"
              required
              placeholder="Bio do Instagram"
            />
          </Field>
          <Field label="Segmento" htmlFor="segment_id">
            <select className="input" id="segment_id" name="segment_id" required>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.channel_count} grupos)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Slug (opcional)" htmlFor="slug">
            <input className="input" id="slug" name="slug" placeholder="ex.: tech → /entrar/tech" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Estratégia" htmlFor="strategy">
              <select className="input" id="strategy" name="strategy" defaultValue="fill_first">
                <option value="fill_first">Encher um por vez</option>
                <option value="round_robin">Alternar grupos</option>
              </select>
            </Field>
            <Field label="Vagas de reserva" htmlFor="reserve">
              <input
                className="input"
                id="reserve"
                name="reserve"
                type="number"
                min={0}
                defaultValue={10}
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Se todos lotarem, mandar para (opcional)" htmlFor="fallback_url">
              <input
                className="input"
                id="fallback_url"
                name="fallback_url"
                type="url"
                placeholder="https://instagram.com/seuperfil"
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <ErrorText error={error} />
            <button className="btn mt-2" type="submit">
              Criar convite
            </button>
          </div>
        </form>
      )}

      <section className="space-y-3">
        {invites.map((i) => {
          const full = i.capacity.channels === 0;
          return (
            <div key={i.id} className="card space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{i.name}</div>
                  <div className="font-mono text-sm text-neutral-500">{i.url}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge on={i.active} onLabel="Ativo" offLabel="Pausado" />
                  <CopyButton value={i.url} />
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() =>
                      run(() =>
                        api(`/invite-links/${i.id}`, {
                          method: "PATCH",
                          body: { active: !i.active },
                        }),
                      )
                    }
                  >
                    {i.active ? "Pausar" : "Ativar"}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div>
                  <div className="text-neutral-500">Segmento</div>
                  {i.segment_name}
                </div>
                <div>
                  <div className="text-neutral-500">Próximo grupo</div>
                  {full ? (
                    <span className="font-medium text-red-600">Todos lotados</span>
                  ) : (
                    i.capacity.current_channel?.name
                  )}
                </div>
                <div>
                  <div className="text-neutral-500">Vagas livres</div>
                  <span className="tabular-nums">
                    {i.capacity.available_slots} em {i.capacity.channels} grupo(s)
                  </span>
                </div>
                <div>
                  <div className="text-neutral-500">Entradas (7 dias)</div>
                  <span className="tabular-nums">{clicks[i.id] ?? 0}</span>
                </div>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
