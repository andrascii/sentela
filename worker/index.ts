/**
 * Sentela background worker.
 *
 * On each tick it:
 *   1. selects monitors whose interval has elapsed,
 *   2. runs the configured check (HTTP / API / TCP / DNS / SSL),
 *   3. records the raw result in monitor_checks,
 *   4. confirms the monitor status using a failure threshold (retries before alert),
 *   5. on a confirmed up -> down (or recovery) transition, sends a Telegram alert.
 *
 * Checks are single, low-frequency probes governed by each monitor's interval.
 */
import { ensureMigrated, query } from "../src/lib/db";
import { runCheck, type CheckResult, type MonitorConfig } from "../src/lib/checks";
import { sendTelegramMessage, escapeHtml, telegramConfigured } from "../src/lib/telegram";
import {
  subscriptionsDueForRenewal,
  markRenewAttempt,
  recordPayment,
  activatePaidPlan,
} from "../src/lib/billing";
import { createPayment, yookassaConfigured } from "../src/lib/yookassa";
import { PLANS } from "../src/lib/plans";

interface MonitorRow {
  id: number;
  user_id: number;
  team_id: number | null;
  name: string;
  url: string;
  type: string;
  interval_seconds: number;
  status: string;
  config: MonitorConfig | null;
  fail_threshold: number;
  consecutive_failures: number;
  heartbeat_at: string | null;
}

const TICK_SECONDS = Math.max(
  5,
  parseInt(process.env.WORKER_TICK_SECONDS || "15", 10) || 15
);
const MAX_CONCURRENT = 20; // raised for larger fleets (50+ monitors) to reduce backlog
const BATCH_LIMIT = 200;
const RETENTION_DAYS = 90;
const CLEANUP_EVERY_TICKS = 240; // ~1 hour at a 15s tick
const BILLING_EVERY_TICKS = 240; // check auto-renewals ~hourly

const APP_BASE_URL = (process.env.APP_BASE_URL || "http://localhost:3000").replace(
  /\/+$/,
  ""
);

// Postgres channel the realtime WS service LISTENs on for live dashboard updates.
const NOTIFY_CHANNEL = "sentela_status";

// This worker's probe location. A single-region deployment leaves it unset (NULL);
// running extra workers in other regions with distinct REGION values powers the
// multi-region live check feed.
const REGION = (process.env.REGION || "").trim() || null;

let running = true;
let tickCount = 0;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      try {
        await fn(current);
      } catch (err) {
        console.error("[worker] task failed:", err);
      }
    }
  });
  await Promise.all(workers);
}

async function getDueMonitors(): Promise<MonitorRow[]> {
  const { rows } = await query<MonitorRow>(
    `SELECT id, user_id, team_id, name, url, type, interval_seconds, status,
            config, fail_threshold, consecutive_failures, heartbeat_at
     FROM monitors
     WHERE last_checked_at IS NULL
        OR now() - last_checked_at >= make_interval(secs => interval_seconds)
     ORDER BY last_checked_at NULLS FIRST
     LIMIT $1`,
    [BATCH_LIMIT]
  );
  return rows;
}

// Heartbeat (dead-man's switch): no outbound request — we evaluate how long ago
// the monitored job last pinged its heartbeat URL.
function evaluateHeartbeat(monitor: MonitorRow): CheckResult {
  if (!monitor.heartbeat_at) {
    return { status: "down", latencyMs: 0, errorMessage: "Сигнал ещё не получен" };
  }
  const ageMs = Date.now() - new Date(monitor.heartbeat_at).getTime();
  const thresholdMs = monitor.interval_seconds * 1500; // 1.5× expected period
  if (ageMs > thresholdMs) {
    const mins = Math.round(ageMs / 60000);
    return { status: "down", latencyMs: 0, errorMessage: `Сигнал просрочен (последний ${mins} мин назад)` };
  }
  return { status: "up", latencyMs: 0, errorMessage: null };
}

async function processMonitor(monitor: MonitorRow): Promise<void> {
  const result =
    monitor.type === "heartbeat"
      ? evaluateHeartbeat(monitor)
      : await runCheck({
          type: monitor.type,
          url: monitor.url,
          config: monitor.config,
        });

  // Always record the raw result so history reflects what actually happened.
  await query(
    `INSERT INTO monitor_checks
       (monitor_id, status, latency_ms, status_code, error_message, region)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      monitor.id,
      result.status,
      result.latencyMs,
      result.statusCode ?? null,
      result.errorMessage ?? null,
      REGION,
    ]
  );

  // Confirmation state machine (retries before alerting):
  //   - a "down" probe increments the failure streak (capped at the threshold so the
  //     displayed counter stays meaningful during a long outage);
  //   - while failing but below the threshold the monitor shows "degraded" (amber
  //     "confirming outage"), never a stale green or a misleading "slow" label;
  //   - a clean "up" probe resets the streak; a "degraded" (reachable-but-slow) probe
  //     holds the streak so a flapping down/degraded endpoint still reaches the threshold.
  const prevStatus = monitor.status;
  const threshold = Math.max(1, monitor.fail_threshold || 1);
  let newFailures: number;
  let confirmed: string;
  if (result.status === "down") {
    newFailures = Math.min(monitor.consecutive_failures + 1, threshold);
    confirmed = newFailures >= threshold || prevStatus === "down" ? "down" : "degraded";
  } else if (result.status === "up") {
    newFailures = 0;
    confirmed = "up";
  } else {
    // "degraded": reachable but slow / SSL warning.
    newFailures = prevStatus === "down" ? 0 : monitor.consecutive_failures;
    confirmed = "degraded";
  }

  await query(
    `UPDATE monitors
     SET status = $2,
         last_checked_at = now(),
         consecutive_failures = $3,
         ssl_expiry = COALESCE($4, ssl_expiry)
     WHERE id = $1`,
    [monitor.id, confirmed, newFailures, result.sslExpiry ?? null]
  );

  // Push a live update after EVERY check — latency, last-checked time and uptime
  // change each run, so notifying only on a status transition would leave the
  // dashboard frozen while a monitor's status is steady.
  await notifyMonitorUpdate(monitor, result, confirmed, prevStatus);

  await maybeAlert(monitor, result, prevStatus, confirmed, threshold);
}

// Publish a monitor update so the realtime WS service can push it to subscribed
// clients (it LISTENs on NOTIFY_CHANNEL). Best-effort — a failure here must never
// break the check loop.
async function notifyMonitorUpdate(
  monitor: MonitorRow,
  result: CheckResult,
  status: string,
  prevStatus: string
): Promise<void> {
  const payload = JSON.stringify({
    kind: "check",
    teamId: monitor.team_id,
    userId: monitor.user_id,
    monitorId: monitor.id,
    name: monitor.name.slice(0, 120),
    type: monitor.type,
    status,
    prevStatus,
    changed: status !== prevStatus,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode ?? null,
    errorMessage: result.errorMessage ?? null,
    region: REGION,
    checkedAt: new Date().toISOString(),
  });
  try {
    await query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, payload]);
  } catch (err) {
    console.error("[worker] monitor notify failed:", err);
  }
}

async function maybeAlert(
  monitor: MonitorRow,
  result: CheckResult,
  prevStatus: string,
  confirmed: string,
  threshold: number
): Promise<void> {
  const wasDown = prevStatus === "down";
  const isDown = confirmed === "down";

  let kind: "down" | "recovered" | null = null;
  if (!wasDown && isDown) kind = "down";
  else if (wasDown && !isDown) kind = "recovered";
  if (!kind) return;

  if (!telegramConfigured()) return;

  // Alert every current team member's Telegram channels (not just the creator's).
  // Falls back to the creator for legacy monitors with no team.
  const { rows: channels } = monitor.team_id
    ? await query<{ target: string }>(
        `SELECT DISTINCT nc.target
         FROM notification_channels nc
         JOIN team_members tm ON tm.user_id = nc.user_id
         WHERE tm.team_id = $1 AND nc.type = 'telegram'`,
        [monitor.team_id]
      )
    : await query<{ target: string }>(
        `SELECT target FROM notification_channels
         WHERE user_id = $1 AND type = 'telegram'`,
        [monitor.user_id]
      );
  if (channels.length === 0) return;

  const message = formatAlert(monitor, result, kind, threshold);
  await Promise.all(
    channels.map(async (c) => {
      const res = await sendTelegramMessage(c.target, message);
      if (!res.ok) {
        console.error(`[worker] telegram send failed (${c.target}):`, res.error);
      }
    })
  );
}

function formatAlert(
  monitor: MonitorRow,
  result: CheckResult,
  kind: "down" | "recovered",
  threshold: number
): string {
  const name = escapeHtml(monitor.name);
  const url = escapeHtml(monitor.url);
  const link = `${APP_BASE_URL}/dashboard/monitors/${monitor.id}`;
  if (kind === "down") {
    const reason = result.errorMessage ? `\nПричина: ${escapeHtml(result.errorMessage)}` : "";
    const confirm = threshold > 1 ? `\nПодтверждено после ${threshold} проверок подряд` : "";
    return (
      `🔴 <b>НЕДОСТУПЕН</b> — ${name}\n` +
      `${url} (${monitor.type.toUpperCase()})${reason}${confirm}\n` +
      `<a href="${link}">Открыть монитор</a>`
    );
  }
  return (
    `🟢 <b>ВОССТАНОВЛЕН</b> — ${name}\n` +
    `${url} (${monitor.type.toUpperCase()})\n` +
    `Задержка: ${result.latencyMs} мс\n` +
    `<a href="${link}">Открыть монитор</a>`
  );
}

async function cleanupOldChecks(): Promise<void> {
  try {
    const { rowCount } = await query(
      `DELETE FROM monitor_checks
       WHERE checked_at < now() - make_interval(days => $1)`,
      [RETENTION_DAYS]
    );
    if (rowCount) console.log(`[worker] pruned ${rowCount} old check rows`);
  } catch (err) {
    console.error("[worker] cleanup failed:", err);
  }
}

// Auto-renew paid subscriptions whose period ends soon by charging the saved
// YooKassa payment method off-session.
async function billingTick(): Promise<void> {
  if (!yookassaConfigured()) return;
  let due: Awaited<ReturnType<typeof subscriptionsDueForRenewal>>;
  try {
    due = await subscriptionsDueForRenewal();
  } catch (err) {
    console.error("[billing] query failed:", err);
    return;
  }
  for (const s of due) {
    if (s.plan !== "pro" && s.plan !== "business") continue;
    const plan = s.plan;
    const amount = s.price_rub ?? PLANS[plan].priceRub;
    try {
      await markRenewAttempt(s.user_id);
      const p = await createPayment({
        amountRub: amount,
        description: `Sentela ${PLANS[plan].name} — автопродление`,
        metadata: { user_id: String(s.user_id), plan, kind: "recurring" },
        paymentMethodId: s.payment_method_id,
      });
      if (p.status === "succeeded" && p.paid) {
        if (await recordPayment(s.user_id, p.id, plan, amount, "succeeded", "recurring")) {
          await activatePaidPlan(s.user_id, plan, null, true);
        }
        console.log(`[billing] auto-renewed user ${s.user_id} (${plan})`);
      } else {
        console.log(`[billing] renewal pending user ${s.user_id} status=${p.status}`);
      }
    } catch (err) {
      console.error(`[billing] renewal failed user ${s.user_id}:`, err);
    }
  }
}

async function tick(): Promise<void> {
  const due = await getDueMonitors();
  if (due.length > 0) {
    console.log(`[worker] checking ${due.length} monitor(s)`);
    await runWithConcurrency(due, MAX_CONCURRENT, processMonitor);
  }
  tickCount++;
  if (tickCount % CLEANUP_EVERY_TICKS === 0) {
    await cleanupOldChecks();
  }
  if (tickCount % BILLING_EVERY_TICKS === 0) {
    await billingTick();
  }
}

async function loop(): Promise<void> {
  while (running) {
    const startedAt = Date.now();
    try {
      await tick();
    } catch (err) {
      console.error("[worker] tick error:", err);
    }
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, TICK_SECONDS * 1000 - elapsed);
    await sleep(wait);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(signal: string): void {
  console.log(`[worker] received ${signal}, shutting down...`);
  running = false;
  setTimeout(() => process.exit(0), 1000);
}

async function main(): Promise<void> {
  console.log(
    `[worker] starting — tick every ${TICK_SECONDS}s, telegram ${
      telegramConfigured() ? "enabled" : "disabled"
    }`
  );
  await ensureMigrated();
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await loop();
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
