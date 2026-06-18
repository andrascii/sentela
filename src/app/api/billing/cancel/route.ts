import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { cancelAutoRenew } from "@/lib/billing";

export async function POST() {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  await cancelAutoRenew(userId);
  return NextResponse.json({ ok: true });
}
