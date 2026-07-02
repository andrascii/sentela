"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Live dashboard updates over WebSocket. Connects to the realtime service and
 * refreshes the server-rendered tree whenever a monitor's status changes —
 * instead of polling on a fixed timer. If the socket can't connect or drops, it
 * falls back to interval polling (and keeps trying to reconnect), so updates
 * never stop. Drop-in replacement for <AutoRefresh/> on authenticated pages.
 */
export function RealtimeRefresh({
  pollIntervalMs = 15_000,
  path = "/realtime",
  label = "Обновления",
}: {
  pollIntervalMs?: number;
  path?: string;
  label?: string;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [live, setLive] = useState(false); // true while the socket is connected

  useEffect(() => {
    if (!enabled) return;

    let ws: WebSocket | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let reconnectId: ReturnType<typeof setTimeout> | null = null;
    let refreshId: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let backoff = 1000;

    // Coalesce a burst of events into a single refresh.
    const scheduleRefresh = () => {
      if (refreshId) return;
      refreshId = setTimeout(() => {
        refreshId = null;
        router.refresh();
      }, 400);
    };

    const startPolling = () => {
      if (pollId) return;
      pollId = setInterval(() => router.refresh(), pollIntervalMs);
    };
    const stopPolling = () => {
      if (pollId) {
        clearInterval(pollId);
        pollId = null;
      }
    };

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      // Use a local non-null `socket` for the handler assignments: `ws` is
      // reassigned inside onclose, which disables type narrowing on it.
      let socket: WebSocket;
      try {
        socket = new WebSocket(`${proto}//${window.location.host}${path}`);
      } catch {
        startPolling();
        return;
      }
      ws = socket;
      socket.onopen = () => {
        setLive(true);
        backoff = 1000;
        stopPolling(); // the socket is the source of truth while connected
      };
      socket.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          // Real, persisted checks (and legacy "status" frames) trigger a
          // refresh; ephemeral live-mode probes (data.live) do not — the live
          // panel renders those itself without reloading the page.
          if ((data?.type === "status" || data?.type === "check") && !data?.live) {
            scheduleRefresh();
          }
        } catch {
          /* ignore non-JSON frames */
        }
      };
      socket.onerror = () => {
        // onclose fires next and handles fallback + reconnect.
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      };
      socket.onclose = () => {
        setLive(false);
        if (ws === socket) ws = null;
        if (closed) return;
        startPolling(); // keep updating while disconnected
        reconnectId = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };

    connect();

    return () => {
      closed = true;
      stopPolling();
      if (reconnectId) clearTimeout(reconnectId);
      if (refreshId) clearTimeout(refreshId);
      const sock = ws;
      if (sock) {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [enabled, pollIntervalMs, path, router]);

  return (
    <button
      type="button"
      onClick={() => setEnabled((v) => !v)}
      className="inline-flex items-center gap-2 rounded-full border border-ink-600/70 bg-ink-800/60 px-3 py-1.5 text-xs text-slate-400 transition hover:text-slate-200"
      title={enabled ? "Нажмите, чтобы выключить" : "Нажмите, чтобы включить"}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          !enabled ? "bg-slate-500" : live ? "animate-pulse bg-emerald-400" : "bg-amber-400"
        }`}
      />
      {label}{" "}
      {!enabled ? "(выкл.)" : live ? "live" : `поллинг ${Math.round(pollIntervalMs / 1000)}с`}
    </button>
  );
}
