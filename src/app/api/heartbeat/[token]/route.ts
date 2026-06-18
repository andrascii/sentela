import { NextResponse } from "next/server";
import { query } from "@/lib/db";

// Public endpoint a monitored job pings on its schedule. If pings stop arriving,
// the heartbeat monitor goes down (dead-man's switch). Supports GET and POST so
// it works from curl, cron `wget`, or app code.
async function recordPing(token: string) {
  if (!token || token.length > 128) {
    return NextResponse.json({ error: "Некорректный токен" }, { status: 400 });
  }
  const { rowCount } = await query(
    `UPDATE monitors SET heartbeat_at = now()
     WHERE type = 'heartbeat' AND config->>'token' = $1`,
    [token]
  );
  if (!rowCount) {
    return NextResponse.json({ error: "Монитор не найден" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  return recordPing(params.token);
}

export async function POST(_req: Request, { params }: { params: { token: string } }) {
  return recordPing(params.token);
}
