import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { addChannel, listChannels } from "@/lib/channels";

const schema = z.object({
  type: z.enum(["telegram"]).default("telegram"),
  target: z.string().trim().min(1, "Укажите цель").max(64),
});

export async function GET() {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const channels = await listChannels(userId);
  return NextResponse.json({ channels });
}

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Некорректные данные" },
      { status: 400 }
    );
  }

  const channel = await addChannel(userId, parsed.data.type, parsed.data.target);
  return NextResponse.json({ ok: true, channel });
}
