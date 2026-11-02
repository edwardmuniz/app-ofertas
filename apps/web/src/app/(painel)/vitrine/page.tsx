"use client";

import type { AudienceStats, InviteLink, Storefront } from "@ofertas/contracts";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ImageField } from "@/components/image-field";
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
  StatCard,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { DesignPanel } from "./design-panel";

type Period = "today" | "7d" | "30d";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`);

export default function VitrinePage() {
  const [sf, setSf] = useState<Storefront | null | undefined>(undefined);
  const [invites, setInvites] = useState<InviteLink[]>([]);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [tagline, setTagline] = useState("");
  const [avatar, setAvatar] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fill = useCallback((s: Storefront | null) => {
    setSf(s);
    if (!s) return;
    setSlug(s.slug);
    setTitle(s.title);
    setTagline(s.tagline ?? "");
    setAvatar(s.avatar_url ?? "");
    setChosen(s.invite_link_ids);
    setActive(s.active);
  }, []);

  useEffect(() => {
    Promise.all([api<Storefront | null>("/storefront"), api<InviteLink[]>("/invite-links")]).then(
      ([s, inv]) => {
        setInvites(inv);
        fill(s);
        // Primeira vez: já marca os convites ativos.
        if (!s) setChosen(inv.filter((i) => i.active).map((i) => i.id));
      },
    );
  }, [fill]);

  // Base pública dos links (a mesma dos convites): https://go.dominio
  const base = sf?.url.replace(/\/@[^/]+$/, "") ?? invites[0]?.url.replace(/\/entrar\/.+$/, "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await api<{ result?: Storefront }>("/storefront", {
        method: "PATCH",
        body: {
          slug: slug.trim().toLowerCase(),
          title: title.trim(),
          tagline: tagline.trim() || null,
          avatar_url: avatar.trim() || null,
          invite_link_ids: chosen,
          active,
        },
      });
      if (res.result) fill(res.result);
      setMsg({ ok: true, text: "Vitrine salva." });
    } catch (err) {
      setMsg({
        ok: false,
        text: err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao salvar.",
      });
    } finally {
      setSaving(false);
    }
  }

  if (sf === undefined) return <Loading />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Vitrine"
        subtitle="Sua página pública com as ofertas do dia e o botão para entrar nos grupos. É o link da bio em todas as redes."
        actions={
          sf?.active ? (
            <a
              className="btn inline-flex items-center gap-1.5"
              href={sf.url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="h-4 w-4" /> Abrir vitrine
            </a>
          ) : null
        }
      />

      {sf && <AudiencePanel />}

      {sf && (
        <Panel
          title="Links para a bio"
          subtitle="Use um link por rede: assim você vê de onde vem cada visita e cada entrada."
        >
          <ul className="space-y-2">
            {sf.source_links.map((l) => (
              <li key={l.source} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-40 shrink-0 text-neutral-500">{l.label}</span>
                <code className="min-w-0 flex-1 truncate">{l.url}</code>
                <CopyButton value={l.url} />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title={sf ? "Configuração" : "Criar a vitrine"}
        subtitle="A vitrine mostra as melhores ofertas aprovadas dos últimos 7 dias, com link direto para a loja."
      >
        <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
          <Field label="Endereço" htmlFor="sf_slug">
            <div className="flex items-center gap-1">
              <span className="shrink-0 text-sm text-neutral-500">{base ? `${base}/@` : "/@"}</span>
              <input
                className="input min-w-0 flex-1"
                id="sf_slug"
                required
                value={slug}
                maxLength={30}
                placeholder="achadinhosdoedu"
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
              />
            </div>
          </Field>
          <Field label="Nome da marca" htmlFor="sf_title">
            <input
              className="input"
              id="sf_title"
              required
              value={title}
              maxLength={60}
              placeholder="Achadinhos do Edu"
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Frase (opcional)" htmlFor="sf_tagline">
              <input
                className="input"
                id="sf_tagline"
                value={tagline}
                maxLength={160}
                placeholder="As melhores ofertas da Amazon, Shopee e Mercado Livre, todo dia."
                onChange={(e) => setTagline(e.target.value)}
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <ImageField
              label="Foto ou logo (opcional)"
              value={avatar}
              onChange={setAvatar}
              hint="Quadrada, de preferência (aparece redonda no topo da vitrine)."
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <div className="label">Botões de entrar no grupo</div>
            {invites.length === 0 ? (
              <p className="text-sm text-neutral-500">
                Crie um convite rotativo em <Link href="/convites">Convites</Link> para aparecer o
                botão de entrar no grupo.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {invites.map((i) => (
                  <Chip
                    key={i.id}
                    on={chosen.includes(i.id)}
                    onClick={() =>
                      setChosen((c) =>
                        c.includes(i.id) ? c.filter((x) => x !== i.id) : [...c, i.id],
                      )
                    }
                  >
                    {i.name}
                  </Chip>
                ))}
              </div>
            )}
            <p className="text-xs text-neutral-500">
              Com mais de um, cada botão mostra o nome do convite (ex.: um por nicho).
            </p>
          </div>
          {sf && (
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Vitrine no ar (desmarque para pausar)
            </label>
          )}
          <div className="flex items-center gap-3 md:col-span-2">
            <LoadingButton busy={saving} type="submit">
              {sf ? "Salvar" : "Criar vitrine"}
            </LoadingButton>
            {msg && (
              <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>
                {msg.text}
              </span>
            )}
          </div>
        </form>
      </Panel>

      {sf && <DesignPanel sf={sf} onSaved={fill} />}
    </div>
  );
}

function AudiencePanel() {
  const [period, setPeriod] = useState<Period>("7d");
  const [stats, setStats] = useState<AudienceStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStats(null);
    api<AudienceStats>(`/audience/stats?period=${period}`)
      .then(setStats)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Erro ao carregar."));
  }, [period]);

  return (
    <Panel
      title="Audiência"
      subtitle="De onde vêm as visitas e os cliques no grupo. O WhatsApp não diz por qual link a pessoa entrou, então as entradas aparecem no total."
      actions={
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { value: "today", label: "Hoje" },
            { value: "7d", label: "7 dias" },
            { value: "30d", label: "30 dias" },
          ]}
        />
      }
    >
      <ErrorText error={error} />
      {!stats ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard label="Visitas na vitrine" value={stats.totals.views} />
            <StatCard label="Cliques no grupo" value={stats.totals.invite_clicks} />
            <StatCard label="Cliques em ofertas" value={stats.totals.offer_clicks} />
            <StatCard
              label="Entradas nos grupos"
              value={stats.totals.joins}
              hint={`${pct(stats.totals.invite_to_join)} dos cliques no grupo`}
            />
            <StatCard
              label="Saldo (entradas − saídas)"
              value={stats.totals.net}
              hint={`${stats.totals.leaves} saídas`}
            />
          </div>
          {stats.sources.length === 0 ? (
            <Empty>
              Ainda sem visitas. Coloque os links da bio nas redes e poste o primeiro conteúdo.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-neutral-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Origem</th>
                    <th className="py-2 pr-3 text-right font-medium">Visitas</th>
                    <th className="py-2 pr-3 text-right font-medium">Cliques no grupo</th>
                    <th className="py-2 pr-3 text-right font-medium">Visita → grupo</th>
                    <th className="py-2 text-right font-medium">Cliques em ofertas</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {stats.sources.map((s) => (
                    <tr
                      key={s.source}
                      className="border-t border-neutral-100 dark:border-neutral-800"
                    >
                      <td className="py-2 pr-3">{s.source}</td>
                      <td className="py-2 pr-3 text-right">{s.views}</td>
                      <td className="py-2 pr-3 text-right">{s.invite_clicks}</td>
                      <td className="py-2 pr-3 text-right">{pct(s.view_to_invite)}</td>
                      <td className="py-2 text-right">{s.offer_clicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
