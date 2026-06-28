"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";

const MENU_HEIGHT = 92;

export function MonitorRowMenu({ id }: { id: number }) {
  const router = useRouter();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Position a fixed-layer menu relative to the button so it is never clipped by
  // the card's overflow:hidden or hidden behind the next section.
  function place() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const openUp = r.bottom + MENU_HEIGHT > window.innerHeight;
    setPos({
      top: openUp ? r.top - MENU_HEIGHT - 4 : r.bottom + 4,
      right: window.innerWidth - r.right,
    });
  }

  function toggle() {
    if (!open) place();
    setOpen((v) => !v);
    setConfirming(false);
  }

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  async function del() {
    setBusy(true);
    const res = await fetch(`/api/monitors/${id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-ink-700/60 hover:text-white"
        aria-label="Действия"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="fixed z-50 w-44 rounded-xl border border-ink-600/80 bg-ink-800 p-1.5 shadow-2xl"
              style={{ top: pos.top, right: pos.right }}
            >
              <Link
                href={`/dashboard/monitors/${id}`}
                className="block rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-ink-700/60 hover:text-white"
              >
                Открыть
              </Link>
              {confirming ? (
                <button
                  onClick={del}
                  disabled={busy}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/10"
                >
                  {busy ? "Удаление…" : "Точно удалить?"}
                </button>
              ) : (
                <button
                  onClick={() => setConfirming(true)}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/10"
                >
                  Удалить
                </button>
              )}
            </div>
          </>,
          document.body
        )}
    </>
  );
}
