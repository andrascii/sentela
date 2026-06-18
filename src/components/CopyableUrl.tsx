"use client";

import { useState } from "react";

export function CopyableUrl({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-ink-600/70 bg-ink-900/50 px-3 py-2">
      <code className="flex-1 truncate text-xs text-brand-300">{value}</code>
      <button type="button" onClick={copy} className="btn-ghost text-xs">
        {copied ? "Скопировано" : "Копировать"}
      </button>
    </div>
  );
}
