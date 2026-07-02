"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Shared realtime WebSocket client: connects to the realtime service, parses
 * JSON frames, and reconnects with exponential backoff. Mirrors the connection
 * lifecycle of <RealtimeRefresh/>, factored out so every live component
 * (latency chart, check feed, presence, incident timeline) shares one battle-
 * tested implementation.
 *
 * Returns `live` (socket connected) and `send` (JSON-encode + send if open).
 */
export function useRealtimeSocket({
  path,
  onMessage,
  enabled = true,
}: {
  path: string;
  onMessage: (data: Record<string, unknown>) => void;
  enabled?: boolean;
}): { live: boolean; send: (obj: unknown) => void } {
  const [live, setLive] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // Keep the latest callback without re-running the connect effect on every render.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!enabled) return;

    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectId: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      let s: WebSocket;
      try {
        s = new WebSocket(`${proto}//${window.location.host}${path}`);
      } catch {
        reconnectId = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
        return;
      }
      socket = s;
      wsRef.current = s;
      s.onopen = () => {
        setLive(true);
        backoff = 1000;
      };
      s.onmessage = (e) => {
        try {
          onMessageRef.current(JSON.parse(e.data));
        } catch {
          /* ignore non-JSON frames */
        }
      };
      s.onerror = () => {
        try {
          s.close();
        } catch {
          /* onclose handles reconnect */
        }
      };
      s.onclose = () => {
        setLive(false);
        if (wsRef.current === s) wsRef.current = null;
        if (socket === s) socket = null;
        if (closed) return;
        reconnectId = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectId) clearTimeout(reconnectId);
      const s = socket;
      if (s) {
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
      wsRef.current = null;
      setLive(false);
    };
  }, [path, enabled]);

  const send = (obj: unknown) => {
    const s = wsRef.current;
    if (s && s.readyState === WebSocket.OPEN) {
      try {
        s.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  };

  return { live, send };
}
