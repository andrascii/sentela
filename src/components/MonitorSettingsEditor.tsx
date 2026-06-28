"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const INTERVALS = [
  { value: 60, label: "60 секунд" },
  { value: 300, label: "5 минут" },
  { value: 900, label: "15 минут" },
];

function parseExpectedStatus(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
}

export function MonitorSettingsEditor({
  id,
  type,
  name: initialName,
  url: initialUrl,
  expectedStatus,
  failThreshold: initialThreshold,
  intervalSeconds: initialInterval,
  minIntervalSeconds,
}: {
  id: number;
  type: string;
  name: string;
  url: string;
  expectedStatus: number[];
  failThreshold: number;
  intervalSeconds: number;
  minIntervalSeconds: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialUrl);
  const [expectedText, setExpectedText] = useState(expectedStatus.join(", "));
  const [failThreshold, setFailThreshold] = useState(initialThreshold);
  const [intervalSeconds, setIntervalSeconds] = useState(initialInterval);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isHttpLike = type === "http" || type === "api";
  // Heartbeat has no target; db monitors store the real target in config.dbUrl.
  const urlEditable = type !== "heartbeat" && type !== "postgres" && type !== "mysql";

  async function save() {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      name,
      failThreshold,
      intervalSeconds,
    };
    if (urlEditable) body.url = url;
    if (isHttpLike) body.expectedStatus = parseExpectedStatus(expectedText);
    const res = await fetch(`/api/monitors/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      router.refresh();
    } else {
      setError(data.error || "Не удалось сохранить");
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-brand-300 hover:underline"
      >
        Изменить настройки
      </button>
    );
  }

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-brand-500/30 bg-ink-900/40 p-5">
      <div>
        <label className="label" htmlFor="m-name">
          Название
        </label>
        <input
          id="m-name"
          className="input"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {urlEditable && (
        <div>
          <label className="label" htmlFor="m-url">
            Адрес
          </label>
          <input
            id="m-url"
            className="input font-mono"
            maxLength={500}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      )}

      {isHttpLike && (
        <div>
          <label className="label" htmlFor="m-expected">
            Ожидаемые коды ответа
          </label>
          <input
            id="m-expected"
            className="input font-mono"
            value={expectedText}
            onChange={(e) => setExpectedText(e.target.value)}
            placeholder="200, 401"
          />
          <p className="mt-1.5 text-xs text-slate-500">
            Через запятую. Укажите <code className="text-slate-400">401</code>, чтобы такой код
            считался нормой. Пусто — доступным считается любой код &lt; 400.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="m-interval">
            Интервал проверки
          </label>
          <select
            id="m-interval"
            className="input"
            value={intervalSeconds}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
          >
            {INTERVALS.map((i) => {
              const disabled = i.value < minIntervalSeconds;
              return (
                <option key={i.value} value={i.value} disabled={disabled}>
                  {i.label}
                  {disabled ? " — нужен апгрейд" : ""}
                </option>
              );
            })}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="m-threshold">
            Подтверждать падение после
          </label>
          <select
            id="m-threshold"
            className="input"
            value={failThreshold}
            onChange={(e) => setFailThreshold(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "неудачной проверки" : "неудачных проверок подряд"}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="button" className="btn-primary" onClick={save} disabled={busy}>
          {busy ? "Сохранение…" : "Сохранить"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Отмена
        </button>
      </div>
    </div>
  );
}
