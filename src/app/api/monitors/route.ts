import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import {
  ALLOWED_INTERVALS,
  MONITOR_TYPES,
  countMonitors,
  createMonitor,
  getActivePlanId,
  listMonitors,
  type MonitorWithLatest,
} from "@/lib/monitors";
import { PLANS } from "@/lib/plans";
import { addChannel } from "@/lib/channels";
import { getActiveTeamId, getTeamOwnerId } from "@/lib/teams";
import type { MonitorConfig } from "@/lib/checks";

const assertionSchema = z.object({
  type: z.enum(["body_contains", "json_equals", "json_exists", "header_contains"]),
  path: z.string().max(200).optional(),
  name: z.string().max(100).optional(),
  value: z.string().max(1000).optional(),
});

const configSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional(),
    headers: z.record(z.string().max(1000)).optional(),
    body: z.string().max(10000).optional(),
    expectedStatus: z.array(z.number().int().min(100).max(599)).max(20).optional(),
    assertions: z.array(assertionSchema).max(20).optional(),
    degradedLatencyMs: z.coerce.number().int().min(1).max(60000).optional(),
    dnsRecordType: z.enum(["A", "AAAA", "MX", "TXT", "CNAME", "NS"]).optional(),
    dnsExpected: z.string().max(255).optional(),
    minTlsVersion: z.enum(["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"]).optional(),
    verifyChain: z.boolean().optional(),
    pingCount: z.coerce.number().int().min(1).max(10).optional(),
    warnDays: z.coerce.number().int().min(1).max(365).optional(),
    rblZones: z.array(z.string().max(120)).max(20).optional(),
    dbUrl: z.string().max(500).optional(),
    dbQuery: z.string().max(2000).optional(),
    redisPassword: z.string().max(256).optional(),
  })
  .optional();

const schema = z.object({
  name: z.string().trim().min(1, "Укажите название").max(120),
  url: z.string().trim().min(1, "Укажите URL / цель").max(500),
  type: z.enum(MONITOR_TYPES),
  intervalSeconds: z.coerce.number().int(),
  failThreshold: z.coerce.number().int().min(1).max(5).optional(),
  groupName: z.string().trim().max(80).optional(),
  telegramChatId: z.string().trim().max(64).optional().or(z.literal("")),
  config: configSchema,
});

// Never return secret config values (Authorization headers, DB connection
// strings, Redis passwords) to clients — even team members.
function maskSecrets(monitor: MonitorWithLatest): MonitorWithLatest {
  const c = monitor.config;
  if (!c) return monitor;
  const config: MonitorConfig = { ...c };
  let changed = false;
  if (config.headers && Object.keys(config.headers).length > 0) {
    const masked: Record<string, string> = {};
    for (const k of Object.keys(config.headers)) masked[k] = "***";
    config.headers = masked;
    changed = true;
  }
  if (config.dbUrl) {
    config.dbUrl = "***";
    changed = true;
  }
  if (config.redisPassword) {
    config.redisPassword = "***";
    changed = true;
  }
  return changed ? { ...monitor, config } : monitor;
}

export async function GET() {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  const teamId = await getActiveTeamId(userId);
  const monitors = await listMonitors(teamId);
  return NextResponse.json({ monitors: monitors.map(maskSecrets) });
}

// Strip userinfo (user:password@) from the stored, displayed url so a connection
// string or basic-auth URL pasted into the target field can't leak credentials on
// the dashboard / public status page. The actual check uses config.dbUrl.
function redactUrlCredentials(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    /* not a URL — leave as-is */
  }
  return raw;
}

/** Drop assertions that are missing their required fields (server-side guard). */
function sanitizeConfig(config: MonitorConfig | undefined): MonitorConfig {
  if (!config) return {};
  const out: MonitorConfig = { ...config };
  // HEAD responses have no body, so body/JSON assertions could never pass —
  // keep only header assertions to avoid a permanent false "down".
  const isHead = (config.method || "GET").toUpperCase() === "HEAD";
  if (config.assertions) {
    out.assertions = config.assertions.filter((a) => {
      if (a.type === "body_contains") return !isHead && !!a.value;
      if (a.type === "header_contains") return !!a.name && !!a.value;
      if (a.type === "json_equals")
        return !isHead && !!a.path && a.value != null && a.value !== "";
      if (a.type === "json_exists") return !isHead && !!a.path;
      return false;
    });
  }
  return out;
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
  const { name, url, type, intervalSeconds, telegramChatId, config, groupName } =
    parsed.data;
  const failThreshold = parsed.data.failThreshold ?? 2;

  if (!ALLOWED_INTERVALS.includes(intervalSeconds as (typeof ALLOWED_INTERVALS)[number])) {
    return NextResponse.json({ error: "Недопустимый интервал проверки" }, { status: 400 });
  }

  const teamId = await getActiveTeamId(userId);
  const ownerId = (await getTeamOwnerId(teamId)) ?? userId;
  const planId = await getActivePlanId(ownerId);
  const plan = PLANS[planId];

  // Enforce plan limits — keeps usage within a real monitoring cadence.
  if (intervalSeconds < plan.minIntervalSeconds) {
    return NextResponse.json(
      {
        error: `Тариф ${plan.name} допускает минимальный интервал ${
          plan.minIntervalSeconds / 60
        } мин. Перейдите на старший тариф для более частых проверок.`,
      },
      { status: 403 }
    );
  }

  const count = await countMonitors(teamId);
  if (count >= plan.maxMonitors) {
    return NextResponse.json(
      {
        error: `Достигнут лимит тарифа ${plan.name}: ${plan.maxMonitors} мониторов.`,
      },
      { status: 403 }
    );
  }

  // Assertions are only meaningful for http/api; for those, sanitize them.
  // Other types carry their own (already shape-validated) config as-is.
  let cleanConfig: MonitorConfig =
    type === "http" || type === "api" ? sanitizeConfig(config) : config ?? {};
  // Heartbeat monitors get a server-generated push token.
  if (type === "heartbeat") {
    cleanConfig = { ...cleanConfig, token: randomBytes(16).toString("hex") };
  }

  const monitor = await createMonitor(teamId, userId, {
    name,
    url: redactUrlCredentials(url),
    type,
    intervalSeconds,
    failThreshold,
    config: cleanConfig,
    groupName,
  });

  if (telegramChatId && telegramChatId.length > 0) {
    await addChannel(userId, "telegram", telegramChatId);
  }

  return NextResponse.json({ ok: true, id: monitor.id });
}
