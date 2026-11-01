"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

export function CopyButton({ value, label = "Copiar" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copiado" : label}
    </button>
  );
}

export type Tone = "neutral" | "accent" | "positive" | "negative" | "warning" | "info";

const TONES: Record<Tone, { box: string; dot: string }> = {
  neutral: {
    box: "bg-neutral-50 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
    dot: "bg-neutral-400",
  },
  accent: {
    box: "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300",
    dot: "bg-brand-500",
  },
  positive: {
    box: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  negative: {
    box: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-400",
    dot: "bg-red-500",
  },
  warning: {
    box: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  info: {
    box: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    dot: "bg-sky-500",
  },
};

/** Etiqueta (pill) com tom semântico. */
export function Tag({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap tabular-nums ${t.box}`}
    >
      {dot ? <span className={`size-1.5 rounded-full ${t.dot}`} /> : null}
      {children}
    </span>
  );
}

export function Badge({
  on,
  onLabel,
  offLabel,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <Tag tone={on ? "positive" : "neutral"} dot>
      {on ? onLabel : offLabel}
    </Tag>
  );
}

const PLATFORMS: Record<string, { label: string; color: string }> = {
  whatsapp: { label: "WhatsApp", color: "var(--channel-whatsapp)" },
  telegram: { label: "Telegram", color: "var(--channel-telegram)" },
  shopee: { label: "Shopee", color: "var(--platform-shopee)" },
  amazon: { label: "Amazon", color: "var(--platform-amazon)" },
  mercadolivre: { label: "Mercado Livre", color: "var(--platform-mercadolivre)" },
  magalu: { label: "Magalu", color: "var(--platform-magalu)" },
};

/** Origem (canal ou loja): quadradinho de cor + nome. Cores de marca só aqui. */
export function PlatformBadge({
  platform,
  showLabel = true,
}: {
  platform: string;
  showLabel?: boolean;
}) {
  const p = PLATFORMS[platform] ?? { label: platform, color: "var(--text-tertiary)" };
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap text-neutral-600 dark:text-neutral-400">
      <span
        title={p.label}
        className="size-2 shrink-0 rounded-[2px]"
        style={{ background: p.color }}
      />
      {showLabel ? p.label : null}
    </span>
  );
}

/** Cabeçalho de página: título, subtítulo e ações à direita. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 flex-[1_1_320px]">
        <h1 className="text-2xl leading-8 font-semibold tracking-[-0.015em]">{title}</h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Card com cabeçalho (título, subtítulo, ações). padding=false para tabelas de borda a borda. */
export function Panel({
  title,
  subtitle,
  actions,
  padding = true,
  className = "",
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  padding?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`card flex flex-col !p-0 ${className}`}>
      {title || actions ? (
        <header
          className={`flex items-start justify-between gap-3 px-5 pt-5 ${padding ? "" : "pb-4"}`}
        >
          <div className="min-w-0 flex-1">
            {title ? <h2 className="text-[15px] leading-[22px] font-semibold">{title}</h2> : null}
            {subtitle ? (
              <p className="mt-0.5 text-[13px] leading-[18px] text-neutral-500">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`min-w-0 flex-1 ${padding ? "p-5" : "overflow-x-auto"}`}>{children}</div>
    </section>
  );
}

/** Variação percentual: seta + valor, verde/vermelho. */
export function Delta({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <span className="text-xs text-neutral-400">sem base</span>;
  const good = invert ? value < 0 : value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${
        good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }`}
    >
      {value >= 0 ? "↗" : "↘"} {Math.abs(value).toLocaleString("pt-BR")}%
    </span>
  );
}

/** KPI: rótulo, número grande, variação e dica. */
export function StatCard({
  label,
  value,
  delta,
  hint,
}: {
  label: string;
  value: number | string;
  delta?: number | null;
  hint?: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col gap-2.5 !p-4">
      <span className="text-[13px] leading-[18px] font-medium text-neutral-600 dark:text-neutral-400">
        {label}
      </span>
      <span className="text-2xl leading-[30px] font-semibold tracking-[-0.015em] whitespace-nowrap tabular-nums">
        {typeof value === "number" ? value.toLocaleString("pt-BR") : value}
      </span>
      {delta !== undefined || hint ? (
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
          {delta !== undefined ? <Delta value={delta} /> : null}
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Controle segmentado (ex.: período). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="tablist"
      className="inline-flex h-9 gap-0.5 rounded-lg border border-neutral-100 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-900"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
            o.value === value
              ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-50"
              : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Estado vazio de lista. */
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
      {children}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
      {error}
    </p>
  ) : null;
}

export function Stat({ label, value }: { label: string; value: number | string }) {
  return <StatCard label={label} value={value} />;
}

/** Botão de escolha em formato de pílula (seleção única ou múltipla). */
export function Chip({
  on,
  onClick,
  children,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors disabled:opacity-40 ${
        on
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
          : "border-neutral-300 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
      }`}
    >
      {on && <Check className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

/** Opções lado a lado com título e explicação (substitui <select> com textos longos). */
export function ChoiceCards<T extends string>({
  options,
  value,
  onChange,
  columns = 3,
}: {
  options: readonly { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  columns?: 2 | 3 | 4;
}) {
  const cols = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" }[
    columns
  ];
  return (
    <div className={`grid gap-2 ${cols}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`rounded-lg border p-3 text-left transition-colors ${
              on
                ? "border-brand-500 bg-brand-50/60 dark:bg-brand-500/10"
                : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
            }`}
          >
            <span className="block text-sm font-medium">{o.label}</span>
            {o.hint && <span className="block text-xs text-neutral-500">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Botão que mostra "carregando" e fica desativado enquanto a ação roda. */
export function LoadingButton({
  busy,
  children,
  variant = "btn",
  type = "button",
  disabled,
  onClick,
  className = "",
}: {
  busy: boolean;
  children: React.ReactNode;
  variant?: "btn" | "btn-ghost" | "btn-accent";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`${variant} inline-flex items-center justify-center gap-1.5 ${className}`}
      disabled={busy || disabled}
      onClick={onClick}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

/** Indicador de carregamento de página ou seção. */
export function Loading({ label = "Carregando…" }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-neutral-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </p>
  );
}

/**
 * Campo curto que aparece no lugar de um prompt() do navegador: digita, Enter salva, Esc cancela.
 */
export function InlineInput({
  label,
  placeholder,
  initial = "",
  submitLabel = "Salvar",
  maxLength,
  required = true,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  maxLength?: number;
  required?: boolean;
  onSubmit: (value: string) => Promise<unknown> | unknown;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit(value.trim());
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="text-sm text-neutral-600 dark:text-neutral-400">
        {label}
        <input
          className="input mt-1 min-w-64"
          // biome-ignore lint/a11y/noAutofocus: campo aberto por ação do usuário
          autoFocus
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          required={required}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
        />
      </label>
      <div className="flex gap-2 self-end">
        <LoadingButton busy={busy} type="submit">
          {submitLabel}
        </LoadingButton>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

/**
 * Ação destrutiva com confirmação na própria tela: o primeiro clique mostra o aviso e os
 * botões Confirmar/Cancelar (sem janela do navegador).
 */
export function ConfirmButton({
  children,
  message,
  confirmLabel = "Remover",
  onConfirm,
  busy = false,
  className = "",
}: {
  children: React.ReactNode;
  message: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={`btn-ghost ${className}`} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span
      role="alertdialog"
      className="inline-flex flex-wrap items-center gap-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-left text-sm text-red-800 dark:bg-red-500/15 dark:text-red-200"
    >
      <span className="max-w-xs">{message}</span>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-60"
        disabled={busy}
        onClick={async () => {
          await onConfirm();
          setAsking(false);
        }}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {confirmLabel}
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 hover:bg-red-100 dark:hover:bg-red-500/20"
        disabled={busy}
        onClick={() => setAsking(false)}
      >
        Cancelar
      </button>
    </span>
  );
}
