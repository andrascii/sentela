"use client";

import { useEffect, useState } from "react";

/**
 * Renders a timestamp in the visitor's local time, but only after mount — the
 * server render and first client paint both emit an em dash, so locale/timezone
 * differences can never cause a hydration mismatch.
 */
export function ClientTime({ iso, withSeconds = false }: { iso: string; withSeconds?: boolean }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      setText("");
      return;
    }
    setText(
      d.toLocaleTimeString(
        [],
        withSeconds
          ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
          : { hour: "2-digit", minute: "2-digit" }
      )
    );
  }, [iso, withSeconds]);
  return <span suppressHydrationWarning>{text || "—"}</span>;
}
