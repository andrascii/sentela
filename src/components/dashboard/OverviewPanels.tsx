import Link from "next/link";
import type { DashboardOverview, ProbeNode } from "@/lib/dashboard";
import { formatRelative } from "@/lib/format";

const OVERALL: Record<string, { label: string; ring: string; text: string; icon: string }> = {
  operational: { label: "Все системы работают", ring: "border-emerald-400/60", text: "text-emerald-300", icon: "M5 13l4 4L19 7" },
  degraded: { label: "Снижение производительности", ring: "border-amber-400/60", text: "text-amber-300", icon: "M12 8v5m0 3h.01" },
  down: { label: "Крупный сбой", ring: "border-red-400/60", text: "text-red-300", icon: "M6 6l12 12M18 6L6 18" },
  unknown: { label: "Статус неизвестен", ring: "border-slate-500/60", text: "text-slate-300", icon: "M12 8v5m0 3h.01" },
};

export function SystemStatusCard({ overall, lastCheckedAt }: { overall: string; lastCheckedAt: string | null }) {
  const s = OVERALL[overall] ?? OVERALL.unknown;
  return (
    <div className="card p-6 text-center">
      <h3 className="text-left text-sm font-semibold text-white">Статус системы</h3>
      <div className="my-4 flex justify-center">
        <div className={`flex h-24 w-24 items-center justify-center rounded-full border-4 ${s.ring}`}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" className={s.text}>
            <path d={s.icon} stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
      <p className={`text-base font-semibold ${s.text}`}>{s.label}</p>
      <p className="mt-1 text-xs text-slate-500">Последняя проверка {formatRelative(lastCheckedAt)}</p>
    </div>
  );
}

export function UptimeCard({
  uptime24h,
  trend,
  hourly,
}: {
  uptime24h: number | null;
  trend: number | null;
  hourly: { hour: string; pct: number | null }[];
}) {
  const bars = hourly.slice(-14);
  return (
    <div className="card p-6">
      <h3 className="text-sm font-semibold text-white">Аптайм 24ч</h3>
      <div className="mt-2 flex items-end gap-2">
        <span className="text-3xl font-extrabold text-white">
          {uptime24h != null ? `${uptime24h.toFixed(2)}%` : "—"}
        </span>
        {trend != null && trend !== 0 && (
          <span className={`mb-1 text-sm font-medium ${trend > 0 ? "text-emerald-300" : "text-red-300"}`}>
            {trend > 0 ? "↑" : "↓"} {Math.abs(trend).toFixed(2)}%
          </span>
        )}
      </div>
      <div className="mt-4 flex h-12 items-end gap-1">
        {bars.length === 0 ? (
          <p className="text-xs text-slate-600">Недостаточно данных</p>
        ) : (
          bars.map((b, i) => {
            const pct = b.pct ?? 0;
            const h = Math.max(8, pct);
            const color = pct >= 99 ? "bg-emerald-400" : pct >= 90 ? "bg-emerald-500/70" : pct > 0 ? "bg-amber-400/70" : "bg-ink-600";
            return (
              <div key={i} title={`${b.hour}:00 — ${b.pct ?? "—"}%`} className="flex-1">
                <div className={`w-full rounded-sm ${color}`} style={{ height: `${h}%` }} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function IncidentsCard({ incidents }: { incidents: DashboardOverview["incidents"] }) {
  return (
    <div className="card p-6">
      <h3 className="text-sm font-semibold text-white">Последние инциденты</h3>
      {incidents.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Инцидентов нет 🎉</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {incidents.slice(0, 4).map((i) => (
            <li key={i.id}>
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm text-slate-200">{i.monitor_name}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  {new Date(i.checked_at).toISOString().slice(11, 16)}
                </span>
              </div>
              {i.error_message && (
                <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-red-300">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                  {i.error_message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/dashboard/incidents"
        className="btn-secondary mt-4 w-full py-1.5 text-xs"
      >
        Все инциденты
      </Link>
    </div>
  );
}

export function QuickActions() {
  return (
    <div className="card p-6">
      <h3 className="text-sm font-semibold text-white">Быстрые действия</h3>
      <div className="mt-3 space-y-2">
        <Link
          href="/dashboard/monitors/new"
          className="flex items-center gap-3 rounded-lg border border-ink-600/70 bg-ink-900/40 px-3 py-2.5 text-sm text-slate-300 hover:border-brand-500/50 hover:text-white"
        >
          <span className="text-brand-300">＋</span> Добавить монитор
        </Link>
        <Link
          href="/dashboard/monitors/new"
          className="flex items-center gap-3 rounded-lg border border-ink-600/70 bg-ink-900/40 px-3 py-2.5 text-sm text-slate-300 hover:border-brand-500/50 hover:text-white"
        >
          <span className="text-brand-300">🔔</span> Настроить оповещения
        </Link>
      </div>
    </div>
  );
}

export function NodesCard({ nodes }: { nodes: ProbeNode[] }) {
  const active = nodes.filter((n) => n.active).length;
  return (
    <div className="card p-6">
      <h3 className="text-sm font-semibold text-white">Распределённые узлы</h3>
      <p className="mt-0.5 text-xs text-slate-500">{active} активный узел · мультирегион скоро</p>
      <ul className="mt-4 space-y-3">
        {nodes.map((n) => (
          <li key={n.region} className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className={`h-2 w-2 rounded-full ${n.active ? "bg-emerald-400" : "bg-slate-600"}`} />
              <div>
                <p className="text-sm text-slate-200">{n.region}</p>
                <p className="text-xs text-slate-500">{n.location}</p>
              </div>
            </div>
            <span className={`text-xs ${n.active ? "text-emerald-300" : "text-slate-600"}`}>
              {n.active ? "Активен" : "скоро"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CheckTypesCard({
  segments,
  total,
}: {
  segments: { label: string; value: number; color: string }[];
  total: number;
}) {
  const r = 38;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="card p-6">
      <h3 className="text-sm font-semibold text-white">Проверки по типам</h3>
      <p className="mt-0.5 text-xs text-slate-500">Всего {total} проверок</p>
      <div className="mt-4 flex items-center gap-6">
        <svg width="104" height="104" viewBox="0 0 100 100" className="shrink-0 -rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" stroke="#1b2942" strokeWidth="14" />
          {total > 0 &&
            segments
              .filter((s) => s.value > 0)
              .map((s) => {
                const len = (s.value / total) * c;
                const dash = `${len} ${c - len}`;
                const offset = -acc;
                acc += len;
                return (
                  <circle
                    key={s.label}
                    cx="50"
                    cy="50"
                    r={r}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="14"
                    strokeDasharray={dash}
                    strokeDashoffset={offset}
                  />
                );
              })}
          <text
            x="50"
            y="50"
            textAnchor="middle"
            dominantBaseline="central"
            transform="rotate(90 50 50)"
            fill="#e2e8f0"
            fontSize="22"
            fontWeight="700"
          >
            {total}
          </text>
        </svg>
        <ul className="flex-1 space-y-2 text-sm">
          {segments.map((s) => (
            <li key={s.label} className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-slate-300">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="text-slate-400">{s.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function AlertsCard({
  connected,
  children,
}: {
  connected: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Оповещения</h3>
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected ? "bg-emerald-400" : "bg-slate-600"
            }`}
          />
          Telegram
        </span>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}
