"use client";

import type { TeamContact } from "@ofertas/contracts";
import { Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ErrorText } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

const fmtPhone = (p: string) =>
  `+${p.slice(0, 2)} ${p.slice(2, 4)} ${p.slice(4, -4)}-${p.slice(-4)}`;

/** Telefones da equipe: os únicos que a plataforma adiciona a grupos. */
export function TeamPanel() {
  const [team, setTeam] = useState<TeamContact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setTeam(await api<TeamContact[]>("/team-contacts")), []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await api("/team-contacts", {
        method: "POST",
        body: { phone: f.get("phone"), label: f.get("label") },
      });
      form.reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao salvar.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: TeamContact) {
    if (!confirm(`Tirar ${t.label} (${fmtPhone(t.phone)}) da equipe?`)) return;
    setError(null);
    try {
      await api(`/team-contacts/${t.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao remover.");
    }
  }

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-medium">Números da equipe</h2>
        <p className="text-sm text-neutral-500">
          Dono, número reserva e moderadores. Só eles podem ser adicionados a grupos pela plataforma
          (ao criar grupo ou em Participantes). Adicionar clientes sem consentimento é spam e leva a
          banimento.
        </p>
      </div>
      {team.length > 0 && (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
          {team.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-medium">{t.label}</span>{" "}
                <span className="text-neutral-500 tabular-nums">{fmtPhone(t.phone)}</span>
              </span>
              <button
                type="button"
                className="rounded p-1 text-neutral-500 hover:text-red-600"
                aria-label={`Remover ${t.label}`}
                onClick={() => remove(t)}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input className="input" name="label" placeholder="Quem é (ex.: Número reserva)" required />
        <input className="input" name="phone" placeholder="5511999998888" required />
        <button className="btn inline-flex items-center gap-1.5" type="submit" disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Adicionar
        </button>
      </form>
      <ErrorText error={error} />
    </section>
  );
}

/** Entrar num grupo existente pelo link de convite. */
export function JoinPanel({
  accountId,
  onClose,
  onDone,
}: {
  accountId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const invite = String(new FormData(e.currentTarget).get("invite") ?? "");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{
        result?: { status: "joined" | "pending"; channels: { name: string }[] };
      }>(`/whatsapp/accounts/${accountId}/join`, {
        method: "POST",
        body: { invite_url: invite },
      });
      const r = res.result;
      onDone(
        r?.status === "joined"
          ? `Entrou em ${r.channels.map((c) => `"${c.name}"`).join(", ")}. O grupo já está em Grupos.`
          : "Pedido enviado. Se o grupo exige aprovação, um admin precisa aceitar; depois use Importar grupos.",
      );
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao entrar.");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <h3 className="font-medium">Entrar em grupo por link</h3>
      <p className="text-sm text-neutral-500">
        O número entra no grupo e ele é importado. Útil para grupos de parceiros.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          className="input min-w-64 flex-1"
          name="invite"
          placeholder="https://chat.whatsapp.com/..."
          required
        />
        <button className="btn inline-flex items-center gap-1.5" type="submit" disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? "Entrando…" : "Entrar"}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
