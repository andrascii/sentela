"use client";

import { useCallback, useEffect, useState } from "react";
import { LatencyChart } from "@/components/LatencyChart";
import { Waterfall } from "./Waterfall";
import { useRealtimeSocket } from "./useRealtimeSocket";

interface Point {
  latency_ms: number | null;
  status: string;
  checked_at: string;
}

const MAX_POINTS = 120;
const LIVE_INTERVAL_MS = 1000; // one probe per second while live mode is on
const MAX_LIVE_MS = 120_000; // auto-stop after 2 minutes so nothing runs forever

// Monitor types where an on-demand live probe is cheap and meaningful.
const LIVE_PROBE_TYPES = new Set(["http", "api", "tcp", "ping", "dns", "ssl"]);

/**
 * Live panel for a monitor's detail page. Streams real check latencies over the
 * per-monitor WebSocket channel and appends them to the chart as they arrive.
 * "Live-режим" additionally drives a bounded, per-second on-demand probe
 * (/api/monitors/[id]/live-probe) — real measurements, never persisted, so
 * uptime history stays clean — which also feeds the response-time waterfall.
 */
export function MonitorLivePanel({
  monitorId,
  monitorType,
  initialPoints,
}: {
  monitorId: number;
  monitorType: string;
  initialPoints: Point[];
}) {
  const [points, setPoints] = useState<Point[]>(() => initialPoints.slice(-MAX_POINTS));
  const [timing, setTiming] = useState<Record<string, number> | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const isHttpLike = monitorType === "http" || monitorType === "api";
  const canLiveProbe = LIVE_PROBE_TYPES.has(monitorType);

  const onMessage = useCallback(
    (data: Record<string, unknown>) => {
      if (data.type === "check" && data.monitorId === monitorId) {
        const latency = typeof data.latencyMs === "number" ? data.latencyMs : null;
        const checkedAt =
          typeof data.checkedAt === "string" ? data.checkedAt : new Date().toISOString();
        const status = typeof data.status === "string" ? data.status : "up";
        setPoints((prev) => [...prev, { latency_ms: latency, status, checked_at: checkedAt }].slice(-MAX_POINTS));
      } else if (data.type === "timing" && data.monitorId === monitorId) {
        if (data.timing && typeof data.timing === "object") {
          setTiming(data.timing as Record<string, number>);
        }
      }
    },
    [monitorId]
  );

  const { live } = useRealtimeSocket({ path: `/realtime/monitor/${monitorId}`, onMessage });

  // Live-probe driver: while liveMode is on, POST once a second, auto-stopping
  // after MAX_LIVE_MS. Cleaned up on toggle-off / unmount.
  useEffect(() => {
    if (!liveMode) return;
    let stopped = false;
    const probe = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/monitors/${monitorId}/live-probe`, { method: "POST" });
        if (stopped) return; // cleanup ran while the request was in flight
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setProbeError(j?.error || `Ошибка ${res.status}`);
          if (res.status === 401 || res.status === 403 || res.status === 404) setLiveMode(false);
        } else {
          setProbeError(null);
        }
      } catch {
        /* transient network error — keep trying until auto-stop */
      }
    };
    void probe();
    const intervalId = setInterval(probe, LIVE_INTERVAL_MS);
    const stopId = setTimeout(() => setLiveMode(false), MAX_LIVE_MS);
    return () => {
      stopped = true;
      clearInterval(intervalId);
      clearTimeout(stopId);
    };
  }, [liveMode, monitorId]);

  const latest = points[points.length - 1];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">Задержка</h2>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border border-ink-600/70 px-2.5 py-1 text-xs ${
              live ? "text-emerald-300" : "text-amber-300"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                live ? "animate-pulse bg-emerald-400" : "bg-amber-400"
              }`}
            />
            {live ? "live" : "переподключение…"}
          </span>
          {latest?.latency_ms != null && (
            <span className="text-sm text-slate-400">
              последняя: <span className="font-mono text-slate-200">{latest.latency_ms} мс</span>
            </span>
          )}
        </div>

        {canLiveProbe && (
          <button
            type="button"
            onClick={() => setLiveMode((v) => !v)}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
              liveMode
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-ink-600/70 bg-ink-800/60 text-slate-400 hover:text-slate-200"
            }`}
            title="Активные проверки раз в секунду (не влияют на историю и аптайм)"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                liveMode ? "animate-pulse bg-emerald-400" : "bg-slate-500"
              }`}
            />
            Live-режим {liveMode ? "вкл" : "выкл"}
          </button>
        )}
      </div>

      {liveMode && (
        <p className="text-xs text-slate-500">
          Live-режим: активные проверки раз в секунду, максимум 2 минуты. Эти проверки не
          записываются в историю и не влияют на аптайм.
          {probeError && <span className="ml-2 text-amber-400">{probeError}</span>}
        </p>
      )}

      <LatencyChart points={points} />

      {(isHttpLike || timing) && (
        <div>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Разбивка времени ответа
          </h3>
          <Waterfall
            timing={timing}
            hint={
              isHttpLike
                ? "Включите Live-режим, чтобы увидеть DNS / TCP / TLS / TTFB в реальном времени."
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
