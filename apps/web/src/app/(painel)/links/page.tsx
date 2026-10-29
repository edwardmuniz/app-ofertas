"use client";

import type { Channel, LinkStats, TrackedLink } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { Badge, CopyButton, ErrorText, Field, Stat } from "@/components/ui";
import { ApiError, api, fmtDate } from "@/lib/api";

const SOURCES = [
  { value: "wa", label: "WhatsApp" },
  { value: "ig", label: "Instagram (post)" },
  { value: "story", label: "Instagram (story)" },
  { value: "bio", label: "Link na bio" },
  { value: "ads", label: "Anúncio" },
  { value: "outro", label: "Outro" },
];

type Page = { items: TrackedLink[]; next_cursor: string | null };

export default function LinksPage() {
  const [links, setLinks] = useState<TrackedLink[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [totals, setTotals] = useState<LinkStats["totals"] | null>(null);
  const [clicksByLink, setClicksByLink] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50" });
    if (q) params.set("q", q);
    const [page, ch, total, byLink] = await Promise.all([
      api<Page>(`/links?${params}`),
      api<Channel[]>("/channels"),
      api<LinkStats>("/stats/clicks?group_by=none"),
      api<LinkStats>("/stats/clicks?group_by=link"),
    ]);
    setLinks(page.items);
    setChannels(ch);
    setTotals(total.totals);
    setClicksByLink(Object.fromEntries(byLink.rows.map((r) => [r.key ?? "", r.human])));
  }, [q]);
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
      api("/links", {
        method: "POST",
        body: {
          destination_url: f.get("destination_url"),
          title: opt("title"),
          source: opt("source"),
          campaign: opt("campaign"),
          channel_id: opt("channel_id"),
          slug: opt("slug"),
        },
      }),
    );
    form.reset();
  }

  function changeDestination(l: TrackedLink) {
    const url = prompt("Novo destino (o link curto continua o mesmo):", l.destination_url);
    if (!url || url === l.destination_url) return;
    run(() => api(`/links/${l.id}`, { method: "PATCH", body: { destination_url: url } }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Links rastreados</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Todo link divulgado passa pelo seu domínio: assim você mede cliques e troca o destino sem
          quebrar o link.
        </p>
      </div>

      {totals && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Cliques (7 dias)" value={totals.human} />
          <Stat label="Pessoas únicas" value={totals.unique} />
          <Stat label="Robôs/prévias" value={totals.bot} />
        </div>
      )}

      <form onSubmit={create} className="card grid gap-4 md:grid-cols-2">
        <h2 className="font-medium md:col-span-2">Novo link</h2>
        <div className="md:col-span-2">
          <Field label="Destino (link de afiliado)" htmlFor="destination_url">
            <input
              className="input"
              id="destination_url"
              name="destination_url"
              type="url"
              required
              placeholder="https://..."
            />
          </Field>
        </div>
        <Field label="Título" htmlFor="title">
          <input className="input" id="title" name="title" placeholder="Ex.: Air fryer 40% OFF" />
        </Field>
        <Field label="Onde vai ser divulgado" htmlFor="source">
          <select className="input" id="source" name="source" defaultValue="wa">
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Grupo (opcional)" htmlFor="channel_id">
          <select className="input" id="channel_id" name="channel_id">
            <option value="">—</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Campanha" htmlFor="campaign">
            <input className="input" id="campaign" name="campaign" placeholder="black-friday" />
          </Field>
          <Field label="Slug (opcional)" htmlFor="slug">
            <input className="input" id="slug" name="slug" placeholder="gerado" />
          </Field>
        </div>
        <div className="md:col-span-2">
          <ErrorText error={error} />
          <button className="btn mt-2" type="submit">
            Criar link
          </button>
        </div>
      </form>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Links</h2>
          <input
            className="input w-56"
            placeholder="Buscar título ou slug"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {links.length === 0 ? (
          <p className="text-sm text-neutral-500">Nenhum link ainda.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 font-normal">Link</th>
                <th className="py-2 font-normal">Destino</th>
                <th className="py-2 font-normal">Origem</th>
                <th className="py-2 font-normal">Cliques 7d</th>
                <th className="py-2 font-normal">Status</th>
                <th className="py-2 font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {links.map((l) => (
                <tr key={l.id}>
                  <td className="py-2">
                    <div>{l.title ?? l.slug}</div>
                    <div className="font-mono text-xs text-neutral-500">{l.short_url}</div>
                    <div className="text-xs text-neutral-400">{fmtDate(l.created_at)}</div>
                  </td>
                  <td className="max-w-56 truncate py-2 text-neutral-500" title={l.destination_url}>
                    {l.destination_url}
                  </td>
                  <td className="py-2">{l.source ?? "—"}</td>
                  <td className="py-2 tabular-nums">{clicksByLink[l.id] ?? 0}</td>
                  <td className="py-2">
                    <Badge on={l.active} onLabel="Ativo" offLabel="Inativo" />
                  </td>
                  <td className="space-x-1 py-2 text-right whitespace-nowrap">
                    <CopyButton value={l.short_url} />
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => changeDestination(l)}
                    >
                      Destino
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() =>
                        run(() =>
                          api(`/links/${l.id}`, { method: "PATCH", body: { active: !l.active } }),
                        )
                      }
                    >
                      {l.active ? "Desativar" : "Ativar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
