import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/Logo";
import { StatusBadge } from "@/components/StatusBadge";
import { AutoRefresh } from "@/components/AutoRefresh";
import { StatusPresence } from "@/components/realtime/StatusPresence";
import { getStatusPageData } from "@/lib/status";
import { formatDateTime, formatUptime } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { project: string };
}): Promise<Metadata> {
  return { title: `Статус — ${params.project}` };
}

const OVERALL: Record<string, { label: string; cls: string; dot: string }> = {
  operational: {
    label: "Все системы работают",
    cls: "text-emerald-300",
    dot: "bg-emerald-400",
  },
  degraded: {
    label: "Снижение производительности",
    cls: "text-amber-300",
    dot: "bg-amber-400",
  },
  down: { label: "Крупный сбой", cls: "text-red-300", dot: "bg-red-400" },
  unknown: { label: "Статус неизвестен", cls: "text-slate-300", dot: "bg-slate-400" },
};

export default async function StatusPage({
  params,
}: {
  params: { project: string };
}) {
  const data = await getStatusPageData(params.project);
  if (!data) notFound();

  const overall = OVERALL[data.overall];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-ink-700/70 bg-ink-900/80">
        <div className="container-page flex h-16 items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-sm text-slate-400 hover:text-white"
            >
              ← Назад к панели
            </Link>
            <Logo />
          </div>
          <div className="flex items-center gap-3">
            <StatusPresence slug={data.slug} />
            <AutoRefresh intervalMs={10_000} />
          </div>
        </div>
      </header>

      <main className="container-page flex-1 py-12">
        <div className="mx-auto max-w-3xl">
          {/* Overall banner */}
          <div className="card flex items-center gap-3 p-6">
            <span className={`h-3 w-3 rounded-full ${overall.dot}`} />
            <h1 className={`text-xl font-semibold ${overall.cls}`}>{overall.label}</h1>
          </div>

          {/* Services */}
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Сервисы
            </h2>
            <div className="card divide-y divide-ink-700/60">
              {data.monitors.length === 0 ? (
                <p className="px-6 py-8 text-sm text-slate-500">Сервисы пока не опубликованы.</p>
              ) : (
                data.monitors.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between px-6 py-4"
                  >
                    <div>
                      <p className="font-medium text-white">{m.name}</p>
                      <p className="text-xs uppercase text-slate-500">{m.type}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm text-slate-400">
                        {formatUptime(m.uptime_30d)} 30д
                      </span>
                      <StatusBadge status={m.status} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Incidents */}
          <section className="mt-10">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Последние инциденты
            </h2>
            <div className="card">
              {data.incidents.length === 0 ? (
                <p className="px-6 py-8 text-sm text-slate-500">
                  Инцидентов не зафиксировано. Всё в порядке.
                </p>
              ) : (
                <ul className="divide-y divide-ink-700/60">
                  {data.incidents.map((i) => (
                    <li key={i.id} className="px-6 py-4">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-white">{i.monitor_name}</span>
                        <span className="text-xs text-slate-500">
                          {formatDateTime(i.checked_at)}
                        </span>
                      </div>
                      {i.error_message && (
                        <p className="mt-1 font-mono text-xs text-red-300">{i.error_message}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <p className="mt-10 text-center text-xs text-slate-600">
            Работает на{" "}
            <Link href="/" className="text-brand-400 hover:underline">
              Sentela
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
