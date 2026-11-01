"use client";

import type { MessagingAccount, Segment, TeamContact } from "@ofertas/contracts";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorText, Field } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

const fmtPhone = (p: string) =>
  `+${p.slice(0, 2)} ${p.slice(2, 4)} ${p.slice(4, -4)}-${p.slice(-4)}`;

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        on
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
          : "border-neutral-300 dark:border-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}

const toggle = (set: Set<string>, id: string) => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** Cria um grupo (ou comunidade) no WhatsApp já configurado para ofertas. */
export function CreatePanel({
  mode,
  segments,
  onClose,
  onDone,
}: {
  mode: "group" | "community";
  segments: Segment[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [accounts, setAccounts] = useState<MessagingAccount[] | null>(null);
  const [team, setTeam] = useState<TeamContact[]>([]);
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [segIds, setSegIds] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [adminOnly, setAdminOnly] = useState(true);
  const [locked, setLocked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isGroup = mode === "group";

  useEffect(() => {
    Promise.all([
      api<MessagingAccount[]>("/whatsapp/accounts"),
      api<TeamContact[]>("/team-contacts"),
    ])
      .then(([a, t]) => {
        setAccounts(a.filter((x) => x.status === "connected"));
        setTeam(t);
      })
      .catch(() => setAccounts([]));
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const accountId = String(f.get("account_id") ?? "");
    const description = String(f.get("description") ?? "").trim();
    const photo = String(f.get("photo_url") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      if (isGroup) {
        const res = await api<{
          result?: { channel: { name: string }; pending: { step: string; error: string }[] };
        }>(`/whatsapp/accounts/${accountId}/groups`, {
          method: "POST",
          body: {
            name,
            participants: [...people],
            ...(description && { description }),
            ...(photo && { photo_url: photo }),
            segment_ids: [...segIds],
            admin_only: adminOnly,
            locked,
          },
        });
        const pending = res.result?.pending ?? [];
        onDone(
          `Grupo "${res.result?.channel.name}" criado.${
            pending.length
              ? ` Não deu para aplicar: ${pending.map((p) => p.step).join(", ")} — ajuste na página do grupo.`
              : ""
          }`,
        );
      } else {
        await api(`/whatsapp/accounts/${accountId}/communities`, {
          method: "POST",
          body: { name, ...(description && { description }), segment_ids: [...segIds] },
        });
        onDone(`Comunidade "${name}" criada. Abra-a para ligar grupos.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao criar.");
      setBusy(false);
    }
  }

  if (!accounts) {
    return (
      <div className="card flex items-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }
  if (!accounts.length) {
    return (
      <div className="card space-y-2 text-sm">
        <p>
          Nenhum número conectado. Conecte um em{" "}
          <Link className="underline" href="/whatsapp">
            WhatsApp
          </Link>
          .
        </p>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Fechar
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div>
        <h2 className="font-medium">{isGroup ? "Criar grupo no WhatsApp" : "Criar comunidade"}</h2>
        <p className="text-sm text-neutral-500">
          {isGroup
            ? "O grupo é criado pelo número escolhido, já com link de convite e as configurações abaixo."
            : "A comunidade reúne grupos; o grupo de avisos dela alcança os membros de todos."}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Número" htmlFor="account_id">
          <select className="input" id="account_id" name="account_id" required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Nome (${name.length}/25)`} htmlFor="group_name">
          <input
            className="input"
            id="group_name"
            maxLength={25}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isGroup ? "Ofertas Casa #3" : "Ofertas BR"}
          />
        </Field>
        <Field label="Descrição (regras do grupo)" htmlFor="description">
          <textarea className="input min-h-20" id="description" name="description" />
        </Field>
        {isGroup && (
          <Field label="Foto (URL de uma imagem)" htmlFor="photo_url">
            <input
              className="input"
              id="photo_url"
              name="photo_url"
              type="url"
              placeholder="https://..."
            />
          </Field>
        )}
      </div>

      {isGroup && (
        <div className="space-y-1.5">
          <div className="text-sm">
            Participantes da equipe{" "}
            <span className="text-neutral-500">(o WhatsApp exige ao menos 1)</span>
          </div>
          {team.length ? (
            <div className="flex flex-wrap gap-2">
              {team.map((t) => (
                <Chip
                  key={t.id}
                  on={people.has(t.phone)}
                  onClick={() => setPeople((s) => toggle(s, t.phone))}
                >
                  {t.label} · {fmtPhone(t.phone)}
                </Chip>
              ))}
            </div>
          ) : (
            <p className="text-sm text-amber-600">
              Cadastre ao menos um telefone em{" "}
              <Link className="underline" href="/whatsapp">
                WhatsApp → Números da equipe
              </Link>
              .
            </p>
          )}
        </div>
      )}

      {segments.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm">Segmentos</div>
          <div className="flex flex-wrap gap-2">
            {segments.map((s) => (
              <Chip
                key={s.id}
                on={segIds.has(s.id)}
                onClick={() => setSegIds((x) => toggle(x, s.id))}
              >
                {s.name}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {isGroup && (
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={adminOnly}
              onChange={(e) => setAdminOnly(e.target.checked)}
            />
            Só admins enviam mensagens
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
            Só admins editam nome, descrição e foto
          </label>
        </div>
      )}

      <ErrorText error={error} />
      <div className="flex gap-2">
        <button
          type="submit"
          className="btn-accent inline-flex items-center gap-1.5"
          disabled={busy || !name.trim() || (isGroup && people.size === 0)}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? "Criando…" : isGroup ? "Criar grupo" : "Criar comunidade"}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
