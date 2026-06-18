"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";

type IconKey =
  | "home"
  | "monitor"
  | "check"
  | "shield"
  | "dns"
  | "server"
  | "telegram"
  | "history"
  | "alert"
  | "team"
  | "status"
  | "settings"
  | "billing"
  | "api";

const ICONS: Record<IconKey, string> = {
  home: "M3 11l9-7 9 7M5 10v10h14V10",
  monitor: "M3 12h4l3-7 4 14 3-7h4",
  check: "M4 12l5 5L20 6",
  shield: "M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z",
  dns: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  server: "M4 5h16v5H4zM4 14h16v5H4M8 7.5h.01M8 16.5h.01",
  telegram: "M21 5L3 12l6 2 2 6 3-4 4 3 3-14z",
  history: "M3 12a9 9 0 109-9 9 9 0 00-9 9zm0 0H1m2 0l2-2M12 7v5l3 2",
  alert: "M12 9v4m0 4h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6A2 2 0 0022 18L13.7 3.9a2 2 0 00-3.4 0z",
  team: "M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 11a3 3 0 100-6 3 3 0 000 6zM22 19v-1a4 4 0 00-3-3.8M16 5.1A4 4 0 0116 13",
  status: "M4 5h16v14H4zM4 9h16M8 13h6",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1A1.7 1.7 0 005 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00-1.2-2.9H1a2 2 0 110-4h.1A1.7 1.7 0 004.6 5l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H11a2 2 0 114 0",
  api: "M8 3v4M16 3v4M4 11h16M6 7h12a1 1 0 011 1v11a1 1 0 01-1 1H6a1 1 0 01-1-1V8a1 1 0 011-1z",
  billing: "M2 7h20v10H2zM2 11h20M6 15h4",
};

interface Item {
  label: string;
  icon: IconKey;
  href?: string;
  type?: string;
  soon?: boolean;
}

interface Section {
  title?: string;
  items: Item[];
}

export function Sidebar({
  planName,
  planExpiry,
  planFree,
  statusSlug,
}: {
  planName: string;
  planExpiry: string | null;
  planFree: boolean;
  statusSlug: string | null;
}) {
  const pathname = usePathname();

  const sections: Section[] = [
    {
      items: [{ label: "Обзор", icon: "home", href: "/dashboard" }],
    },
    {
      title: "Мониторинг",
      items: [
        { label: "Мониторы", icon: "monitor", href: "/dashboard" },
        { label: "Проверки", icon: "check", soon: true },
        { label: "SSL-сертификаты", icon: "shield", href: "/dashboard", type: "ssl" },
        { label: "DNS", icon: "dns", href: "/dashboard", type: "dns" },
        { label: "Узлы", icon: "server", soon: true },
      ],
    },
    {
      title: "Оповещения",
      items: [
        { label: "Telegram", icon: "telegram", soon: true },
        { label: "История оповещений", icon: "history", soon: true },
        { label: "Инциденты", icon: "alert", href: "/dashboard/incidents" },
      ],
    },
    {
      title: "Управление",
      items: [
        { label: "Команды", icon: "team", href: "/dashboard/team" },
        { label: "Тариф и оплата", icon: "billing", href: "/dashboard/billing" },
        ...(statusSlug
          ? [{ label: "Статус-страница", icon: "status" as IconKey, href: `/status/${statusSlug}` }]
          : []),
        { label: "Настройки", icon: "settings", soon: true },
        { label: "API", icon: "api", soon: true },
      ],
    },
  ];

  function isActive(item: Item): boolean {
    if (!item.href || item.type) return false;
    if (item.href === "/dashboard") return pathname === "/dashboard";
    return pathname === item.href || pathname.startsWith(item.href + "/");
  }

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-ink-700/70 bg-ink-900/60 lg:flex">
      <div className="px-5 py-5">
        <Logo />
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        {sections.map((section, si) => (
          <div key={si}>
            {section.title && (
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
                {section.title}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(item);
                const href = item.href
                  ? item.type
                    ? `${item.href}?type=${item.type}`
                    : item.href
                  : "#";
                const inner = (
                  <span
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                      active
                        ? "bg-brand-500/15 text-white"
                        : item.soon
                          ? "cursor-default text-slate-600"
                          : "text-slate-300 hover:bg-ink-700/50 hover:text-white"
                    }`}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" className={active ? "text-brand-300" : ""}>
                      <path
                        d={ICONS[item.icon]}
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="flex-1">{item.label}</span>
                    {item.soon && (
                      <span className="rounded bg-ink-700/70 px-1.5 py-0.5 text-[10px] text-slate-500">
                        скоро
                      </span>
                    )}
                  </span>
                );
                return (
                  <li key={item.label}>
                    {item.soon ? inner : <Link href={href}>{inner}</Link>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="m-3 rounded-xl border border-ink-600/70 bg-ink-800/60 p-4">
        <p className="text-sm font-semibold text-white">Тариф {planName}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {planFree ? "Бесплатный тариф" : planExpiry ? `Активен до ${planExpiry}` : "Активен"}
        </p>
        <Link href="/dashboard/billing" className="btn-secondary mt-3 w-full py-1.5 text-xs">
          {planFree ? "Улучшить тариф" : "Управление тарифом"}
        </Link>
      </div>
    </aside>
  );
}
