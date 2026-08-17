// Привязка Telegram к аккаунту и настройки уведомлений профиля.
//
// GET    — статус: подключён ли Telegram, chat_id, глобальный тумблер, username бота
// POST   — выдать deep-link для привязки (t.me/<bot>?start=<token>)
// PATCH  — глобальный тумблер «получать уведомления в Telegram»
// DELETE — отвязать Telegram

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { getBotUsername, telegramConfigured } from "@/lib/telegram";
import {
  createLinkToken,
  getTelegramLinkStatus,
  setTelegramNotify,
  unlinkTelegram,
} from "@/lib/telegramLink";

export async function GET() {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const status = await getTelegramLinkStatus(userId);
  return NextResponse.json({
    ...status,
    botConfigured: telegramConfigured(),
  });
}

export async function POST() {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  if (!telegramConfigured()) {
    return NextResponse.json(
      { error: "Telegram-бот не настроен на сервере" },
      { status: 503 }
    );
  }
  const botUsername = await getBotUsername();
  if (!botUsername) {
    return NextResponse.json(
      { error: "Не удалось связаться с Telegram Bot API" },
      { status: 502 }
    );
  }
  const token = await createLinkToken(userId);
  return NextResponse.json({ url: `https://t.me/${botUsername}?start=${token}` });
}

const patchSchema = z.object({ notify: z.boolean() });

export async function PATCH(req: Request) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Некорректные данные" }, { status: 400 });
  }
  await setTelegramNotify(userId, parsed.data.notify);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  await unlinkTelegram(userId);
  return NextResponse.json({ ok: true });
}
