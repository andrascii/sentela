"use client";

// Response-time waterfall: the phase-by-phase breakdown of one HTTP(S) request
// (DNS → TCP → TLS → TTFB → download). Fed live by the monitor's timing events.
const PHASES = [
  { key: "dnsMs", label: "DNS", color: "#22d3ee" },
  { key: "connectMs", label: "TCP", color: "#2dd4bf" },
  { key: "tlsMs", label: "TLS", color: "#a78bfa" },
  { key: "ttfbMs", label: "TTFB", color: "#fbbf24" },
  { key: "downloadMs", label: "Загрузка", color: "#59bfff" },
] as const;

export function Waterfall({
  timing,
  hint,
}: {
  timing: Record<string, number> | null;
  hint?: string;
}) {
  if (!timing) {
    return (
      <p className="text-sm text-slate-500">
        {hint ?? "Разбивка по фазам появится после первой проверки."}
      </p>
    );
  }

  const values = PHASES.map((p) => Math.max(0, Number(timing[p.key]) || 0));
  const sum = values.reduce((a, b) => a + b, 0);
  const total = Math.max(Number(timing.totalMs) || 0, sum, 1);

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-ink-800">
        {PHASES.map((p, i) => {
          const w = (values[i] / total) * 100;
          if (w <= 0) return null;
          return (
            <div
              key={p.key}
              style={{ width: `${w}%`, backgroundColor: p.color }}
              title={`${p.label}: ${values[i]} мс`}
            />
          );
        })}
      </div>

      {/* Legend + values */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
        {PHASES.map((p, i) => (
          <div key={p.key} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-slate-400">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
              {p.label}
            </span>
            <span className="font-mono text-slate-300">{values[i]} мс</span>
          </div>
        ))}
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Итого</span>
          <span className="font-mono font-semibold text-white">
            {Number(timing.totalMs) || sum} мс
          </span>
        </div>
      </div>
    </div>
  );
}
