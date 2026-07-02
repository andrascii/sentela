import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getActiveTeamId } from "@/lib/teams";
import { getMonitor } from "@/lib/monitors";
import { parseId } from "@/lib/ids";
import { runCheck, measureHttpTiming } from "@/lib/checks";
import { query } from "@/lib/db";

// On-demand "live mode" probe for a single monitor. Runs a REAL check (and, for
// http/api, a timing breakdown) and streams the result over the realtime WS
// service — but never writes to monitor_checks and never changes monitor status,
// so watching a monitor live can't skew its history or uptime. Client-driven and
// bounded (see MonitorLivePanel: ~1 req/s, auto-stops after 2 min).

const NOTIFY_CHANNEL = "sentela_status";
const LIVE_PROBE_TYPES = new Set(["http", "api", "tcp", "ping", "dns", "ssl"]);
const MIN_INTERVAL_MS = 900; // per-monitor flood guard

// Process-local last-probe timestamps (this runs in the long-lived app process).
const lastProbeAt = new Map<number, number>();

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const id = parseId(params.id);
  if (id == null) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }

  const teamId = await getActiveTeamId(userId);
  const monitor = await getMonitor(id, teamId);
  if (!monitor) {
    return NextResponse.json({ error: "Не найдено" }, { status: 404 });
  }
  if (!LIVE_PROBE_TYPES.has(monitor.type)) {
    return NextResponse.json(
      { error: "Live-режим недоступен для этого типа монитора" },
      { status: 400 }
    );
  }

  const now = Date.now();
  const last = lastProbeAt.get(id) ?? 0;
  if (now - last < MIN_INTERVAL_MS) {
    return NextResponse.json({ error: "Слишком часто" }, { status: 429 });
  }
  lastProbeAt.set(id, now);

  const result = await runCheck({ type: monitor.type, url: monitor.url, config: monitor.config });
  const checkedAt = new Date().toISOString();

  // Fan out the check (marked `live` so it feeds live views but doesn't trigger
  // the full-page RealtimeRefresh reloads that real, persisted checks do).
  const checkPayload = {
    kind: "check",
    live: true,
    teamId: monitor.team_id,
    userId: monitor.user_id,
    monitorId: monitor.id,
    name: monitor.name.slice(0, 120),
    type: monitor.type,
    status: result.status,
    prevStatus: monitor.status,
    changed: false,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode ?? null,
    errorMessage: result.errorMessage ?? null,
    region: "live",
    checkedAt,
  };

  let timing: Record<string, number> | null = null;
  if (monitor.type === "http" || monitor.type === "api") {
    const t = await measureHttpTiming(monitor.url, monitor.config);
    timing = t.timing as unknown as Record<string, number>;
  }

  try {
    await query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify(checkPayload)]);
    if (timing) {
      await query("SELECT pg_notify($1, $2)", [
        NOTIFY_CHANNEL,
        JSON.stringify({
          kind: "timing",
          teamId: monitor.team_id,
          userId: monitor.user_id,
          monitorId: monitor.id,
          statusCode: result.statusCode ?? null,
          checkedAt,
          timing,
        }),
      ]);
    }
  } catch (err) {
    console.error("[live-probe] notify failed:", err);
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode ?? null,
    errorMessage: result.errorMessage ?? null,
    timing,
    checkedAt,
  });
}
