import { query } from "./db";

export interface StatusMonitor {
  id: number;
  name: string;
  type: string;
  status: string;
  // node-postgres returns `numeric` (round(...)) as a string.
  uptime_30d: number | string | null;
}

export interface StatusIncident {
  id: number;
  monitor_name: string;
  error_message: string | null;
  checked_at: string;
}

export interface StatusPageData {
  slug: string;
  monitors: StatusMonitor[];
  incidents: StatusIncident[];
  overall: "operational" | "degraded" | "down" | "unknown";
}

export async function getStatusPageData(slug: string): Promise<StatusPageData | null> {
  const userRes = await query<{ id: number }>(
    "SELECT id FROM users WHERE status_slug = $1",
    [slug]
  );
  const user = userRes.rows[0];
  if (!user) return null;

  // The public status page shows the monitors of the user's personal (owned) team.
  const teamRes = await query<{ id: number }>(
    "SELECT id FROM teams WHERE owner_id = $1 ORDER BY id ASC LIMIT 1",
    [user.id]
  );
  const team = teamRes.rows[0];
  if (!team) {
    return { slug, monitors: [], incidents: [], overall: "unknown" };
  }

  const monitorsRes = await query<StatusMonitor>(
    `SELECT m.id, m.name, m.type, m.status,
            up.uptime_30d
     FROM monitors m
     LEFT JOIN LATERAL (
       SELECT round(
         100.0 * count(*) FILTER (WHERE status <> 'down')
         / NULLIF(count(*), 0), 2
       ) AS uptime_30d
       FROM monitor_checks c
       WHERE c.monitor_id = m.id AND c.checked_at >= now() - interval '30 days'
     ) up ON true
     WHERE m.team_id = $1
     ORDER BY m.name ASC`,
    [team.id]
  );

  const incidentsRes = await query<StatusIncident>(
    `SELECT mc.id, m.name AS monitor_name, mc.error_message, mc.checked_at
     FROM monitor_checks mc
     JOIN monitors m ON m.id = mc.monitor_id
     WHERE m.team_id = $1 AND mc.status = 'down'
     ORDER BY mc.checked_at DESC
     LIMIT 10`,
    [team.id]
  );

  const statuses = monitorsRes.rows.map((m) => m.status);
  let overall: StatusPageData["overall"] = "unknown";
  if (statuses.length > 0) {
    if (statuses.includes("down")) overall = "down";
    else if (statuses.includes("degraded")) overall = "degraded";
    else if (statuses.every((s) => s === "up")) overall = "operational";
    else overall = "unknown";
  }

  return {
    slug,
    monitors: monitorsRes.rows,
    incidents: incidentsRes.rows,
    overall,
  };
}
