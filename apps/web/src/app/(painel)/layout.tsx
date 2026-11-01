"use client";

import type { Me, SystemStatus } from "@ofertas/contracts";
import {
  Bell,
  Bot,
  ChartColumn,
  FileClock,
  Handshake,
  Images,
  LayoutDashboard,
  Link2,
  LogOut,
  type LucideIcon,
  Megaphone,
  Menu,
  MessageCircle,
  Moon,
  Plus,
  Send,
  Settings,
  Sun,
  Ticket,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV: { section: string | null; items: NavItem[] }[] = [
  {
    section: null,
    items: [
      { href: "/", label: "Visão geral", icon: LayoutDashboard },
      { href: "/metricas", label: "Métricas", icon: ChartColumn },
    ],
  },
  {
    section: "Operação",
    items: [
      { href: "/ofertas", label: "Ofertas", icon: Megaphone },
      { href: "/publicacoes", label: "Publicações", icon: Send },
      { href: "/criativos", label: "Criativos", icon: Images },
    ],
  },
  {
    section: "Canais",
    items: [
      { href: "/grupos", label: "Grupos", icon: Users },
      { href: "/convites", label: "Convites", icon: Ticket },
      { href: "/links", label: "Links rastreados", icon: Link2 },
      { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
    ],
  },
  {
    section: "Conta",
    items: [
      { href: "/afiliados", label: "Afiliados", icon: Handshake },
      { href: "/agentes", label: "Agentes de IA", icon: Bot },
      { href: "/preferencias", label: "Preferências", icon: Settings },
      { href: "/auditoria", label: "Auditoria", icon: FileClock },
    ],
  },
];

function Wordmark() {
  return (
    <span className="text-lg font-bold tracking-[-0.03em]">
      Of<span className="text-brand-500 dark:text-brand-400">Zap</span>
    </span>
  );
}

const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("oh-theme", next);
    } catch {
      // sem armazenamento: vale só nesta visita
    }
    setTheme(next);
  };
  return { theme, toggle };
}

function Sidebar({
  me,
  pathname,
  status,
  onNavigate,
}: {
  me: Me;
  pathname: string;
  status: SystemStatus | null;
  onNavigate: () => void;
}) {
  const healthy = status?.ok ?? true;
  return (
    <aside className="flex h-full w-60 flex-col gap-5 border-r border-neutral-200 bg-neutral-50 px-3 py-4 dark:border-neutral-800 dark:bg-[var(--surface-sunken)]">
      <div className="px-2.5 py-1">
        <Wordmark />
      </div>
      <div className="flex items-center gap-2.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="inline-flex size-6 items-center justify-center rounded-md bg-brand-100 text-[11px] font-bold text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
          {initials(me.workspace.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{me.workspace.name}</span>
          <span className="block text-xs text-neutral-500">
            {{ owner: "Dono", admin: "Admin", operator: "Operador", viewer: "Leitura" }[me.role] ??
              me.role}
          </span>
        </span>
      </div>
      <nav className="-mx-1 flex flex-1 flex-col gap-4 overflow-y-auto px-1">
        {NAV.map((group) => (
          <div key={group.section ?? "main"} className="flex flex-col gap-0.5">
            {group.section ? <span className="eyebrow px-2.5 pb-1">{group.section}</span> : null}
            {group.items.map((n) => {
              const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={onNavigate}
                  className={`flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors ${
                    active
                      ? "bg-white font-semibold text-neutral-900 shadow-[var(--shadow-xs)] outline outline-1 outline-neutral-200 dark:bg-neutral-900 dark:text-neutral-50 dark:outline-neutral-800"
                      : "font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  }`}
                >
                  <Icon
                    size={16}
                    strokeWidth={1.75}
                    className={active ? "text-brand-500 dark:text-brand-400" : ""}
                  />
                  {n.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <Link
        href="/"
        onClick={onNavigate}
        className="rounded-xl border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900"
      >
        <span className="flex items-center gap-2 font-medium">
          <span className={`size-2 rounded-full ${healthy ? "bg-emerald-500" : "bg-red-500"}`} />
          {status === null
            ? "Verificando operação…"
            : healthy
              ? "Operação normal"
              : "Operação com problema"}
        </span>
        {status ? (
          <span className="mt-1 block text-neutral-500">
            {status.queue.scheduled} na fila · {status.worker.ok ? "worker ativo" : "worker parado"}
          </span>
        ) : null}
      </Link>
    </aside>
  );
}

export default function PainelLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    api<Me>("/auth/me")
      .then(setMe)
      .catch(() => router.replace("/login"));
  }, [router]);

  useEffect(() => {
    if (!me) return;
    const load = () =>
      api<SystemStatus>("/system/status")
        .then(setStatus)
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [me]);

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
  }

  if (!me) return <div className="p-8 text-sm text-neutral-500">Carregando…</div>;
  const alertCount = status?.alerts.length ?? 0;

  return (
    <div className="flex min-h-screen">
      <div className="sticky top-0 hidden h-screen shrink-0 md:block">
        <Sidebar me={me} pathname={pathname} status={status} onNavigate={() => {}} />
      </div>
      {drawer ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Fechar menu"
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawer(false)}
          />
          <div className="relative h-full w-60">
            <Sidebar
              me={me}
              pathname={pathname}
              status={status}
              onNavigate={() => setDrawer(false)}
            />
          </div>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-neutral-200 bg-white px-4 md:px-6 dark:border-neutral-800 dark:bg-neutral-900">
          <button
            type="button"
            className="icon-btn md:hidden"
            aria-label="Abrir menu"
            onClick={() => setDrawer(true)}
          >
            {drawer ? <X size={18} /> : <Menu size={18} />}
          </button>
          <span className="md:hidden">
            <Wordmark />
          </span>
          <div className="flex-1" />
          <button
            type="button"
            className="icon-btn"
            aria-label="Alternar tema"
            title="Alternar tema"
            onClick={toggle}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <Link
            href="/"
            className="icon-btn relative"
            aria-label="Alertas"
            title={alertCount ? `${alertCount} alerta(s) aberto(s)` : "Sem alertas"}
          >
            <Bell size={16} />
            {alertCount ? (
              <span className="absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-4 font-semibold text-white">
                {alertCount}
              </span>
            ) : null}
          </Link>
          <Link href="/ofertas" className="btn-accent !min-h-7 !px-2.5 !text-[13px]">
            <Plus size={14} />
            <span className="hidden sm:inline">Nova oferta</span>
          </Link>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenu((v) => !v)}
              className="inline-flex size-[30px] items-center justify-center rounded-full bg-neutral-800 text-xs font-semibold text-white dark:bg-neutral-700"
              aria-label="Conta"
            >
              {initials(me.user.name || me.user.email)}
            </button>
            {menu ? (
              <div className="absolute right-0 mt-2 w-60 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-[var(--shadow-lg)] dark:border-neutral-800 dark:bg-neutral-900">
                <div className="px-2.5 py-2">
                  <div className="truncate text-sm font-medium">{me.user.name}</div>
                  <div className="truncate text-xs text-neutral-500">{me.user.email}</div>
                </div>
                <button
                  type="button"
                  onClick={logout}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  <LogOut size={14} /> Sair
                </button>
              </div>
            ) : null}
          </div>
        </header>
        <main className="mx-auto max-w-[1280px] px-4 pt-7 pb-12 md:px-6">{children}</main>
      </div>
    </div>
  );
}
