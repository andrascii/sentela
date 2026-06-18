import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { acceptInvite, setActiveTeamCookie } from "@/lib/teams";

const schema = z.object({ token: z.string().min(1).max(128) });

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Некорректный токен" }, { status: 400 });
  }

  const result = await acceptInvite(parsed.data.token, userId);
  if (!result.ok) {
    const error =
      result.reason === "email_mismatch"
        ? "Это приглашение отправлено на другой email. Войдите под приглашённым адресом."
        : "Приглашение недействительно или уже использовано";
    return NextResponse.json({ error }, { status: 400 });
  }
  setActiveTeamCookie(result.teamId);
  return NextResponse.json({ ok: true, teamId: result.teamId });
}
