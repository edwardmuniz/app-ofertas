"use client";

import type { BrandKit } from "@ofertas/contracts";
import { useEffect, useState } from "react";
import { ErrorText, Field, LoadingButton } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

const COLORS = [
  ["primary_color", "Destaque"],
  ["secondary_color", "Fundo"],
  ["text_color", "Texto"],
] as const;

/** Nome, chamada e cores usados nos cards de preço enviados aos grupos e no estúdio. */
export function BrandKitForm() {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<BrandKit>("/brand-kit")
      .then((k) => {
        setKit(k);
        setColors({
          primary_color: k.primary_color,
          secondary_color: k.secondary_color,
          text_color: k.text_color,
        });
      })
      .catch(() => setError("Não foi possível carregar a identidade visual."));
  }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      await api("/brand-kit", {
        method: "PATCH",
        body: { name: f.get("name"), ...colors, cta: f.get("cta") },
      });
      setMsg("Identidade visual salva. Os próximos cards já saem com ela.");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} ${err.hint ?? ""}` : "Erro ao salvar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card grid gap-4 md:grid-cols-2">
      <div className="md:col-span-2">
        <h2 className="font-medium">Identidade visual</h2>
        <p className="text-sm text-neutral-500">
          Usada nos cards de preço enviados aos grupos e passada ao agente que cria os conteúdos.
        </p>
      </div>
      {kit ? (
        <>
          <Field label="Nome da marca" htmlFor="brand_name">
            <input className="input" id="brand_name" name="name" defaultValue={kit.name} />
          </Field>
          <Field label="Chamada do card" htmlFor="brand_cta">
            <input className="input" id="brand_cta" name="cta" defaultValue={kit.cta} />
          </Field>
          <div className="flex flex-wrap gap-4 md:col-span-2">
            {COLORS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  className="h-9 w-12 cursor-pointer rounded-md border border-neutral-300 dark:border-neutral-700"
                  type="color"
                  value={colors[k] ?? "#000000"}
                  onChange={(e) => setColors({ ...colors, [k]: e.target.value })}
                />
                <span>
                  <span className="block">{label}</span>
                  <span className="font-mono text-xs text-neutral-500 uppercase">{colors[k]}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 md:col-span-2">
            <LoadingButton busy={busy} type="submit">
              Salvar identidade
            </LoadingButton>
            {msg && <span className="text-sm text-emerald-600">{msg}</span>}
          </div>
        </>
      ) : null}
      <ErrorText error={error} />
    </form>
  );
}
