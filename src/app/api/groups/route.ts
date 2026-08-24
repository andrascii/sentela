// Переименование группы мониторов активной команды.
// Группа — текстовая метка group_name на мониторах; переименование в имя
// существующей группы сливает их в одну.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { getActiveTeamId } from "@/lib/teams";
import { renameGroup } from "@/lib/monitors";

const schema = z.object({
  from: z.string().trim().min(1, "Не указана группа").max(80),
  to: z.string().trim().min(1, "Укажите новое название").max(80),
});

export async function PATCH(req: Request) {
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
  const { from, to } = parsed.data;
  if (from === to) return NextResponse.json({ ok: true, updated: 0 });

  const teamId = await getActiveTeamId(userId);
  const updated = await renameGroup(teamId, from, to);
  if (updated === 0) {
    return NextResponse.json({ error: "Группа не найдена" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, updated });
}
