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
    <div>
      {status.connected ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-200">Уведомления</p>
              <p className="truncate text-xs text-slate-500">
                чат <span className="font-mono">{status.target}</span>
              </p>
            </div>
            <Switch checked={status.notify} onChange={toggleNotify} />
          </div>
          <div className="flex items-center justify-between border-t border-white/5 pt-2.5">
            <span className="text-xs text-slate-500">
              {status.notify ? "Алерты приходят в этот чат" : "Алерты выключены"}
            </span>
            <button
              onClick={disconnect}
              disabled={busy}
              className="text-xs text-slate-500 transition-colors hover:text-red-300"
            >
              Отвязать
            </button>
          </div>
        </div>
      ) : linking ? (
        <div className="space-y-2.5">
          <p className="text-sm text-slate-300">
            Нажми <b className="text-white">Start</b> в открывшемся чате с ботом —
            привязка подтвердится здесь автоматически.
          </p>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand-400" />
            <span className="text-xs text-slate-500">Ожидаю подтверждения…</span>
            <button
              onClick={() => setLinking(false)}
              className="ml-auto text-xs text-slate-500 hover:text-slate-300"
            >
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          <p className="text-sm text-slate-400">
            Привяжи Telegram — алерты мониторов будут приходить в личный чат с ботом.
          </p>
          <button onClick={connect} disabled={busy} className="btn-primary w-full py-1.5 text-sm">
            {busy ? "Секунду…" : "Подключить Telegram"}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-brand-500" : "bg-slate-700"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}
