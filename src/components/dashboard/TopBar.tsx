"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/Logo";
import { TeamSwitcher } from "@/components/TeamSwitcher";

interface TeamOption {
  id: number;
  name: string;
  role: string;
  member_count: number;
}

const TABS: { label: string; href?: string; soon?: boolean }[] = [
  { label: "Мониторы", href: "/dashboard" },
  { label: "Инциденты", href: "/dashboard/incidents" },
  { label: "Узлы", soon: true },
  { label: "Оповещения", soon: true },
  { label: "Проверки", soon: true },
  { label: "Отчёты", soon: true },
];

export function TopBar({
  email,
  teams,
  activeTeamId,
}: {
  email: string;
  teams: TeamOption[];
  activeTeamId: number;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const initials = email.slice(0, 2).toUpperCase();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.push("/login");
    router.refresh();
  }

  function tabActive(href?: string) {
    if (!href) return false;
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  }

  return (
    <header className="sticky top-0 z-30 border-b border-ink-700/70 bg-ink-900/80 backdrop-blur">
      <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <div className="lg:hidden">
            <Logo />
          </div>
          <nav className="hidden items-center gap-1 md:flex">
            {TABS.map((t) => {
              const active = tabActive(t.href);
              const cls = `relative px-3 py-2 text-sm font-medium transition ${
                active
                  ? "text-white"
                  : t.soon
                    ? "cursor-default text-slate-600"
                    : "text-slate-400 hover:text-white"
              }`;
              const content = (
                <>
                  {active && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-400 align-middle" />}
                  {t.label}
                  {active && (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-brand-500" />
                  )}
                </>
              );
              return t.soon ? (
                <span key={t.label} className={cls} title="Скоро">
                  {t.label}
                </span>
              ) : (
                <Link key={t.label} href={t.href!} className={cls}>
                  {content}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <TeamSwitcher teams={teams} activeTeamId={activeTeamId} />
          <Link href="/dashboard/monitors/new" className="btn-primary hidden sm:inline-flex">
            + Добавить монитор
          </Link>
          <span
            title="Тема оформления — скоро"
            className="hidden h-9 w-9 cursor-default items-center justify-center rounded-lg text-slate-500 hover:text-slate-300 sm:flex"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
              <path
                d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </span>

          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white"
              title={email}
            >
              {initials}
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-ink-600/80 bg-ink-800 p-2 shadow-xl">
                  <p className="truncate px-3 py-2 text-sm text-slate-300">{email}</p>
                  <div className="my-1 border-t border-ink-700/70" />
                  <Link
                    href="/dashboard/team"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-ink-700/60 hover:text-white"
                  >
                    Команда
                  </Link>
                  <button
                    onClick={logout}
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/10"
                  >
                    Выйти
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
