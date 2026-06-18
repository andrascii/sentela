export function formatRelative(value: string | null | undefined): string {
  if (!value) return "никогда";
  const then = new Date(value).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(then)) return "—";
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "только что";
  if (sec < 60) return `${sec} сек назад`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ч назад`;
  const day = Math.round(hr / 24);
  return `${day} дн назад`;
}

export function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value} ms`;
}

export function formatUptime(value: number | string | null | undefined): string {
  if (value == null) return "—";
  // Postgres returns `numeric` (e.g. round(...)) as a string via node-postgres.
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return "—";
  return `${n.toFixed(2)}%`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
