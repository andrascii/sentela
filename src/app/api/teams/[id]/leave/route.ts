import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getMembership, removeMember } from "@/lib/teams";
import { parseId } from "@/lib/ids";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const teamId = parseId(params.id);
  if (teamId == null) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }

  const role = await getMembership(teamId, userId);
  if (!role) {
    return NextResponse.json({ error: "Вы не состоите в этой команде" }, { status: 400 });
  }
  if (role === "owner") {
    return NextResponse.json(
      { error: "Владелец не может покинуть свою команду" },
      { status: 400 }
    );
  }

  await removeMember(teamId, userId);
  return NextResponse.json({ ok: true });
}
