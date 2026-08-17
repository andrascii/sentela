import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import {
  ALLOWED_INTERVALS,
  deleteMonitor,
  getActivePlanId,
  redactUrlCredentials,
  updateMonitorMeta,
} from "@/lib/monitors";
import { getActiveTeamId, getTeamOwnerId } from "@/lib/teams";
import { PLANS } from "@/lib/plans";
import { parseId } from "@/lib/ids";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: z.string().trim().min(1).max(500).optional(),
  groupName: z.string().trim().max(80).nullable().optional(),
  failThreshold: z.coerce.number().int().min(1).max(5).optional(),
  intervalSeconds: z.coerce.number().int().optional(),
  expectedStatus: z.array(z.number().int().min(100).max(599)).max(20).optional(),
  alertsEnabled: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const id = parseId(params.id);
  if (id == null) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Некорректные данные" }, { status: 400 });
  }
  const teamId = await getActiveTeamId(userId);

  // Validate interval against the team's plan if it's being changed.
  if (parsed.data.intervalSeconds !== undefined) {
    const iv = parsed.data.intervalSeconds;
    if (!ALLOWED_INTERVALS.includes(iv as (typeof ALLOWED_INTERVALS)[number])) {
      return NextResponse.json({ error: "Недопустимый интервал проверки" }, { status: 400 });
    }
    const ownerId = (await getTeamOwnerId(teamId)) ?? userId;
    const plan = PLANS[await getActivePlanId(ownerId)];
    if (iv < plan.minIntervalSeconds) {
      return NextResponse.json(
        {
          error: `Тариф ${plan.name} допускает минимальный интервал ${
            plan.minIntervalSeconds / 60
          } мин.`,
        },
        { status: 403 }
      );
    }
  }

  const fields = { ...parsed.data };
  if (fields.url !== undefined) fields.url = redactUrlCredentials(fields.url);
  const ok = await updateMonitorMeta(id, teamId, fields);
  if (!ok) {
    return NextResponse.json({ error: "Не найдено" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const id = parseId(params.id);
  if (id == null) {
    return NextResponse.json({ error: "Некорректный id" }, { status: 400 });
  }

  const teamId = await getActiveTeamId(userId);
  const deleted = await deleteMonitor(id, teamId);
  if (!deleted) {
    return NextResponse.json({ error: "Не найдено" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
