"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

/**
 * Aba guardada no endereço (/ofertas/aprovadas): atualizar a página ou voltar no navegador
 * mantém a aba. `base` é a rota da página; sem aba no endereço, vale `fallback`.
 */
export function useRouteTab<T extends string>(base: string, tabs: readonly T[], fallback: T) {
  const pathname = usePathname();
  const router = useRouter();
  const seg = pathname.slice(base.length).split("/")[1] ?? "";
  const tab = (tabs as readonly string[]).includes(seg) ? (seg as T) : fallback;
  const setTab = useCallback(
    (t: T, query?: string) =>
      router.push(`${base}/${t}${query ? `?${query}` : ""}`, { scroll: false }),
    [router, base],
  );
  return [tab, setTab] as const;
}

/** Barra de abas com links de verdade (abre em nova aba com o botão do meio). */
export function TabBar<T extends string>({
  base,
  tabs,
  active,
}: {
  base: string;
  tabs: { key: T; label: string }[];
  active: T;
}) {
  return (
    <nav className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-neutral-200 [scrollbar-width:none] dark:border-neutral-800 [&::-webkit-scrollbar]:hidden">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={`${base}/${t.key}`}
          scroll={false}
          aria-current={active === t.key ? "page" : undefined}
          className={`border-b-2 px-4 py-2.5 text-base whitespace-nowrap transition-colors ${
            active === t.key
              ? "border-brand-500 font-medium text-neutral-900 dark:text-neutral-50"
              : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
