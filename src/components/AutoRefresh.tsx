"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Periodically re-fetches the current (dynamic) server component tree so live
 * statuses update without a manual page reload. Renders a small indicator and a
 * toggle so the user can pause it.
 */
export function AutoRefresh({
  intervalMs = 10_000,
  label = "Автообновление",
}: {
  intervalMs?: number;
  label?: string;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, router]);

  return (
    <button
      type="button"
      onClick={() => setEnabled((v) => !v)}
      className="inline-flex items-center gap-2 rounded-full border border-ink-600/70 bg-ink-800/60 px-3 py-1.5 text-xs text-slate-400 transition hover:text-slate-200"
      title={enabled ? "Нажмите, чтобы выключить" : "Нажмите, чтобы включить"}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          enabled ? "animate-pulse bg-emerald-400" : "bg-slate-500"
        }`}
      />
      {label} {Math.round(intervalMs / 1000)}с {enabled ? "" : "(выкл.)"}
    </button>
  );
}
