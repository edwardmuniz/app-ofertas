"use client";

import type { PublicImage, UploadTicket } from "@ofertas/contracts";
import { ImageUp, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";

const ACCEPT = ["image/png", "image/jpeg", "image/webp"];
const MAX_MB = 10;

/** Envia uma imagem do computador e devolve o endereço público e permanente dela. */
export async function uploadImage(file: File): Promise<string> {
  if (!ACCEPT.includes(file.type)) throw new Error("Use uma imagem PNG, JPEG ou WebP.");
  if (file.size > MAX_MB * 1024 * 1024) throw new Error(`A imagem pode ter até ${MAX_MB} MB.`);
  const t = await api<{ result?: UploadTicket }>("/creatives/uploads", {
    method: "POST",
    body: { filename: file.name, mime: file.type, size_bytes: file.size },
  });
  if (!t.result) throw new Error("Sem link de upload.");
  // O PUT passa pelo proxy do painel (mesmo domínio).
  const u = new URL(t.result.put_url);
  const res = await fetch(`/api${u.pathname}${u.search}`, {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file,
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const pub = await api<{ result?: PublicImage }>(
    `/creatives/uploads/${t.result.upload_id}/publish`,
    { method: "POST" },
  );
  if (!pub.result) throw new Error("Não foi possível publicar a imagem.");
  return pub.result.url;
}

/**
 * Campo de imagem: enviar do computador (com prévia) ou colar um endereço.
 * Com `name`, inclui um campo escondido para formulários lidos com FormData.
 */
export function ImageField({
  label,
  value,
  onChange,
  name,
  hint,
  shape = "square",
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  name?: string;
  hint?: string;
  shape?: "square" | "wide";
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadImage(file));
      setBroken(false);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} ${err.hint ?? ""}`
          : err instanceof Error
            ? err.message
            : "Erro ao enviar.",
      );
    } finally {
      setBusy(false);
    }
  }

  const box = shape === "wide" ? "h-16 w-40" : "h-16 w-16";
  return (
    <div className="space-y-1.5">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {name && <input type="hidden" name={name} value={value} />}
      <div className="flex items-center gap-3">
        <div
          className={`${box} flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900`}
        >
          {value && !broken ? (
            // biome-ignore lint/performance/noImgElement: prévia de imagem externa ou enviada
            <img
              src={value}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setBroken(true)}
            />
          ) : (
            <ImageUp className="h-5 w-5 text-neutral-400" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn inline-flex items-center gap-1.5"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <ImageUp className="h-4 w-4" />
            {busy ? "Enviando…" : value ? "Trocar imagem" : "Enviar imagem"}
          </button>
          {value && (
            <button
              type="button"
              className="btn-ghost inline-flex items-center gap-1 px-2 text-sm"
              disabled={busy}
              onClick={() => {
                onChange("");
                setBroken(false);
              }}
            >
              <X className="h-4 w-4" /> Remover
            </button>
          )}
          <input
            ref={input}
            type="file"
            accept={ACCEPT.join(",")}
            className="hidden"
            aria-label={`${label}: escolher arquivo`}
            onChange={pick}
          />
        </div>
      </div>
      <input
        className="input"
        id={id}
        type="url"
        value={value}
        placeholder="ou cole o endereço de uma imagem (https://…)"
        onChange={(e) => {
          onChange(e.target.value);
          setBroken(false);
        }}
      />
      {broken && value && (
        <p className="text-xs text-amber-600">
          Não consegui abrir essa imagem. Confira o endereço.
        </p>
      )}
      {hint && !error && <p className="text-xs text-neutral-500">{hint}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
