import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getMembership, removeMember } from "@/lib/teams";
import { parseId } from "@/lib/ids";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const requesterId = await getSessionUserId();
  if (requesterId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const teamId = parseId(params.id);
  const targetUserId = parseId(params.userId);
  if (teamId == null || targetUserId == null) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }

  const role = await getMembership(teamId, requesterId);
  if (role !== "owner") {
    return NextResponse.json(
      { error: "Только владелец команды может удалять участников" },
      { status: 403 }
    );
  }

  const removed = await removeMember(teamId, targetUserId);
  if (!removed) {
    return NextResponse.json(
      { error: "Нельзя удалить этого участника" },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}
