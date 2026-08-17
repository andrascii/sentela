import Link from "next/link";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/session";
import {
  getActivePlanId,
  listGroupNames,
  listMonitors,
  type MonitorWithLatest,
} from "@/lib/monitors";
import { getActiveTeamId, getTeamOwnerId } from "@/lib/teams";
import {
  getDashboardOverview,
  getProbeNodes,
  groupTypeCounts,
} from "@/lib/dashboard";
import { getTelegramLinkStatus } from "@/lib/telegramLink";
import { telegramConfigured } from "@/lib/telegram";
import { TelegramConnect } from "@/components/TelegramConnect";
import { PLANS } from "@/lib/plans";
import { StatusBadge } from "@/components/StatusBadge";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { LiveCheckFeed } from "@/components/realtime/LiveCheckFeed";
import { MonitorGroupEditor } from "@/components/MonitorGroupEditor";
import { MonitorRowMenu } from "@/components/dashboard/MonitorRowMenu";
import {
  AlertsCard,
  CheckTypesCard,
  IncidentsCard,
  NodesCard,
  QuickActions,
  SystemStatusCard,
  UptimeCard,
} from "@/components/dashboard/OverviewPanels";
import { formatMs, formatRelative, formatUptime } from "@/lib/format";

export const metadata: Metadata = { title: "Обзор" };
export const dynamic = "force-dynamic";

const UNGROUPED = "";

const TYPE_BADGE: Record<string, string> = {
  http: "bg-brand-500/15 text-brand-300",
  api: "bg-indigo-500/15 text-indigo-300",
  ssl: "bg-violet-500/15 text-violet-300",
  dns: "bg-cyan-500/15 text-cyan-300",
  tcp: "bg-teal-500/15 text-teal-300",
  ping: "bg-sky-500/15 text-sky-300",
  heartbeat: "bg-pink-500/15 text-pink-300",
  domain: "bg-amber-500/15 text-amber-300",
  blacklist: "bg-orange-500/15 text-orange-300",
  postgres: "bg-blue-500/15 text-blue-300",
  mysql: "bg-amber-500/15 text-amber-300",
  redis: "bg-red-500/15 text-red-300",
  smtp: "bg-emerald-500/15 text-emerald-300",
};

const SPARK: Record<string, string> = {
  slate: "M0 14 L12 11 L24 13 L36 7 L48 10 L60 5 L72 8",
  emerald: "M0 12 L12 13 L24 9 L36 11 L48 6 L60 8 L72 4",
  amber: "M0 9 L12 12 L24 8 L36 13 L48 9 L60 12 L72 7",
  red: "M0 8 L12 10 L24 6 L36 12 L48 7 L60 11 L72 9",
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { type?: string };
}) {
  const user = (await getCurrentUser())!;
  const teamId = await getActiveTeamId(user.id);
  const ownerId = (await getTeamOwnerId(teamId)) ?? user.id;
  const [monitors, planId, groups, overview, telegram] = await Promise.all([
    listMonitors(teamId),
    getActivePlanId(ownerId),
    listGroupNames(teamId),
    getDashboardOverview(teamId),
    getTelegramLinkStatus(user.id),
  ]);
  const plan = PLANS[planId];
  const nodes = getProbeNodes();
  const donut = groupTypeCounts(overview.typeCounts);

  const typeFilter = searchParams.type;
  const visible = typeFilter ? monitors.filter((m) => m.type === typeFilter) : monitors;

  // Group visible monitors; ungrouped bucket last.
  const grouped = new Map<string, MonitorWithLatest[]>();
  for (const m of visible) {
    const key = m.group_name && m.group_name.trim() ? m.group_name : UNGROUPED;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(m);
  }
  const groupKeys = [...grouped.keys()].sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return a.localeCompare(b, "ru");
  });
  const showGroupHeaders = !(groupKeys.length === 1 && groupKeys[0] === UNGROUPED);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      {/* MAIN */}
      <div className="min-w-0 space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Мониторы</h1>
            <p className="mt-1 text-sm text-slate-400">
              {overview.counts.up} из {monitors.length} активных · Тариф {plan.name}
              {typeFilter && (
                <>
                  {" · "}
                  <span className="text-brand-300">фильтр: {typeFilter.toUpperCase()}</span>{" "}
                  <Link href="/dashboard" className="text-slate-500 hover:text-white">
                    сбросить
                  </Link>
                </>
              )}
            </p>
          </div>
          <RealtimeRefresh />
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Всего" value={monitors.length} tone="slate" />
          <StatCard label="Доступны" value={overview.counts.up} tone="emerald" />
          <StatCard label="Деградация" value={overview.counts.degraded} tone="amber" />
          <StatCard label="Недоступны" value={overview.counts.down} tone="red" />
        </div>

        {/* Monitors table */}
        {monitors.length === 0 ? (
          <EmptyState />
        ) : visible.length === 0 ? (
          <div className="card px-6 py-12 text-center text-sm text-slate-500">
            Нет мониторов типа {typeFilter?.toUpperCase()}.{" "}
            <Link href="/dashboard" className="text-brand-300 hover:underline">
              Показать все
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            {groupKeys.map((key) => {
              const items = grouped.get(key)!;
              return (
                <section key={key || "ungrouped"}>
                  {showGroupHeaders && (
                    <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {key === UNGROUPED ? "Без группы" : key}{" "}
                      <span className="text-slate-600">· {items.length}</span>
                    </p>
                  )}
                  <div className="card overflow-hidden">
                    <div className="hidden grid-cols-12 gap-4 border-b border-ink-600/70 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 md:grid">
                      <div className="col-span-4">Монитор</div>
                      <div className="col-span-2">Статус</div>
                      <div className="col-span-1">Задержка</div>
                      <div className="col-span-2">Аптайм 24ч</div>
                      <div className="col-span-2">Последняя проверка</div>
                      <div className="col-span-1" />
                    </div>
                    <ul className="divide-y divide-ink-700/60">
                      {items.map((m) => (
                        <li
                          key={m.id}
                          className="grid grid-cols-2 items-center gap-4 px-5 py-3.5 transition hover:bg-ink-700/30 md:grid-cols-12"
                        >
                          <div className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-4">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-700/60 text-slate-400">
                              <Globe />
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <Link
                                  href={`/dashboard/monitors/${m.id}`}
                                  className="truncate font-medium text-white hover:text-brand-300"
                                >
                                  {m.name}
                                </Link>
                                <span
                                  className={`badge shrink-0 ${TYPE_BADGE[m.type] ?? "bg-slate-500/15 text-slate-300"}`}
                                >
                                  {m.type.toUpperCase()}
                                </span>
                              </div>
                              <p className="truncate font-mono text-xs text-slate-500">{m.url}</p>
                              <div className="mt-1">
                                <MonitorGroupEditor id={m.id} current={m.group_name} groups={groups} compact />
                              </div>
                            </div>
                          </div>
                          <div className="md:col-span-2">
                            <StatusBadge status={m.status} />
                          </div>
                          <div className="text-sm text-slate-300 md:col-span-1">
                            {formatMs(m.latest_latency)}
                          </div>
                          <div className="md:col-span-2">
                            <UptimeBar pct={m.uptime_24h} />
                          </div>
                          <div className="text-sm text-slate-400 md:col-span-2">
                            {formatRelative(m.last_checked_at)}
                          </div>
                          <div className="flex justify-end md:col-span-1">
                            <MonitorRowMenu id={m.id} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {/* Bottom cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <NodesCard nodes={nodes} />
          <CheckTypesCard segments={donut} total={monitors.length} />
          <AlertsCard connected={telegram.connected}>
            <TelegramConnect
              initial={{ ...telegram, botConfigured: telegramConfigured() }}
            />
          </AlertsCard>
        </div>
      </div>

      {/* RIGHT RAIL */}
      <aside className="space-y-6">
        <SystemStatusCard overall={overview.overall} lastCheckedAt={overview.lastCheckedAt} />
        <LiveCheckFeed />
        <UptimeCard uptime24h={overview.uptime24h} trend={overview.uptimeTrend} hourly={overview.hourly} />
        <IncidentsCard incidents={overview.incidents} />
        <QuickActions />
      </aside>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "slate" | "emerald" | "amber" | "red";
}) {
  const toneCls = {
    slate: "text-slate-100",
    emerald: "text-emerald-300",
    amber: "text-amber-300",
    red: "text-red-300",
  }[tone];
  const stroke = {
    slate: "#60a5fa",
    emerald: "#34d399",
    amber: "#fbbf24",
    red: "#f87171",
  }[tone];
  return (
    <div className="card flex items-center justify-between p-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <p className={`mt-1 text-3xl font-bold ${toneCls}`}>{value}</p>
      </div>
      <svg width="72" height="22" viewBox="0 0 72 22" fill="none" className="opacity-70">
        <path d={SPARK[tone]} stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function UptimeBar({ pct }: { pct: number | string | null }) {
  const n = pct == null ? null : Number(pct);
  const color =
    n == null ? "bg-ink-600" : n >= 99 ? "bg-emerald-400" : n >= 90 ? "bg-emerald-500/70" : "bg-amber-400/70";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full ${color}`} style={{ width: `${n ?? 0}%` }} />
      </div>
      <span className="text-sm text-slate-300">{formatUptime(pct)}</span>
    </div>
  );
}

function Globe() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-300">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path d="M3 12h4l3-7 4 14 3-7h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-white">Пока нет мониторов</h2>
      <p className="mt-2 max-w-sm text-sm text-slate-400">
        Добавьте первый монитор, чтобы начать отслеживать доступность, задержки и сертификаты.
      </p>
      <Link href="/dashboard/monitors/new" className="btn-primary mt-6">
        + Добавить первый монитор
      </Link>
    </div>
  );
}
