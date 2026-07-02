"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeSocket } from "./useRealtimeSocket";

const REFRESH_MIN_INTERVAL_MS = 3000;

/**
 * Live presence for a public status page: an unauthenticated WebSocket that
 * shows how many people are viewing right now and refreshes the page when a
 * monitored service changes state. This is the channel that carries the bulk of
 * public WebSocket traffic during a launch — every visitor holds one connection.
 */
export function StatusPresence({ slug }: { slug: string }) {
  const router = useRouter();
  const [online, setOnline] = useState<number | null>(null);
  const lastRefresh = useRef(0);

  const onMessage = useCallback(
    (data: Record<string, unknown>) => {
      if (data.type === "presence" && typeof data.online === "number") {
        setOnline(data.online);
      } else if (data.type === "check") {
        // Coalesce refreshes so a burst of check events can't hammer the server.
        const now = Date.now();
        if (now - lastRefresh.current >= REFRESH_MIN_INTERVAL_MS) {
          lastRefresh.current = now;
          router.refresh();
        }
      }
    },
    [router]
  );

  const { live } = useRealtimeSocket({
    path: `/realtime/status/${encodeURIComponent(slug)}`,
    onMessage,
  });

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-ink-600/70 bg-ink-800/60 px-3 py-1.5 text-xs text-slate-400"
      title="Сколько человек смотрят эту страницу прямо сейчас"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          live ? "animate-pulse bg-emerald-400" : "bg-amber-400"
        }`}
      />
      {online != null ? (
        <>
          <span className="font-semibold text-slate-200">{online}</span>{" "}
          {online === 1 ? "смотрит" : "смотрят"} сейчас
        </>
      ) : (
        "подключение…"
      )}
    </span>
  );
}
