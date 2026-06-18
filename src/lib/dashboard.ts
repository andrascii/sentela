import { query } from "./db";
import { getPlan } from "./plans";
import { getSubscription, effectivePlanId } from "./billing";

export interface DashboardOverview {
  counts: { total: number; up: number; down: number; degraded: number; pending: number };
  uptime24h: number | null;
  uptimeTrend: number | null; // current 24h minus previous 24h (percentage points)
  hourly: { hour: string; pct: number | null }[];
  typeCounts: Record<string, number>;
  incidents: { id: number; monitor_name: string; error_message: string | null; checked_at: string }[];
  lastCheckedAt: string | null;
  overall: "operational" | "degraded" | "down" | "unknown";
}

export interface ProbeNode {
  region: string;
  location: string;
  active: boolean;
}

/**
 * Honest probe topology. The worker runs from a single node; multi-region is not
 * implemented, so only one node is "active" and the rest are shown as planned.
 */
export function getProbeNodes(): ProbeNode[] {
  const region = process.env.PROBE_REGION || "Europe";
  const location = process.env.PROBE_LOCATION || "Локальный узел";
  return [
    { region, location, active: true },
    { region: "North America", location: "скоро", active: false },
    { region: "Asia", location: "скоро", active: false },
  ];
}

export async function getPlanCard(
  ownerId: number
): Promise<{ name: string; expiry: string | null; free: boolean }> {
  const sub = await getSubscription(ownerId);
  const planId = effectivePlanId(sub);
  const free = planId === "starter";
  let expiry: string | null = null;
  if (!free && sub?.expires_at) {
    const d = new Date(sub.expires_at);
    if (!Number.isNaN(d.getTime())) {
      expiry = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
    }
  }
  return { name: getPlan(planId).name, expiry, free };
}

export async function getTelegramStatus(
  teamId: number
): Promise<{ connected: boolean; target: string | null }> {
  const { rows } = await query<{ target: string }>(
    `SELECT nc.target FROM notification_channels nc
     JOIN team_members tm ON tm.user_id = nc.user_id
     WHERE tm.team_id = $1 AND nc.type = 'telegram'
     ORDER BY nc.created_at DESC LIMIT 1`,
    [teamId]
  );
  return { connected: rows.length > 0, target: rows[0]?.target ?? null };
}

export async function getDashboardOverview(teamId: number): Promise<DashboardOverview> {
  const [countsRes, uptimeRes, hourlyRes, typeRes, incidentsRes, lastRes] = await Promise.all([
    query<{ status: string; n: string }>(
      "SELECT status, count(*)::int AS n FROM monitors WHERE team_id = $1 GROUP BY status",
      [teamId]
    ),
    query<{ cur: string | null; prev: string | null }>(
      `SELECT
         round(100.0 * count(*) FILTER (WHERE c.status <> 'down' AND c.checked_at >= now() - interval '24 hours')
           / NULLIF(count(*) FILTER (WHERE c.checked_at >= now() - interval '24 hours'), 0), 2) AS cur,
         round(100.0 * count(*) FILTER (WHERE c.status <> 'down' AND c.checked_at >= now() - interval '48 hours' AND c.checked_at < now() - interval '24 hours')
           / NULLIF(count(*) FILTER (WHERE c.checked_at >= now() - interval '48 hours' AND c.checked_at < now() - interval '24 hours'), 0), 2) AS prev
       FROM monitor_checks c JOIN monitors m ON m.id = c.monitor_id
       WHERE m.team_id = $1`,
      [teamId]
    ),
    query<{ hour: string; pct: string | null }>(
      `SELECT to_char(date_trunc('hour', c.checked_at), 'HH24') AS hour,
              round(100.0 * count(*) FILTER (WHERE c.status <> 'down') / NULLIF(count(*), 0), 2) AS pct
       FROM monitor_checks c JOIN monitors m ON m.id = c.monitor_id
       WHERE m.team_id = $1 AND c.checked_at >= now() - interval '14 hours'
       GROUP BY date_trunc('hour', c.checked_at)
       ORDER BY date_trunc('hour', c.checked_at)`,
      [teamId]
    ),
    query<{ type: string; n: string }>(
      "SELECT type, count(*)::int AS n FROM monitors WHERE team_id = $1 GROUP BY type",
      [teamId]
    ),
    query<{ id: number; monitor_name: string; error_message: string | null; checked_at: string }>(
      `SELECT mc.id, m.name AS monitor_name, mc.error_message, mc.checked_at
       FROM monitor_checks mc JOIN monitors m ON m.id = mc.monitor_id
       WHERE m.team_id = $1 AND mc.status = 'down'
       ORDER BY mc.checked_at DESC LIMIT 6`,
      [teamId]
    ),
    query<{ last: string | null }>(
      "SELECT max(last_checked_at) AS last FROM monitors WHERE team_id = $1",
      [teamId]
    ),
  ]);

  const counts = { total: 0, up: 0, down: 0, degraded: 0, pending: 0 };
  for (const r of countsRes.rows) {
    const n = Number(r.n);
    counts.total += n;
    if (r.status === "up") counts.up += n;
    else if (r.status === "down") counts.down += n;
    else if (r.status === "degraded") counts.degraded += n;
    else counts.pending += n;
  }

  const cur = uptimeRes.rows[0]?.cur;
  const prev = uptimeRes.rows[0]?.prev;
  const uptime24h = cur != null ? Number(cur) : null;
  const uptimeTrend =
    cur != null && prev != null ? Math.round((Number(cur) - Number(prev)) * 100) / 100 : null;

  const typeCounts: Record<string, number> = {};
  for (const r of typeRes.rows) typeCounts[r.type] = Number(r.n);

  let overall: DashboardOverview["overall"] = "unknown";
  if (counts.total > 0) {
    if (counts.down > 0) overall = "down";
    else if (counts.degraded > 0) overall = "degraded";
    else if (counts.up === counts.total) overall = "operational";
    else if (counts.up > 0) overall = "operational";
    else overall = "unknown";
  }

  return {
    counts,
    uptime24h,
    uptimeTrend,
    hourly: hourlyRes.rows.map((r) => ({ hour: r.hour, pct: r.pct != null ? Number(r.pct) : null })),
    typeCounts,
    incidents: incidentsRes.rows,
    lastCheckedAt: lastRes.rows[0]?.last ?? null,
    overall,
  };
}

/** Group raw monitor types into the donut buckets shown on the overview. */
export function groupTypeCounts(typeCounts: Record<string, number>): {
  label: string;
  value: number;
  color: string;
}[] {
  const http = (typeCounts.http ?? 0) + (typeCounts.api ?? 0);
  const ssl = typeCounts.ssl ?? 0;
  const dns = typeCounts.dns ?? 0;
  const known = http + ssl + dns;
  const total = Object.values(typeCounts).reduce((a, b) => a + b, 0);
  const other = total - known;
  return [
    { label: "HTTP(S)", value: http, color: "#33a1ff" },
    { label: "SSL/TLS", value: ssl, color: "#8b5cf6" },
    { label: "DNS", value: dns, color: "#22d3ee" },
    { label: "Другие", value: other, color: "#64748b" },
  ];
}
