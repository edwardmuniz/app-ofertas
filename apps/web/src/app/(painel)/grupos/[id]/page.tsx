"use client";

import type { Channel, GroupDetails, TeamContact } from "@ofertas/contracts";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CopyButton, ErrorText, Field, PageHeader, Segmented, Tag } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

type TabKey = "dados" | "config" | "admins" | "convite" | "comunidade" | "sair";

const errText = (err: unknown) =>
  err instanceof ApiError ? `${err.message} ${err.hint ?? ""}`.trim() : "Erro inesperado.";

const SETTINGS = [
  {
    key: "admin_only",
    label: "Só admins enviam mensagens",
    help: "Recomendado: membros só leem as ofertas (menos spam e menos risco de banimento).",
  },
  {
    key: "locked",
    label: "Só admins editam nome, descrição e foto",
    help: "Recomendado: evita que membros mudem os dados do grupo.",
  },
  {
    key: "approval_required",
    label: "Entrada precisa de aprovação",
    help: "Atenção: os pedidos só podem ser aprovados no celular (a Evolution Go não expõe isso). Deixe desligado para os links de convite funcionarem sozinhos.",
  },
  {
    key: "admins_add_members",
    label: "Só admins adicionam membros",
    help: "Recomendado.",
  },
] as const;

function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button className="btn inline-flex items-center gap-1.5" type="submit" disabled={busy}>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export default function GroupPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [details, setDetails] = useState<GroupDetails | null>(null);
  const [team, setTeam] = useState<TeamContact[]>([]);
  const [groups, setGroups] = useState<Channel[]>([]);
  const [tab, setTab] = useState<TabKey>("dados");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([
        api<GroupDetails>(`/channels/${id}/group`),
        api<TeamContact[]>("/team-contacts"),
      ]);
      setDetails(d);
      setTeam(t);
      if (d.channel.type === "wa_community") setGroups(await api<Channel[]>("/channels"));
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <Link href="/grupos" className="inline-flex items-center gap-1 text-sm text-neutral-500">
          <ArrowLeft className="h-4 w-4" /> Grupos
        </Link>
        <ErrorText error={loadError} />
      </div>
    );
  }
  if (!details) {
    return (
      <p className="flex items-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Lendo o grupo no WhatsApp…
      </p>
    );
  }

  const ch = details.channel;
  const isCommunity = ch.type === "wa_community";
  const notAdmin = ch.number_is_admin === false;
  const tabs: { value: TabKey; label: string }[] = [
    { value: "dados", label: "Dados" },
    { value: "config", label: "Configurações" },
    { value: "admins", label: "Participantes" },
    ...(isCommunity ? [] : [{ value: "convite" as const, label: "Convite" }]),
    { value: "comunidade", label: isCommunity ? "Grupos ligados" : "Comunidade" },
    { value: "sair", label: "Sair" },
  ];

  function saveData(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const description = String(f.get("description") ?? "");
    const photo = String(f.get("photo_url") ?? "").trim();
    const body: Record<string, string> = {};
    if (name && name !== ch.name) body.name = name;
    if (description !== (ch.description ?? "")) body.description = description;
    if (photo) body.photo_url = photo;
    if (!Object.keys(body).length) {
      setMsg("Nada mudou.");
      return;
    }
    run(
      "dados",
      () => api(`/channels/${id}/group`, { method: "PATCH", body }),
      "Dados atualizados no WhatsApp.",
    );
  }

  function setSetting(key: (typeof SETTINGS)[number]["key"], value: boolean) {
    run(
      key,
      () => api(`/channels/${id}/group/settings`, { method: "POST", body: { [key]: value } }),
      "Configuração aplicada.",
    );
  }

  function participants(
    action: "add" | "remove" | "promote" | "demote",
    phone: string,
    label: string,
  ) {
    const verbs = {
      add: "Adicionar",
      remove: "Remover",
      promote: "Tornar admin",
      demote: "Tirar admin de",
    };
    if (!confirm(`${verbs[action]} ${label}?`)) return;
    run(
      `${action}:${phone}`,
      async () => {
        const res = await api<{ result?: { failed: string[] } }>(
          `/channels/${id}/group/participants`,
          {
            method: "POST",
            body: { action, phones: [phone] },
          },
        );
        if (res.result?.failed.length) {
          throw new ApiError(400, {
            error: {
              code: "PROVIDER_ERROR",
              message: "O WhatsApp não confirmou a mudança (relemos o grupo e nada mudou).",
              hint: action === "add" ? "A pessoa pode ter bloqueado convites de grupo." : undefined,
            },
          });
        }
      },
      "Feito.",
    );
  }

  function resetInvite() {
    if (!confirm("Gerar um novo link? O link atual para de funcionar na hora.")) return;
    run(
      "invite",
      () => api(`/channels/${id}/group/invite-reset`, { method: "POST" }),
      "Novo link gerado. Os links de convite inteligentes já usam o novo.",
    );
  }

  async function leave() {
    setError(null);
    try {
      const prev = await api<{
        preview: { only_admin: boolean; scheduled_posts_canceled: number };
      }>(`/channels/${id}/group/leave?dry_run=true`, { method: "POST" });
      const p = prev.preview;
      const text = [
        `Tirar o número de "${ch.name}"?`,
        "Para voltar, ele precisa de um novo convite.",
        p.only_admin
          ? "ATENÇÃO: o número é o único admin. O grupo fica sem quem publique ou administre."
          : null,
        p.scheduled_posts_canceled
          ? `${p.scheduled_posts_canceled} publicação(ões) agendada(s) serão canceladas.`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      if (!confirm(text)) return;
      setBusy("leave");
      await api(`/channels/${id}/group/leave`, { method: "POST" });
      router.push("/grupos");
    } catch (err) {
      setError(errText(err));
      setBusy(null);
    }
  }

  function linkGroups(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const ids = new FormData(e.currentTarget).getAll("group").map(String);
    if (!ids.length) return;
    run(
      "link",
      async () => {
        const res = await api<{ result?: { done: string[]; failed: string[] } }>(
          `/channels/${id}/community/groups`,
          { method: "POST", body: { channel_ids: ids, link: true } },
        );
        if (res.result?.failed.length) {
          throw new ApiError(400, {
            error: {
              code: "PROVIDER_ERROR",
              message: `Não ligou: ${res.result.failed.join(", ")}.`,
            },
          });
        }
      },
      "Grupos ligados à comunidade.",
    );
  }

  function unlink(groupId: string, name: string) {
    if (!confirm(`Desligar "${name}" da comunidade?`)) return;
    run(
      `unlink:${groupId}`,
      () =>
        api(`/channels/${id}/community/groups`, {
          method: "POST",
          body: { channel_ids: [groupId], link: false },
        }),
      "Grupo desligado.",
    );
  }

  const teamNotIn = team.filter((t) => !details.team_in_group.some((m) => m.phone === t.phone));
  const linkable = groups.filter(
    (g) =>
      g.type === "wa_group" &&
      g.messaging_account_id === ch.messaging_account_id &&
      g.community_jid !== ch.external_id &&
      g.status !== "archived",
  );

  return (
    <div className="flex flex-col gap-6">
      <Link href="/grupos" className="inline-flex items-center gap-1 text-sm text-neutral-500">
        <ArrowLeft className="h-4 w-4" /> Grupos
      </Link>
      <PageHeader
        title={ch.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            {isCommunity ? <Tag tone="info">Comunidade</Tag> : <Tag>{ch.member_count} membros</Tag>}
            {notAdmin ? (
              <Tag tone="negative">O número não é admin</Tag>
            ) : (
              <Tag tone="positive">O número é admin</Tag>
            )}
            {ch.provider_state !== "ok" && (
              <Tag tone="negative">
                {ch.provider_state === "deleted" ? "Apagado no WhatsApp" : "Suspenso"}
              </Tag>
            )}
          </span>
        }
      />
      <div className="overflow-x-auto">
        <Segmented options={tabs} value={tab} onChange={setTab} />
      </div>
      <ErrorText error={error} />
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}

      {tab === "dados" && (
        <form onSubmit={saveData} className="card grid gap-4 md:grid-cols-2">
          <Field label="Nome (até 25 caracteres)" htmlFor="name">
            <input
              className="input"
              id="name"
              name="name"
              maxLength={25}
              defaultValue={ch.name}
              key={ch.name}
            />
          </Field>
          <Field label="Nova foto (URL de uma imagem)" htmlFor="photo_url">
            <input
              className="input"
              id="photo_url"
              name="photo_url"
              type="url"
              placeholder="https://..."
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Descrição (vazio limpa)" htmlFor="description">
              <textarea
                className="input min-h-28"
                id="description"
                name="description"
                defaultValue={ch.description ?? ""}
                key={ch.description ?? ""}
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <SubmitButton busy={busy === "dados"}>Salvar no WhatsApp</SubmitButton>
            {ch.locked && notAdmin && (
              <span className="ml-3 text-sm text-amber-600">Só admins editam este grupo.</span>
            )}
          </div>
        </form>
      )}

      {tab === "config" && (
        <section className="card space-y-4">
          {notAdmin && (
            <p className="text-sm text-amber-600">
              O número precisa ser admin para mudar configurações.
            </p>
          )}
          {SETTINGS.map((s) => {
            const value = ch[s.key];
            return (
              <div key={s.key} className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="text-xs text-neutral-500">{s.help}</div>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-sm">
                  {busy === s.key && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <input
                    type="checkbox"
                    checked={value === true}
                    disabled={notAdmin || busy !== null}
                    onChange={(e) => setSetting(s.key, e.target.checked)}
                  />
                  {value === null ? "?" : value ? "Ligado" : "Desligado"}
                </label>
              </div>
            );
          })}
        </section>
      )}

      {tab === "admins" && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="card space-y-3">
            <h2 className="font-medium">Admins</h2>
            <ul className="space-y-1.5 text-sm">
              {details.admins.map((a) => (
                <li key={a.phone} className="flex items-center justify-between gap-2">
                  <span className="tabular-nums">
                    {a.phone} {a.is_self && <Tag tone="accent">este número</Tag>}
                    {a.team_label && <Tag>{a.team_label}</Tag>}
                  </span>
                  {a.team_label && !a.is_self && (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy !== null || notAdmin}
                      onClick={() =>
                        participants("demote", a.phone.replace(/\D/g, ""), a.team_label ?? "")
                      }
                    >
                      Tirar admin
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-xs text-neutral-500">
              Telefones de fora da equipe aparecem mascarados. Tenha o número reserva como admin em
              todos os grupos: se este número cair, ele assume.
            </p>
          </section>
          <section className="card space-y-3">
            <h2 className="font-medium">Equipe</h2>
            {details.team_in_group.length === 0 && teamNotIn.length === 0 && (
              <p className="text-sm text-neutral-500">
                Cadastre telefones em{" "}
                <Link className="underline" href="/whatsapp">
                  WhatsApp → Números da equipe
                </Link>
                .
              </p>
            )}
            <ul className="space-y-1.5 text-sm">
              {details.team_in_group.map((m) => (
                <li key={m.phone} className="flex items-center justify-between gap-2">
                  <span>
                    {m.label} {m.is_admin && <Tag tone="positive">admin</Tag>}
                  </span>
                  <span className="flex gap-1">
                    {!m.is_admin && (
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy !== null || notAdmin}
                        onClick={() => participants("promote", m.phone, m.label)}
                      >
                        Tornar admin
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy !== null || notAdmin}
                      onClick={() => participants("remove", m.phone, m.label)}
                    >
                      Remover
                    </button>
                  </span>
                </li>
              ))}
              {teamNotIn.map((t) => (
                <li key={t.phone} className="flex items-center justify-between gap-2">
                  <span className="text-neutral-500">{t.label} (fora do grupo)</span>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy !== null || notAdmin}
                    onClick={() => participants("add", t.phone, t.label)}
                  >
                    Adicionar
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-neutral-500">
              Só números da equipe entram por aqui (até 20 por dia por número). Membros entram pelo
              link de convite.
            </p>
          </section>
        </div>
      )}

      {tab === "convite" && (
        <section className="card space-y-3">
          <h2 className="font-medium">Link de convite</h2>
          {ch.invite_url ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <code className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">
                {ch.invite_url}
              </code>
              <CopyButton value={ch.invite_url} />
            </div>
          ) : (
            <p className="text-sm text-amber-600">Sem link (o número precisa ser admin).</p>
          )}
          <p className="text-sm text-neutral-500">
            Gere um novo se o link vazou para grupos de spam. O atual para de funcionar na hora.
          </p>
          <button
            type="button"
            className="btn inline-flex items-center gap-1.5"
            disabled={busy !== null || notAdmin}
            onClick={resetInvite}
          >
            {busy === "invite" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Gerar novo link
          </button>
        </section>
      )}

      {tab === "comunidade" && !isCommunity && (
        <section className="card space-y-2 text-sm">
          <h2 className="font-medium">Comunidade</h2>
          {details.community ? (
            <p>
              Ligado a{" "}
              {details.community.id ? (
                <Link className="underline" href={`/grupos/${details.community.id}`}>
                  {details.community.name}
                </Link>
              ) : (
                "uma comunidade que não está na plataforma"
              )}
              .
            </p>
          ) : (
            <p className="text-neutral-500">
              Não está em nenhuma comunidade. Para ligar, abra a comunidade em Grupos.
            </p>
          )}
        </section>
      )}

      {tab === "comunidade" && isCommunity && (
        <section className="card space-y-4">
          <div>
            <h2 className="font-medium">Grupos ligados</h2>
            {details.linked_groups.length === 0 ? (
              <p className="text-sm text-neutral-500">Nenhum grupo ligado ainda.</p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm">
                {details.linked_groups.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2">
                    <Link className="hover:underline" href={`/grupos/${g.id}`}>
                      {g.name}
                    </Link>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy !== null}
                      onClick={() => unlink(g.id, g.name)}
                    >
                      Desligar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {linkable.length > 0 && (
            <form onSubmit={linkGroups} className="space-y-2">
              <div className="text-sm">Ligar grupos do mesmo número</div>
              <div className="flex flex-wrap gap-3 text-sm">
                {linkable.map((g) => (
                  <label key={g.id} className="flex items-center gap-1.5">
                    <input type="checkbox" name="group" value={g.id} /> {g.name}
                  </label>
                ))}
              </div>
              <SubmitButton busy={busy === "link"}>Ligar à comunidade</SubmitButton>
            </form>
          )}
        </section>
      )}

      {tab === "sair" && (
        <section className="card space-y-3">
          <h2 className="font-medium">
            Tirar o número {isCommunity ? "da comunidade" : "do grupo"}
          </h2>
          <p className="text-sm text-neutral-500">
            O grupo continua no WhatsApp, mas o número sai e o grupo é removido da plataforma. Para
            voltar, o número precisa de um novo convite. Se só quer parar de publicar, use Pausar ou
            Remover na lista de grupos.
          </p>
          <button
            type="button"
            className="btn-ghost inline-flex items-center gap-1.5 text-red-600"
            disabled={busy !== null}
            onClick={leave}
          >
            {busy === "leave" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sair {isCommunity ? "da comunidade" : "do grupo"}
          </button>
        </section>
      )}
    </div>
  );
}
