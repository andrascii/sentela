"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtimeSocket } from "./useRealtimeSocket";
import { ClientTime } from "./ClientTime";

export interface Comment {
  id: number;
  monitor_id: number | null;
  author_email: string;
  body: string;
  created_at: string;
}

const TYPING_TTL_MS = 3000;
const TYPING_SEND_THROTTLE_MS = 700;
// Mirror of COMMENT_MAX_LENGTH in src/lib/incidents.ts (kept in sync manually —
// that module imports the DB layer and can't be pulled into a client bundle).
const MAX_LENGTH = 1000;

const localPart = (email: string) => email.split("@")[0] || email;

/**
 * Collaborative, live incident timeline. Team members post annotations that
 * appear for everyone in real time, with "X печатает…" indicators — a fully
 * bidirectional WebSocket surface (client → server for typing/comments, server
 * → clients for the fan-out).
 */
export function IncidentTimeline({
  initialComments,
  currentEmail,
}: {
  initialComments: Comment[];
  currentEmail: string;
}) {
  const [comments, setComments] = useState<Comment[]>(initialComments);
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [text, setText] = useState("");

  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastTypingSent = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const onMessage = useCallback(
    (data: Record<string, unknown>) => {
      if (data.type === "comment" && data.comment && typeof data.comment === "object") {
        const c = data.comment as Comment;
        setComments((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c]));
      } else if (data.type === "typing" && typeof data.name === "string") {
        const name = data.name;
        if (name === currentEmail) return;
        setTypingNames((prev) => (prev.includes(name) ? prev : [...prev, name]));
        const timers = typingTimers.current;
        if (timers[name]) clearTimeout(timers[name]);
        timers[name] = setTimeout(() => {
          delete timers[name];
          setTypingNames((prev) => prev.filter((n) => n !== name));
        }, TYPING_TTL_MS);
      }
    },
    [currentEmail]
  );

  const { live, send } = useRealtimeSocket({ path: "/realtime", onMessage });

  // Clear pending typing timers on unmount.
  useEffect(() => {
    const timers = typingTimers.current;
    return () => {
      for (const id of Object.values(timers)) clearTimeout(id);
    };
  }, []);

  // Keep the newest comment in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments]);

  const handleInput = (value: string) => {
    setText(value.slice(0, MAX_LENGTH));
    const now = Date.now();
    if (now - lastTypingSent.current >= TYPING_SEND_THROTTLE_MS) {
      lastTypingSent.current = now;
      send({ type: "typing" });
    }
  };

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    send({ type: "comment", body });
    setText("");
  };

  const typingLabel =
    typingNames.length === 0
      ? ""
      : typingNames.length === 1
        ? `${localPart(typingNames[0])} печатает…`
        : `${typingNames.map(localPart).join(", ")} печатают…`;

  return (
    <div className="card flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-ink-600/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-white">Обсуждение инцидентов</h2>
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

      <div ref={listRef} className="max-h-80 space-y-3 overflow-y-auto px-5 py-4">
        {comments.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Пока нет сообщений. Оставьте первую заметку по инциденту — её увидит вся команда.
          </p>
        ) : (
          comments.map((c) => {
            const mine = c.author_email === currentEmail;
            return (
              <div key={c.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                <div className="mb-0.5 flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-medium text-slate-400">{localPart(c.author_email)}</span>
                  <ClientTime iso={c.created_at} withSeconds />
                </div>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${
                    mine
                      ? "bg-brand-500/20 text-brand-50"
                      : "bg-ink-700/50 text-slate-200"
                  }`}
                >
                  {c.body}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-ink-600/70 px-5 py-3">
        <div className="h-4 text-xs text-slate-500">{typingLabel}</div>
        <div className="mt-1 flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Написать сообщение команде…"
            className="min-h-[40px] flex-1 resize-none rounded-lg border border-ink-600/70 bg-ink-900/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-brand-500/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            className="btn-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}
