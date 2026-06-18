import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { createTeam, setActiveTeamCookie } from "@/lib/teams";

const schema = z.object({ name: z.string().trim().min(1, "Укажите название").max(80) });

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Некорректные данные" },
      { status: 400 }
    );
  }
  const teamId = await createTeam(parsed.data.name, userId);
  setActiveTeamCookie(teamId);
  return NextResponse.json({ ok: true, id: teamId });
}
