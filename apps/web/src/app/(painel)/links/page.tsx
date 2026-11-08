"use client";

import type { Channel, LinkStats, TrackedLink } from "@ofertas/contracts";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Badge,
  Chip,
  CopyButton,
  Empty,
  ErrorText,
  Field,
  InlineInput,
  Loading,
  LoadingButton,
  PageHeader,
  Stat,
} from "@/components/ui";
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

const sourceLabel = (v: string | null) =>
  v ? (SOURCES.find((s) => s.value === v)?.label ?? v) : "—";

export default function LinksPage() {
  const [links, setLinks] = useState<TrackedLink[] | null>(null);
  const [source, setSource] = useState("wa");
  const [more, setMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<TrackedLink | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [totals, setTotals] = useState<LinkStats["totals"] | null>(null);
  const [clicksByLink, setClicksByLink] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Busca só depois de parar de digitar (cada busca faz 4 chamadas).
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50" });
    if (query) params.set("q", query);
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
  }, [query]);
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
      const res = await api<{ result?: TrackedLink }>("/links", {
        method: "POST",
        body: {
          destination_url: f.get("destination_url"),
          title: opt("title"),
          source,
          campaign: opt("campaign"),
          channel_id: opt("channel_id"),
          slug: opt("slug"),
        },
      });
      if (res.result) {
        setCreated(res.result);
        form.reset();
      }
    });
    setCreating(false);
  }

  async function changeDestination(l: TrackedLink, url: string) {
    if (!url || url === l.destination_url) {
      setEditing(null);
      return;
    }
    await run(() => api(`/links/${l.id}`, { method: "PATCH", body: { destination_url: url } }));
    setEditing(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Links rastreados"
        subtitle={
          <>
            Todo link divulgado passa pelo seu domínio: assim você mede cliques e troca o destino
            sem quebrar o link.
          </>
        }
      />

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
        <div className="space-y-1.5">
          <div className="label">Onde vai ser divulgado</div>
          <div className="flex flex-wrap gap-2">
            {SOURCES.map((s) => (
              <Chip key={s.value} on={source === s.value} onClick={() => setSource(s.value)}>
                {s.label}
              </Chip>
            ))}
          </div>
        </div>
        {more ? (
          <>
            <Field label="Grupo (opcional)" htmlFor="channel_id">
              <select className="input" id="channel_id" name="channel_id">
                <option value="">Nenhum</option>
                {channels
                  .filter((c) => c.status !== "archived")
                  .map((c) => (
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
              <Field label="Final do link (opcional)" htmlFor="slug">
                <input className="input" id="slug" name="slug" placeholder="gerado sozinho" />
              </Field>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="justify-self-start text-sm text-neutral-500 hover:underline md:col-span-2"
            onClick={() => setMore(true)}
          >
            + Grupo, campanha e final do link
          </button>
        )}
        <div className="space-y-3 md:col-span-2">
          <ErrorText error={error} />
          <LoadingButton busy={creating} type="submit">
            Criar link
          </LoadingButton>
          {created && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-500/10">
              <span>Link criado:</span>
              <code className="font-mono">{created.short_url}</code>
              <CopyButton value={created.short_url} />
            </div>
          )}
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
        {!links ? (
          <Loading />
        ) : links.length === 0 ? (
          <Empty>
            {q ? `Nenhum link com “${q}”.` : "Nenhum link ainda. Crie o primeiro acima."}
          </Empty>
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
                <Fragment key={l.id}>
                  <tr>
                    <td className="py-2">
                      <div>{l.title ?? l.slug}</div>
                      <div className="font-mono text-xs text-neutral-500">{l.short_url}</div>
                      <div className="text-xs text-neutral-400">{fmtDate(l.created_at)}</div>
                    </td>
                    <td
                      className="max-w-56 truncate py-2 text-neutral-500"
                      title={l.destination_url}
                    >
                      {l.destination_url}
                    </td>
                    <td className="py-2">{sourceLabel(l.source)}</td>
                    <td className="py-2 tabular-nums">{clicksByLink[l.id] ?? 0}</td>
                    <td className="py-2">
                      <Badge on={l.active} onLabel="Ativo" offLabel="Inativo" />
                    </td>
                    <td className="space-x-1 py-2 text-right whitespace-nowrap">
                      <CopyButton value={l.short_url} />
                      <button
                        type="button"
                        className="btn-ghost"
                        aria-expanded={editing === l.id}
                        onClick={() => setEditing(editing === l.id ? null : l.id)}
                      >
                        Trocar destino
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
                  {editing === l.id && (
                    <tr>
                      <td colSpan={6} className="pb-3">
                        <InlineInput
                          label="Novo destino (o link curto continua o mesmo)"
                          initial={l.destination_url}
                          submitLabel="Trocar"
                          onSubmit={(url) => changeDestination(l, url)}
                          onCancel={() => setEditing(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
