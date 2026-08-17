"use client";

// Привязка Telegram без ручного ввода chat ID: кнопка открывает deep-link
// t.me/<bot>?start=<token>, бот сам сообщает серверу chat_id, а компонент
// поллит статус, пока привязка не подтвердится. Плюс глобальный тумблер
// «получать уведомления» и отвязка.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface TelegramStatus {
  connected: boolean;
  target: string | null;
  notify: boolean;
  botConfigured: boolean;
}

const POLL_MS = 4000;
const POLL_MAX_MS = 5 * 60 * 1000; // перестаём поллить через 5 минут ожидания

export function TelegramConnect({ initial }: { initial: TelegramStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState<TelegramStatus>(initial);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollStartedAt = useRef<number>(0);

  // Пока пользователь ушёл в Telegram жать Start — ждём подтверждения привязки.
  useEffect(() => {
    if (!linking) return;
    const timer = setInterval(async () => {
      if (Date.now() - pollStartedAt.current > POLL_MAX_MS) {
        setLinking(false);
        return;
      }
      try {
        const res = await fetch("/api/telegram");
        if (!res.ok) return;
        const data = (await res.json()) as TelegramStatus;
        if (data.connected) {
          setStatus(data);
          setLinking(false);
          router.refresh();
        }
      } catch {
        // сеть мигнула — следующий тик попробует снова
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [linking, router]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/telegram", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setError(data.error || "Не удалось получить ссылку привязки");
        return;
      }
      pollStartedAt.current = Date.now();
      setLinking(true);
      window.open(data.url, "_blank", "noopener");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/telegram", { method: "DELETE" });
      if (res.ok) {
        setStatus((s) => ({ ...s, connected: false, target: null }));
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleNotify(notify: boolean) {
    setStatus((s) => ({ ...s, notify }));
    const res = await fetch("/api/telegram", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notify }),
    });
    if (!res.ok) setStatus((s) => ({ ...s, notify: !notify }));
  }

  if (!status.botConfigured) {
    return (
      <p className="text-sm text-slate-400">
        Telegram-бот не настроен на сервере (TELEGRAM_BOT_TOKEN).
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {status.connected ? (
        <>
          <p className="text-sm text-slate-200">
            Подключён чат{" "}
            <span className="font-mono text-brand-300">{status.target}</span>
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-500"
              checked={status.notify}
              onChange={(e) => toggleNotify(e.target.checked)}
            />
            Получать уведомления в Telegram
          </label>
          <button onClick={disconnect} disabled={busy} className="btn-ghost text-xs">
            Отвязать
          </button>
        </>
      ) : linking ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-300">
            Ожидаю подтверждения… Нажми <b>Start</b> в открывшемся чате с ботом.
          </p>
          <button onClick={() => setLinking(false)} className="btn-ghost text-xs">
            Отмена
          </button>
        </div>
      ) : (
        <button onClick={connect} disabled={busy} className="btn-primary text-sm">
          {busy ? "Секунду…" : "Подключить Telegram"}
        </button>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
