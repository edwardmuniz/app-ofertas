"use client";

import type { InviteLink, LinkStats, Segment } from "@ofertas/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Chip,
  ChoiceCards,
  CopyButton,
  Empty,
  ErrorText,
  Field,
  Loading,
  LoadingButton,
  PageHeader,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";

export default function ConvitesPage() {
  const [invites, setInvites] = useState<InviteLink[] | null>(null);
  const [segmentId, setSegmentId] = useState("");
  const [strategy, setStrategy] = useState<"fill_first" | "round_robin">("fill_first");
  const [reserve, setReserve] = useState(10);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<InviteLink | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
    setSegmentId((cur) => cur || segs.find((s) => s.channel_count > 0)?.id || segs[0]?.id || "");
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
    setCreating(true);
    setCreated(null);
    await run(async () => {
      const res = await api<{ result?: InviteLink }>("/invite-links", {
        method: "POST",
        body: {
          segment_id: segmentId,
          name: f.get("name"),
          slug: opt("slug"),
          strategy,
          reserve,
          fallback_url: opt("fallback_url"),
        },
      });
      if (res.result) {
        setCreated(res.result);
        form.reset();
      }
    });
    setCreating(false);
  }

  async function toggle(i: InviteLink) {
    setBusy(i.id);
    await run(() => api(`/invite-links/${i.id}`, { method: "PATCH", body: { active: !i.active } }));
    setBusy(null);
  }

  const chosen = segments.find((s) => s.id === segmentId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Convites rotativos"
        subtitle={
          <>
            Um link fixo para a bio, anúncios e stories. Cada pessoa cai num grupo do segmento que
            ainda tem vaga.
          </>
        }
      />

      {!invites ? (
        <Loading />
      ) : segments.length === 0 ? (
        <Empty>
          Crie um segmento e coloque grupos nele em{" "}
          <Link className="underline" href="/grupos">
            Grupos
          </Link>{" "}
          primeiro.
        </Empty>
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
          <Field label="Final do link (opcional)" htmlFor="slug">
            <input className="input" id="slug" name="slug" placeholder="ex.: tech → /entrar/tech" />
          </Field>
          <div className="space-y-1.5 md:col-span-2">
            <div className="label">Segmento (os grupos que recebem as pessoas)</div>
            <div className="flex flex-wrap gap-2">
              {segments.map((s) => (
                <Chip key={s.id} on={segmentId === s.id} onClick={() => setSegmentId(s.id)}>
                  {s.name}
                  <span className="opacity-60 tabular-nums">
                    · {s.channel_count} grupo{s.channel_count === 1 ? "" : "s"}
                  </span>
                </Chip>
              ))}
            </div>
            {chosen && chosen.channel_count === 0 && (
              <p className="text-xs text-amber-600">
                Este segmento não tem grupos: o convite cai direto no “se todos lotarem”.
              </p>
            )}
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <div className="label">Como distribuir</div>
            <ChoiceCards
              columns={2}
              value={strategy}
              onChange={setStrategy}
              options={[
                {
                  value: "fill_first",
                  label: "Encher um por vez",
                  hint: "Lota o grupo mais antigo antes de passar ao próximo.",
                },
                {
                  value: "round_robin",
                  label: "Alternar grupos",
                  hint: "Cada pessoa vai para um grupo diferente, em rodízio.",
                },
              ]}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <div className="label">Vagas de reserva por grupo</div>
            <div className="flex flex-wrap items-center gap-2">
              {[0, 5, 10, 20, 50].map((n) => (
                <Chip key={n} on={reserve === n} onClick={() => setReserve(n)}>
                  {n}
                </Chip>
              ))}
            </div>
            <p className="text-xs text-neutral-500">
              O grupo é considerado cheio {reserve ? `${reserve} vagas antes` : "só"} do limite,
              para sobrar espaço para quem você adiciona à mão.
            </p>
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
          <div className="space-y-3 md:col-span-2">
            <ErrorText error={error} />
            <LoadingButton busy={creating} type="submit" disabled={!segmentId}>
              Criar convite
            </LoadingButton>
            {created && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-500/10">
                <span>Convite criado:</span>
                <code className="font-mono">{created.url}</code>
                <CopyButton value={created.url} />
              </div>
            )}
          </div>
        </form>
      )}

      <section className="space-y-3">
        {invites && invites.length === 0 && segments.length > 0 && (
          <Empty>Nenhum convite ainda. Crie o primeiro acima e coloque o link na bio.</Empty>
        )}
        {(invites ?? []).map((i) => {
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
                  <LoadingButton variant="btn-ghost" busy={busy === i.id} onClick={() => toggle(i)}>
                    {i.active ? "Pausar" : "Ativar"}
                  </LoadingButton>
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
