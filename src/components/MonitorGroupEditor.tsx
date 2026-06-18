"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MonitorGroupEditor({
  id,
  current,
  groups,
  compact = false,
}: {
  id: number;
  current: string | null;
  groups: string[];
  compact?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const listId = `mg-list-${id}`;

  async function save() {
    setBusy(true);
    const res = await fetch(`/api/monitors/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupName: value }),
    });
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      router.refresh();
    }
  }

  if (!editing) {
    if (compact) {
      return (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 rounded-md border border-ink-600/70 bg-ink-900/40 px-2 py-0.5 text-xs text-slate-400 transition hover:border-brand-500/50 hover:text-brand-300"
        >
          {current && current.trim() ? (
            <>
              <span className="text-slate-500">группа:</span> {current}
            </>
          ) : (
            <>+ в группу</>
          )}
        </button>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-200">
          {current && current.trim() ? (
            current
          ) : (
            <span className="text-slate-500">Без группы</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-brand-300 hover:underline"
        >
          Изменить
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        className="input h-8 w-44 py-1 text-sm"
        list={listId}
        maxLength={80}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Без группы"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setEditing(false);
            setValue(current ?? "");
          }
        }}
      />
      <datalist id={listId}>
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <button type="button" className="btn-primary px-3 py-1 text-xs" onClick={save} disabled={busy}>
        {busy ? "…" : "OK"}
      </button>
      <button
        type="button"
        className="btn-ghost px-2 py-1 text-xs"
        onClick={() => {
          setEditing(false);
          setValue(current ?? "");
        }}
      >
        Отмена
      </button>
    </div>
  );
}
