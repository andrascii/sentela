"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SubscribeButton({
  plan,
  className = "btn-primary w-full",
  children,
}: {
  plan: "pro" | "business";
  className?: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/billing/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.confirmationUrl) {
        window.location.href = data.confirmationUrl;
        return;
      }
      setErr(data.error || "Не удалось начать оплату");
    } catch {
      setErr("Ошибка сети — попробуйте ещё раз");
    }
    setBusy(false);
  }

  return (
    <div>
      <button onClick={go} disabled={busy} className={className}>
        {busy ? "Переход к оплате…" : children}
      </button>
      {err && <p className="mt-2 text-sm text-red-300">{err}</p>}
    </div>
  );
}

export function CancelRenewButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const res = await fetch("/api/billing/cancel", { method: "POST" });
    setBusy(false);
    if (res.ok) router.refresh();
  }
  return (
    <button onClick={go} disabled={busy} className="btn-ghost text-sm">
      {busy ? "…" : "Отключить автопродление"}
    </button>
  );
}
