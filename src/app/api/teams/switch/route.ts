import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { getMembership, setActiveTeamCookie } from "@/lib/teams";

const schema = z.object({ teamId: z.coerce.number().int() });

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Некорректные данные" }, { status: 400 });
  }
  const { teamId } = parsed.data;
  const role = await getMembership(teamId, userId);
  if (!role) {
    return NextResponse.json({ error: "Вы не состоите в этой команде" }, { status: 403 });
  }
  setActiveTeamCookie(teamId);
  return NextResponse.json({ ok: true });
}
