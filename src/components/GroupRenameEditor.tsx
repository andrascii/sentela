"use client";

// Инлайн-переименование группы мониторов в заголовке группы на дашборде.
// Группа — текстовая метка на мониторах; переименование в существующее имя
// сливает группы (это подсказывается под полем).

import { useState } from "react";
import { useRouter } from "next/navigation";

export function GroupRenameEditor({ name, count }: { name: string; count: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const to = value.trim();
    if (!to || to === name) {
      setEditing(false);
      setValue(name);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/groups", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: name, to }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      router.refresh();
    } else {
      setError(data.error || "Не удалось переименовать");
    }
  }

  if (!editing) {
    return (
      <span className="group/rename inline-flex items-center gap-1.5">
        {name} <span className="text-slate-600">· {count}</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Переименовать группу"
          className="text-slate-600 opacity-0 transition group-hover/rename:opacity-100 hover:text-brand-300 focus:opacity-100"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 20h4L20 8l-4-4L4 16v4zM14.5 5.5l4 4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col gap-1 align-middle normal-case tracking-normal">
      <span className="inline-flex items-center gap-1.5">
        <input
          autoFocus
          className="input h-7 w-44 px-2 py-0 text-xs"
          maxLength={80}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setEditing(false);
              setValue(name);
              setError(null);
            }
          }}
        />
        <button type="button" onClick={save} disabled={busy} className="text-xs text-brand-300 hover:underline">
          {busy ? "…" : "OK"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setValue(name);
            setError(null);
          }}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          Отмена
        </button>
      </span>
      {error && <span className="text-xs font-normal text-red-300">{error}</span>}
    </span>
  );
}
