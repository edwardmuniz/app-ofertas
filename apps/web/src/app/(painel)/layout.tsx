"use client";

import type { Me } from "@ofertas/contracts";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const NAV = [
  { href: "/", label: "Visão geral" },
  { href: "/metricas", label: "Métricas" },
  { href: "/ofertas", label: "Ofertas" },
  { href: "/publicacoes", label: "Publicações" },
  { href: "/criativos", label: "Criativos" },
  { href: "/grupos", label: "Grupos" },
  { href: "/links", label: "Links" },
  { href: "/convites", label: "Convites" },
  { href: "/whatsapp", label: "WhatsApp" },
  { href: "/afiliados", label: "Afiliados" },
  { href: "/agentes", label: "Conectar agente" },
  { href: "/preferencias", label: "Preferências" },
  { href: "/auditoria", label: "Auditoria" },
];

export default function PainelLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api<Me>("/auth/me")
      .then(setMe)
      .catch(() => router.replace("/login"));
  }, [router]);

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
  }

  if (!me) return <div className="p-8 text-sm text-neutral-500">Carregando…</div>;

  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-neutral-200 p-4 md:w-56 md:border-r md:border-b-0 dark:border-neutral-800">
        <div className="mb-4 font-semibold">{me.workspace.name}</div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-lg px-3 py-2 text-sm whitespace-nowrap ${
                pathname === n.href
                  ? "bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-6 hidden text-xs text-neutral-500 md:block">
          {me.user.email}
          <button type="button" onClick={logout} className="mt-2 block hover:underline">
            Sair
          </button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8">
        <div className="mx-auto max-w-4xl">{children}</div>
      </main>
    </div>
  );
}
