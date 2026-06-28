import Link from "next/link";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/session";
import { getActiveTeamId } from "@/lib/teams";
import { query } from "@/lib/db";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Инциденты" };
export const dynamic = "force-dynamic";

interface IncidentRow {
  id: number;
  monitor_id: number;
  monitor_name: string;
  type: string;
  status_code: number | null;
  error_message: string | null;
  checked_at: string;
}

export default async function IncidentsPage() {
  const user = (await getCurrentUser())!;
  const teamId = await getActiveTeamId(user.id);

  const { rows: incidents } = await query<IncidentRow>(
    `SELECT mc.id, m.id AS monitor_id, m.name AS monitor_name, m.type,
            mc.status_code, mc.error_message, mc.checked_at
     FROM monitor_checks mc JOIN monitors m ON m.id = mc.monitor_id
     WHERE m.team_id = $1 AND mc.status = 'down'
     ORDER BY mc.checked_at DESC LIMIT 100`,
    [teamId]
  );

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Инциденты</h1>
          <p className="mt-1 text-sm text-slate-400">
            Зафиксированные падения мониторов команды (последние 100).
          </p>
        </div>
        <RealtimeRefresh />
      </div>

      <div className="card overflow-hidden">
        {incidents.length === 0 ? (
          <p className="px-6 py-16 text-center text-sm text-slate-500">
            Инцидентов нет — все проверки успешны. 🎉
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr className="border-b border-ink-700/60">
                  <th className="px-6 py-3 font-semibold">Время</th>
                  <th className="px-6 py-3 font-semibold">Монитор</th>
                  <th className="px-6 py-3 font-semibold">Код</th>
                  <th className="px-6 py-3 font-semibold">Причина</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/50">
                {incidents.map((i) => (
                  <tr key={i.id} className="text-slate-300">
                    <td className="whitespace-nowrap px-6 py-3 text-slate-400">
                      {formatDateTime(i.checked_at)}
                    </td>
                    <td className="px-6 py-3">
                      <Link
                        href={`/dashboard/monitors/${i.monitor_id}`}
                        className="font-medium text-white hover:text-brand-300"
                      >
                        {i.monitor_name}
                      </Link>
                      <span className="ml-2 text-xs uppercase text-slate-500">{i.type}</span>
                    </td>
                    <td className="px-6 py-3">{i.status_code ?? "—"}</td>
                    <td className="max-w-md truncate px-6 py-3 text-red-300">
                      {i.error_message ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
