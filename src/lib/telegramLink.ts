// Привязка Telegram к аккаунту через deep-link бота.
//
// Поток: пользователь в профиле жмёт «Подключить Telegram» → API выдаёт
// одноразовый токен и ссылку t.me/<bot>?start=<token> → пользователь жмёт
// Start в боте → воркер (getUpdates) видит "/start <token>", по токену находит
// пользователя и сохраняет chat_id как notification_channel типа telegram.
// Никакого ручного ввода chat ID.

import { randomBytes } from "crypto";
import { query } from "./db";
import { addChannel } from "./channels";

export const LINK_TOKEN_TTL_MINUTES = 30;

export interface TelegramLinkStatus {
  connected: boolean;
  target: string | null;
  notify: boolean;
}

export async function getTelegramLinkStatus(userId: number): Promise<TelegramLinkStatus> {
  const [channelRes, userRes] = await Promise.all([
    query<{ target: string }>(
      `SELECT target FROM notification_channels
       WHERE user_id = $1 AND type = 'telegram'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    ),
    query<{ telegram_notify: boolean }>(
      "SELECT telegram_notify FROM users WHERE id = $1",
      [userId]
    ),
  ]);
  return {
    connected: channelRes.rows.length > 0,
    target: channelRes.rows[0]?.target ?? null,
    notify: userRes.rows[0]?.telegram_notify ?? true,
  };
}

/** Новый одноразовый токен привязки; старые токены пользователя отзываются. */
export async function createLinkToken(userId: number): Promise<string> {
  const token = randomBytes(16).toString("hex");
  await query("DELETE FROM telegram_link_tokens WHERE user_id = $1", [userId]);
  await query(
    "INSERT INTO telegram_link_tokens (token, user_id) VALUES ($1, $2)",
    [token, userId]
  );
  return token;
}

/**
 * Обменивает токен из "/start <token>" на привязку chat_id.
 * Возвращает email привязанного аккаунта или null (токен неизвестен/протух).
 */
export async function consumeLinkToken(
  token: string,
  chatId: string
): Promise<{ email: string } | null> {
  const { rows } = await query<{ user_id: number; email: string }>(
    `DELETE FROM telegram_link_tokens t
     USING users u
     WHERE t.token = $1
       AND u.id = t.user_id
       AND t.created_at > now() - make_interval(mins => $2)
     RETURNING t.user_id, u.email`,
    [token, LINK_TOKEN_TTL_MINUTES]
  );
  const row = rows[0];
  if (!row) return null;
  // Один telegram-канал на пользователя: перепривязка заменяет старый chat_id.
  await query(
    "DELETE FROM notification_channels WHERE user_id = $1 AND type = 'telegram'",
    [row.user_id]
  );
  await addChannel(row.user_id, "telegram", chatId);
  return { email: row.email };
}

export async function unlinkTelegram(userId: number): Promise<void> {
  await query(
    "DELETE FROM notification_channels WHERE user_id = $1 AND type = 'telegram'",
    [userId]
  );
}

export async function setTelegramNotify(userId: number, notify: boolean): Promise<void> {
  await query("UPDATE users SET telegram_notify = $2 WHERE id = $1", [userId, notify]);
}
