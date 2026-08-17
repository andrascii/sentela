import { query } from "./db";
import { getPlan, type PlanId } from "./plans";
import type { MonitorConfig } from "./checks";

export interface MonitorRow {
  id: number;
  user_id: number;
  team_id: number | null;
  name: string;
  url: string;
  type: string;
  interval_seconds: number;
  status: string;
  ssl_expiry: string | null;
  last_checked_at: string | null;
  config: MonitorConfig;
  fail_threshold: number;
  consecutive_failures: number;
  group_name: string | null;
  heartbeat_at: string | null;
  alerts_enabled: boolean;
  created_at: string;
}

export interface CheckRow {
  id: number;
  monitor_id: number;
  status: string;
  latency_ms: number | null;
  status_code: number | null;
  error_message: string | null;
  checked_at: string;
}

export interface MonitorWithLatest extends MonitorRow {
  latest_latency: number | null;
  // node-postgres returns `numeric` (round(...)) as a string.
  uptime_24h: number | string | null;
}

export interface UptimeStats {
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
}

export const MONITOR_TYPES = [
  "http",
  "api",
  "tcp",
  "dns",
  "ssl",
  "ping",
  "heartbeat",
  "domain",
  "blacklist",
  "postgres",
  "mysql",
  "redis",
  "smtp",
] as const;
export const ALLOWED_INTERVALS = [60, 300, 900] as const;

/** Strip user:pass@ from a target URL so credentials are never stored/displayed. */
export function redactUrlCredentials(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    /* not a URL — leave as-is */
  }
  return raw;
}

export async function getActivePlanId(userId: number): Promise<PlanId> {
  const { rows } = await query<{ plan: string; expires_at: string | null }>(
    `SELECT plan, expires_at FROM subscriptions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [userId]
  );
  const r = rows[0];
  if (!r) return "starter";
  const plan = getPlan(r.plan).id;
  // A paid plan past its expiry falls back to Starter.
  if (plan !== "starter" && r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) {
    return "starter";
  }
  return plan;
}

export async function countMonitors(teamId: number): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "SELECT count(*)::int AS count FROM monitors WHERE team_id = $1",
    [teamId]
  );
  return Number(rows[0]?.count ?? 0);
}

export async function listMonitors(teamId: number): Promise<MonitorWithLatest[]> {
  const { rows } = await query<MonitorWithLatest>(
    `SELECT m.*,
            lc.latency_ms AS latest_latency,
            up.uptime_24h
     FROM monitors m
     LEFT JOIN LATERAL (
       SELECT latency_ms FROM monitor_checks c
       WHERE c.monitor_id = m.id
       ORDER BY c.checked_at DESC LIMIT 1
     ) lc ON true
     LEFT JOIN LATERAL (
       SELECT round(
         100.0 * count(*) FILTER (WHERE status <> 'down')
         / NULLIF(count(*), 0), 2
       ) AS uptime_24h
       FROM monitor_checks c
       WHERE c.monitor_id = m.id AND c.checked_at >= now() - interval '24 hours'
     ) up ON true
     WHERE m.team_id = $1
     ORDER BY m.created_at DESC`,
    [teamId]
  );
  return rows;
}

export async function getMonitor(
  id: number,
  teamId: number
): Promise<MonitorRow | null> {
  const { rows } = await query<MonitorRow>(
    "SELECT * FROM monitors WHERE id = $1 AND team_id = $2",
    [id, teamId]
  );
  return rows[0] ?? null;
}

export async function getRecentChecks(
  monitorId: number,
  limit = 50
): Promise<CheckRow[]> {
  const { rows } = await query<CheckRow>(
    `SELECT * FROM monitor_checks
     WHERE monitor_id = $1
     ORDER BY checked_at DESC LIMIT $2`,
    [monitorId, limit]
  );
  return rows;
}

export async function getUptimeStats(monitorId: number): Promise<UptimeStats> {
  const { rows } = await query<{
    u24: string | null;
    u7: string | null;
    u30: string | null;
  }>(
    `SELECT
       round(100.0 * count(*) FILTER (WHERE status <> 'down' AND checked_at >= now() - interval '24 hours')
         / NULLIF(count(*) FILTER (WHERE checked_at >= now() - interval '24 hours'), 0), 2) AS u24,
       round(100.0 * count(*) FILTER (WHERE status <> 'down' AND checked_at >= now() - interval '7 days')
         / NULLIF(count(*) FILTER (WHERE checked_at >= now() - interval '7 days'), 0), 2) AS u7,
       round(100.0 * count(*) FILTER (WHERE status <> 'down' AND checked_at >= now() - interval '30 days')
         / NULLIF(count(*) FILTER (WHERE checked_at >= now() - interval '30 days'), 0), 2) AS u30
     FROM monitor_checks
     WHERE monitor_id = $1`,
    [monitorId]
  );
  const r = rows[0];
  return {
    uptime24h: r?.u24 != null ? Number(r.u24) : null,
    uptime7d: r?.u7 != null ? Number(r.u7) : null,
    uptime30d: r?.u30 != null ? Number(r.u30) : null,
  };
}

export interface CreateMonitorInput {
  name: string;
  url: string;
  type: string;
  intervalSeconds: number;
  failThreshold: number;
  config: MonitorConfig;
  groupName?: string | null;
  alertsEnabled?: boolean;
}

export async function createMonitor(
  teamId: number,
  userId: number,
  input: CreateMonitorInput
): Promise<MonitorRow> {
  const group = input.groupName && input.groupName.trim() ? input.groupName.trim() : null;
  const { rows } = await query<MonitorRow>(
    `INSERT INTO monitors
       (team_id, user_id, name, url, type, interval_seconds, status, fail_threshold, config, group_name, alerts_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::jsonb, $9, $10)
     RETURNING *`,
    [
      teamId,
      userId,
      input.name,
      input.url,
      input.type,
      input.intervalSeconds,
      input.failThreshold,
      JSON.stringify(input.config ?? {}),
      group,
      input.alertsEnabled ?? true,
    ]
  );
  return rows[0];
}

export interface UpdateMonitorFields {
  name?: string;
  /** Target URL / host (already credential-redacted by the caller). */
  url?: string;
  groupName?: string | null;
  failThreshold?: number;
  intervalSeconds?: number;
  /** Acceptable HTTP status codes (http/api). Empty array clears the override. */
  expectedStatus?: number[];
  alertsEnabled?: boolean;
}

/** Update editable monitor fields. Returns true if a row changed. */
export async function updateMonitorMeta(
  id: number,
  teamId: number,
  fields: UpdateMonitorFields
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (fields.name !== undefined) sets.push(`name = ${add(fields.name)}`);
  if (fields.url !== undefined) sets.push(`url = ${add(fields.url)}`);
  if (fields.groupName !== undefined) {
    const group = fields.groupName && fields.groupName.trim() ? fields.groupName.trim() : null;
    sets.push(`group_name = ${add(group)}`);
  }
  if (fields.failThreshold !== undefined) sets.push(`fail_threshold = ${add(fields.failThreshold)}`);
  if (fields.alertsEnabled !== undefined) sets.push(`alerts_enabled = ${add(fields.alertsEnabled)}`);
  if (fields.intervalSeconds !== undefined) {
    sets.push(`interval_seconds = ${add(fields.intervalSeconds)}`);
  }
  if (fields.expectedStatus !== undefined) {
    if (fields.expectedStatus.length === 0) {
      sets.push(`config = config - 'expectedStatus'`);
    } else {
      sets.push(
        `config = jsonb_set(config, '{expectedStatus}', ${add(JSON.stringify(fields.expectedStatus))}::jsonb)`
      );
    }
  }

  if (sets.length === 0) return false;
  const idParam = add(id);
  const teamParam = add(teamId);
  const { rowCount } = await query(
    `UPDATE monitors SET ${sets.join(", ")} WHERE id = ${idParam} AND team_id = ${teamParam}`,
    params
  );
  return (rowCount ?? 0) > 0;
}

export async function listGroupNames(teamId: number): Promise<string[]> {
  const { rows } = await query<{ group_name: string }>(
    `SELECT DISTINCT group_name FROM monitors
     WHERE team_id = $1 AND group_name IS NOT NULL AND group_name <> ''
     ORDER BY group_name ASC`,
    [teamId]
  );
  return rows.map((r) => r.group_name);
}

export async function deleteMonitor(id: number, teamId: number): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM monitors WHERE id = $1 AND team_id = $2",
    [id, teamId]
  );
  return (rowCount ?? 0) > 0;
}
