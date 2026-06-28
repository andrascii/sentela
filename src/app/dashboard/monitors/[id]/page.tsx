import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import {
  getActivePlanId,
  getMonitor,
  getRecentChecks,
  getUptimeStats,
  listGroupNames,
} from "@/lib/monitors";
import { getActiveTeamId, getTeamOwnerId } from "@/lib/teams";
import { PLANS } from "@/lib/plans";
import { parseId } from "@/lib/ids";
import { StatusBadge } from "@/components/StatusBadge";
import { LatencyChart } from "@/components/LatencyChart";
import { DeleteMonitorButton } from "@/components/DeleteMonitorButton";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { CopyableUrl } from "@/components/CopyableUrl";
import { MonitorGroupEditor } from "@/components/MonitorGroupEditor";
import { MonitorSettingsEditor } from "@/components/MonitorSettingsEditor";
import type { Assertion } from "@/lib/checks";
import {
  formatDate,
  formatDateTime,
  formatMs,
  formatUptime,
} from "@/lib/format";

export const metadata: Metadata = { title: "Монитор" };
export const dynamic = "force-dynamic";

const ASSERTION_LABEL: Record<string, string> = {
  body_contains: "Тело содержит",
  json_equals: "JSON-поле равно",
  json_exists: "JSON-поле существует",
  header_contains: "Заголовок содержит",
};

export default async function MonitorDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = (await getCurrentUser())!;
  const id = parseId(params.id);
  if (id == null) notFound();

  const teamId = await getActiveTeamId(user.id);
  const monitor = await getMonitor(id, teamId);
  if (!monitor) notFound();

  const [checks, uptime] = await Promise.all([
    getRecentChecks(id, 50),
    getUptimeStats(id),
  ]);

  const ownerId = (await getTeamOwnerId(teamId)) ?? user.id;
  const [groups, planId] = await Promise.all([
    listGroupNames(teamId),
    getActivePlanId(ownerId),
  ]);
  const minIntervalSeconds = PLANS[planId].minIntervalSeconds;
  const chronological = [...checks].reverse();
  const errors = checks.filter((c) => c.error_message).slice(0, 8);
  const config = monitor.config ?? {};
  const assertions: Assertion[] = config.assertions ?? [];
  const isHttpLike = monitor.type === "http" || monitor.type === "api";
  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  const heartbeatUrl =
    monitor.type === "heartbeat" && config.token
      ? `${base}/api/heartbeat/${config.token}`
      : null;
  const expiryLabel = monitor.type === "domain" ? "Истечение домена" : "Истечение SSL";

  return (
    <div className="space-y-8">
      <div>
        <Link href="/dashboard" className="text-sm text-slate-400 hover:text-white">
          ← Назад к мониторам
        </Link>
        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-white">{monitor.name}</h1>
              <StatusBadge status={monitor.status} />
            </div>
            <p className="mt-1 font-mono text-sm text-slate-500">
              <span className="uppercase text-slate-400">{monitor.type}</span> · {monitor.url}{" "}
              · каждые {monitor.interval_seconds} с
            </p>
          </div>
          <div className="flex items-center gap-3">
            <RealtimeRefresh path={`/realtime/monitor/${monitor.id}`} />
            <DeleteMonitorButton id={monitor.id} />
          </div>
        </div>
      </div>

      {/* Uptime + SSL */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Аптайм 24ч" value={formatUptime(uptime.uptime24h)} />
        <MetricCard label="Аптайм 7д" value={formatUptime(uptime.uptime7d)} />
        <MetricCard label="Аптайм 30д" value={formatUptime(uptime.uptime30d)} />
        <MetricCard
          label={expiryLabel}
          value={monitor.ssl_expiry ? formatDate(monitor.ssl_expiry) : "—"}
        />
      </div>

      {heartbeatUrl && (
        <div className="card p-6">
          <h2 className="mb-2 text-lg font-semibold text-white">URL для сигналов (heartbeat)</h2>
          <p className="mb-3 text-sm text-slate-400">
            Пингуйте этот URL из вашей задачи/крона по расписанию (GET или POST). Если сигнал не
            придёт дольше, чем {monitor.interval_seconds} с (×1.5), монитор станет недоступным.
          </p>
          <CopyableUrl value={heartbeatUrl} />
          <p className="mt-3 text-xs text-slate-500">
            Пример: <code className="text-slate-400">curl -fsS {heartbeatUrl}</code>
          </p>
        </div>
      )}

      {/* Configuration */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white">Конфигурация проверки</h2>
        <div className="mt-2">
          <MonitorSettingsEditor
            id={monitor.id}
            type={monitor.type}
            name={monitor.name}
            url={monitor.url}
            expectedStatus={config.expectedStatus ?? []}
            failThreshold={monitor.fail_threshold}
            intervalSeconds={monitor.interval_seconds}
            minIntervalSeconds={minIntervalSeconds}
          />
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Row label="Тип">{monitor.type.toUpperCase()}</Row>
          <Row label="Группа">
            <MonitorGroupEditor id={monitor.id} current={monitor.group_name} groups={groups} />
          </Row>
          <Row label={monitor.type === "heartbeat" ? "Ожидаемый период" : "Интервал"}>
            {monitor.interval_seconds} сек
          </Row>
          <Row label="Подтверждение падения">
            после {monitor.fail_threshold}{" "}
            {monitor.fail_threshold === 1 ? "проверки" : "проверок подряд"}
            {monitor.consecutive_failures > 0 && (
              <span className="ml-2 text-amber-300">
                (сейчас сбоев подряд: {monitor.consecutive_failures})
              </span>
            )}
          </Row>
          {isHttpLike && config.method && <Row label="Метод">{config.method}</Row>}
          {isHttpLike && (
            <Row label="Ожидаемые коды">
              {config.expectedStatus && config.expectedStatus.length > 0
                ? config.expectedStatus.join(", ")
                : "любой < 400"}
            </Row>
          )}
          {config.headers && Object.keys(config.headers).length > 0 && (
            <Row label="Заголовки">{Object.keys(config.headers).join(", ")}</Row>
          )}
          {monitor.type === "dns" && (
            <Row label="DNS-запись">
              {config.dnsRecordType || "A"}
              {config.dnsExpected ? ` = «${config.dnsExpected}»` : ""}
            </Row>
          )}
          {monitor.type === "ssl" && config.minTlsVersion && (
            <Row label="Мин. TLS">{config.minTlsVersion}</Row>
          )}
          {monitor.type === "ssl" && (
            <Row label="Проверка цепочки">{config.verifyChain ? "включена" : "выключена"}</Row>
          )}
          {monitor.type === "ping" && <Row label="Пакетов">{config.pingCount ?? 3}</Row>}
          {monitor.type === "domain" && (
            <Row label="Предупреждать за">{config.warnDays ?? 30} дн.</Row>
          )}
          {monitor.type === "blacklist" && (
            <Row label="RBL-зоны">
              {config.rblZones && config.rblZones.length > 0
                ? config.rblZones.join(", ")
                : "по умолчанию"}
            </Row>
          )}
          {(monitor.type === "postgres" || monitor.type === "mysql") && (
            <Row label="Запрос">{config.dbQuery || "SELECT 1"}</Row>
          )}
          {monitor.type === "redis" && (
            <Row label="Пароль">{config.redisPassword ? "задан" : "нет"}</Row>
          )}
        </dl>

        {assertions.length > 0 && (
          <div className="mt-5">
            <p className="mb-2 text-sm font-semibold text-slate-300">Проверки ответа</p>
            <ul className="space-y-1.5">
              {assertions.map((a, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-600/70 bg-ink-900/40 px-3 py-2 text-xs"
                >
                  <span className="font-semibold text-slate-300">
                    {ASSERTION_LABEL[a.type] ?? a.type}
                  </span>
                  {a.path && <code className="text-brand-300">{a.path}</code>}
                  {a.name && <code className="text-brand-300">{a.name}</code>}
                  {a.value && <code className="text-slate-400">«{a.value}»</code>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Latency chart */}
      <div className="card p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Задержка</h2>
        <LatencyChart points={chronological} />
      </div>

      {/* Recent errors */}
      <div className="card p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Последние ошибки</h2>
        {errors.length === 0 ? (
          <p className="text-sm text-slate-500">Ошибок за последнее время нет. 🎉</p>
        ) : (
          <ul className="space-y-2">
            {errors.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-1 rounded-lg border border-ink-600/70 bg-ink-900/40 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-mono text-sm text-red-300">{c.error_message}</span>
                <span className="text-xs text-slate-500">{formatDateTime(c.checked_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Check history */}
      <div className="card overflow-hidden">
        <h2 className="border-b border-ink-600/70 px-6 py-4 text-lg font-semibold text-white">
          История проверок
        </h2>
        {checks.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500">
            Проверок пока нет — воркер запишет результаты в ближайшее время.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr className="border-b border-ink-700/60">
                  <th className="px-6 py-3 font-semibold">Время</th>
                  <th className="px-6 py-3 font-semibold">Статус</th>
                  <th className="px-6 py-3 font-semibold">Задержка</th>
                  <th className="px-6 py-3 font-semibold">Код</th>
                  <th className="px-6 py-3 font-semibold">Детали</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/50">
                {checks.map((c) => (
                  <tr key={c.id} className="text-slate-300">
                    <td className="whitespace-nowrap px-6 py-3 text-slate-400">
                      {formatDateTime(c.checked_at)}
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-6 py-3">{formatMs(c.latency_ms)}</td>
                    <td className="px-6 py-3">{c.status_code ?? "—"}</td>
                    <td className="max-w-xs truncate px-6 py-3 text-slate-500">
                      {c.error_message ?? "OK"}
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

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1.5 text-2xl font-bold text-white">{value}</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-ink-700/40 pb-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-200">{children}</dd>
    </div>
  );
}
