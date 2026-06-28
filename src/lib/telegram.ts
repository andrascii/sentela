// Minimal Telegram Bot API client. Alerts are silently skipped when no bot
// token is configured, so the rest of the system works without Telegram.

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

// A blocked or unreachable Telegram API (e.g. egress filtered in some regions)
// must never hang the worker tick — abort the request after this long.
const SEND_TIMEOUT_MS = 10_000;

// Where the Bot API lives. Override with TELEGRAM_API_BASE to route through a
// reverse proxy (Cloudflare Worker / nginx) when api.telegram.org is blocked —
// the proxy must forward to https://api.telegram.org. No trailing slash.
const API_BASE = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(
  /\/+$/,
  ""
);

export async function sendTelegramMessage(
  chatId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN not configured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Telegram API ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `Telegram API timeout (>${SEND_TIMEOUT_MS / 1000}s)` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
