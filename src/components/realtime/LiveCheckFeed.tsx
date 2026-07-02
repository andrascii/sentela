"use client";

import { useCallback, useRef, useState } from "react";
import { useRealtimeSocket } from "./useRealtimeSocket";
import { ClientTime } from "./ClientTime";

interface FeedItem {
  key: number;
  monitorId: number;
  name: string;
  status: string;
  latencyMs: number | null;
  region: string | null;
  statusCode: number | null;
  checkedAt: string;
}

const MAX_ITEMS = 60;

const DOT: Record<string, string> = {
  up: "bg-emerald-400",
  degraded: "bg-amber-400",
  down: "bg-red-400",
};

/**
 * Live feed of check results across the whole team, streamed as each probe
 * completes. Every item is tagged with the probe region, so running workers in
 * several regions turns this into a multi-region activity stream.
 */
export function LiveCheckFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const counter = useRef(0);

  const onMessage = useCallback((data: Record<string, unknown>) => {
    // Ignore ephemeral live-mode probes (one teammate's Live-режим would
    // otherwise flood everyone's feed with synthetic, non-persisted rows).
    if (data.type !== "check" || data.live === true) return;
    const item: FeedItem = {
      key: counter.current++,
      monitorId: typeof data.monitorId === "number" ? data.monitorId : 0,
      name: typeof data.name === "string" ? data.name : "—",
      status: typeof data.status === "string" ? data.status : "up",
      latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : null,
      region: typeof data.region === "string" ? data.region : null,
      statusCode: typeof data.statusCode === "number" ? data.statusCode : null,
      checkedAt: typeof data.checkedAt === "string" ? data.checkedAt : new Date().toISOString(),
    };
    setItems((prev) => [item, ...prev].slice(0, MAX_ITEMS));
  }, []);

  const { live } = useRealtimeSocket({ path: "/realtime", onMessage });

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-ink-600/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-white">Живая лента проверок</h2>
        <span
          className={`inline-flex items-center gap-1.5 text-xs ${
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
      </div>

      {items.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">
          Ожидание результатов проверок…
        </p>
      ) : (
        <ul className="max-h-96 divide-y divide-ink-700/50 overflow-y-auto">
          {items.map((it) => (
            <li key={it.key} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[it.status] ?? "bg-slate-400"}`} />
              <span className="min-w-0 flex-1 truncate text-slate-200">{it.name}</span>
              {it.region && (
                <span className="shrink-0 rounded bg-ink-700/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
                  {it.region}
                </span>
              )}
              <span className="shrink-0 font-mono text-xs text-slate-400">
                {it.latencyMs != null ? `${it.latencyMs} мс` : "—"}
              </span>
              <span className="shrink-0 font-mono text-xs text-slate-600">
                <ClientTime iso={it.checkedAt} withSeconds />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
