import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { deleteChannel } from "@/lib/channels";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }
  const deleted = await deleteChannel(id, userId);
  if (!deleted) {
    return NextResponse.json({ error: "Не найдено" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
