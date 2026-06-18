import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getMembership, revokeInvite } from "@/lib/teams";
import { parseId } from "@/lib/ids";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; inviteId: string } }
) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const teamId = parseId(params.id);
  const inviteId = parseId(params.inviteId);
  if (teamId == null || inviteId == null) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }

  const role = await getMembership(teamId, userId);
  if (role !== "owner") {
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 403 });
  }

  const revoked = await revokeInvite(teamId, inviteId);
  if (!revoked) {
    return NextResponse.json({ error: "Приглашение не найдено" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
