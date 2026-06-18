/**
 * Strictly parse a route id. Unlike parseInt, this rejects values with trailing
 * non-numeric characters (e.g. "5abc"), so malformed URLs 404/400 instead of
 * silently mapping to the leading numeric value.
 */
export function parseId(raw: string | undefined | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
