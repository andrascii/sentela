"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteMonitorButton({ id }: { id: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function onDelete() {
    setLoading(true);
    const res = await fetch(`/api/monitors/${id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    } else {
      setLoading(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <button className="btn-danger" onClick={() => setConfirming(true)}>
        Удалить
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-400">Вы уверены?</span>
      <button className="btn-danger" onClick={onDelete} disabled={loading}>
        {loading ? "Удаление…" : "Да, удалить"}
      </button>
      <button className="btn-ghost text-sm" onClick={() => setConfirming(false)}>
        Отмена
      </button>
    </div>
  );
}
