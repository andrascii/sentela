interface Point {
  latency_ms: number | null;
  status: string;
  checked_at: string;
}

// Server-rendered SVG sparkline of recent latency. `points` is chronological.
export function LatencyChart({ points }: { points: Point[] }) {
  const width = 720;
  const height = 160;
  const pad = 8;

  const usable = points.filter((p) => p.latency_ms != null);
  if (usable.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-500">
        Пока недостаточно данных — график появится после нескольких проверок.
      </div>
    );
  }

  const values = usable.map((p) => p.latency_ms as number);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);

  const n = points.length;
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (n - 1);
  const y = (v: number) => height - pad - ((v - min) / range) * (height - 2 * pad);

  let path = "";
  points.forEach((p, i) => {
    if (p.latency_ms == null) return;
    const cmd = path === "" ? "M" : "L";
    path += `${cmd}${x(i).toFixed(1)},${y(p.latency_ms).toFixed(1)} `;
  });

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="latfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#33a1ff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#33a1ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {path && (
          <>
            <path
              d={`${path} L${x(n - 1).toFixed(1)},${height - pad} L${x(0).toFixed(1)},${
                height - pad
              } Z`}
              fill="url(#latfill)"
            />
            <path d={path} fill="none" stroke="#59bfff" strokeWidth="2" />
          </>
        )}
        {points.map((p, i) =>
          p.status === "down" ? (
            <circle key={i} cx={x(i)} cy={height - pad} r="3" fill="#f87171" />
          ) : null
        )}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-slate-500">
        <span>мин {min} мс</span>
        <span>макс {max} мс</span>
      </div>
    </div>
  );
}
