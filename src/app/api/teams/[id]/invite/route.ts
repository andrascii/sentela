import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { getMembership, inviteToTeam } from "@/lib/teams";
import { parseId } from "@/lib/ids";

const schema = z.object({ email: z.string().email("Некорректный email").max(254) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const teamId = parseId(params.id);
  if (teamId == null) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }

  const role = await getMembership(teamId, userId);
  if (role !== "owner") {
    return NextResponse.json(
      { error: "Только владелец команды может приглашать участников" },
      { status: 403 }
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Некорректные данные" },
      { status: 400 }
    );
  }

  const result = await inviteToTeam(teamId, parsed.data.email, userId);
  return NextResponse.json({ ok: true, result });
}
