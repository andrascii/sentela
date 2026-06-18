const STYLES: Record<string, { label: string; cls: string; dot: string }> = {
  up: { label: "Доступен", cls: "bg-emerald-500/15 text-emerald-300", dot: "bg-emerald-400" },
  down: { label: "Недоступен", cls: "bg-red-500/15 text-red-300", dot: "bg-red-400" },
  degraded: {
    label: "Деградация",
    cls: "bg-amber-500/15 text-amber-300",
    dot: "bg-amber-400",
  },
  pending: {
    label: "Ожидание",
    cls: "bg-slate-500/15 text-slate-300",
    dot: "bg-slate-400",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STYLES[status] ?? STYLES.pending;
  return (
    <span className={`badge ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
