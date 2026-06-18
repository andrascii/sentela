import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client as PgClient } from "pg";

const execFileAsync = promisify(execFile);

export type MonitorType = "http" | "api" | "tcp" | "dns" | "ssl";
export type CheckStatus = "up" | "down" | "degraded";

/** A single assertion run against an HTTP/API response. */
export interface Assertion {
  type: "body_contains" | "json_equals" | "json_exists" | "header_contains";
  /** Dot-path for json_* assertions, e.g. "data.items.0.id". */
  path?: string;
  /** Header name for header_contains. */
  name?: string;
  /** Expected value / substring. */
  value?: string;
}

/** Per-monitor request configuration (used by http and api checks). */
export interface MonitorConfig {
  // http / api
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Acceptable status codes. When set, only these count as "up". */
  expectedStatus?: number[];
  assertions?: Assertion[];
  /** Override the "slow response" threshold (ms) for http/api/tcp/ping. */
  degradedLatencyMs?: number;

  // dns
  dnsRecordType?: string; // A | AAAA | MX | TXT | CNAME | NS
  dnsExpected?: string; // optional substring that must appear in a record

  // ssl
  minTlsVersion?: string; // e.g. "TLSv1.2"
  verifyChain?: boolean; // when true, an invalid/untrusted chain is "down"

  // ping
  pingCount?: number;

  // heartbeat (push)
  token?: string;

  // domain (RDAP) / ssl
  warnDays?: number;

  // blacklist (DNSBL)
  rblZones?: string[];

  // postgres / mysql / redis
  dbUrl?: string; // connection string (secret)
  dbQuery?: string;
  redisPassword?: string; // secret
}

export interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
  statusCode?: number | null;
  errorMessage?: string | null;
  sslExpiry?: Date | null;
}

// Reasonable, fixed limits. Checks are single, low-frequency probes — this is a
// monitoring tool, not a load generator.
const TIMEOUT_MS = 10_000;
const DEGRADED_LATENCY_MS = 1_500;
const SSL_WARN_DAYS = 14;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// SSRF guard. Cloud-metadata / link-local is ALWAYS blocked. Private/loopback
// ranges are blocked unless ALLOW_PRIVATE_TARGETS=true (the self-contained Docker
// demo sets it so it can monitor its own internal services; leave it unset in prod).
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_TARGETS === "true";

function ipv4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function inV4Range(ipInt: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (ipv4ToInt(base) & mask);
}

function isBlockedIpv4(ip: string): boolean {
  const i = ipv4ToInt(ip);
  // Always blocked: link-local (incl. 169.254.169.254 cloud metadata) and 0.0.0.0/8.
  if (inV4Range(i, "169.254.0.0", 16)) return true;
  if (inV4Range(i, "0.0.0.0", 8)) return true;
  if (ALLOW_PRIVATE) return false;
  return (
    inV4Range(i, "127.0.0.0", 8) ||
    inV4Range(i, "10.0.0.0", 8) ||
    inV4Range(i, "172.16.0.0", 12) ||
    inV4Range(i, "192.168.0.0", 16) ||
    inV4Range(i, "100.64.0.0", 10)
  );
}

function isBlockedIpv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith("fe80")) return true; // link-local
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (ALLOW_PRIVATE) return false;
  if (v === "::1") return true; // loopback
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local
  return false;
}

/** Throws if the host (or any resolved IP) is in a blocked range. */
async function assertSafeHost(host: string): Promise<void> {
  const ipv = net.isIP(host);
  if (ipv === 4) {
    if (isBlockedIpv4(host)) throw new Error(`Заблокированный адрес: ${host}`);
    return;
  }
  if (ipv === 6) {
    if (isBlockedIpv6(host)) throw new Error(`Заблокированный адрес: ${host}`);
    return;
  }
  let addrs: { address: string; family: number }[] = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return; // let the real check surface the resolution error
  }
  for (const a of addrs) {
    const blocked = a.family === 4 ? isBlockedIpv4(a.address) : isBlockedIpv6(a.address);
    if (blocked) throw new Error(`Заблокированный адрес ${host} → ${a.address}`);
  }
}

function parseTarget(raw: string, defaultPort: number): { host: string; port: number } {
  const value = raw.trim();
  try {
    if (value.includes("://")) {
      const u = new URL(value);
      const port = u.port
        ? parseInt(u.port, 10)
        : u.protocol === "https:"
          ? 443
          : u.protocol === "http:"
            ? 80
            : defaultPort;
      return { host: u.hostname, port };
    }
    if (value.includes("/")) {
      const u = new URL("http://" + value);
      return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : defaultPort };
    }
  } catch {
    // fall through to manual host:port parsing
  }
  const m = value.match(/^(.*):(\d+)$/);
  if (m) return { host: m[1], port: parseInt(m[2], 10) };
  return { host: value, port: defaultPort };
}

function httpUrl(raw: string): string {
  const value = raw.trim();
  if (value.includes("://")) return value;
  return "https://" + value;
}

/** Resolve a value at a dot-path inside a parsed JSON object (supports array indices). */
function getJsonPath(obj: unknown, path: string): unknown {
  const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

interface ResponseContext {
  statusCode: number;
  headers: Record<string, string>;
  bodyText: string;
}

/** Returns the first failing assertion message, or null if all pass. */
function evaluateAssertions(
  assertions: Assertion[],
  ctx: ResponseContext
): string | null {
  let json: unknown;
  let jsonParsed = false;
  let jsonOk = false;
  const ensureJson = (): boolean => {
    if (!jsonParsed) {
      jsonParsed = true;
      try {
        json = JSON.parse(ctx.bodyText);
        jsonOk = true;
      } catch {
        jsonOk = false;
      }
    }
    return jsonOk;
  };

  for (const a of assertions) {
    switch (a.type) {
      case "body_contains": {
        if (!a.value || !ctx.bodyText.includes(a.value)) {
          return `Тело ответа не содержит «${a.value ?? ""}»`;
        }
        break;
      }
      case "header_contains": {
        const name = (a.name ?? "").toLowerCase();
        const actual = ctx.headers[name];
        if (actual == null) return `Заголовок «${a.name ?? ""}» отсутствует`;
        if (a.value && !actual.includes(a.value)) {
          return `Заголовок «${a.name}» не содержит «${a.value}»`;
        }
        break;
      }
      case "json_exists": {
        if (!ensureJson()) return "Ответ не является валидным JSON";
        if (getJsonPath(json, a.path ?? "") === undefined) {
          return `JSON-поле «${a.path ?? ""}» не найдено`;
        }
        break;
      }
      case "json_equals": {
        if (!ensureJson()) return "Ответ не является валидным JSON";
        const got = getJsonPath(json, a.path ?? "");
        if (got === undefined) return `JSON-поле «${a.path ?? ""}» не найдено`;
        if (String(got) !== String(a.value ?? "")) {
          return `JSON-поле «${a.path}» = «${String(got)}», ожидалось «${a.value ?? ""}»`;
        }
        break;
      }
    }
  }
  return null;
}

/** HTTP and API checks share this implementation; `config` adds method/headers/body/assertions. */
async function checkHttpLike(
  rawUrl: string,
  config: MonitorConfig = {}
): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  const method = (config.method || "GET").toUpperCase();
  const expected = config.expectedStatus;
  // If the user wants to assert a 3xx code, do NOT auto-follow — otherwise the
  // evaluated status would be the redirect target (typically 200), never the 3xx.
  const followRedirects = !(expected && expected.some((c) => c >= 300 && c < 400));

  try {
    const headers: Record<string, string> = {
      "user-agent": "Sentela-Monitor/1.0 (+https://sentela.example)",
      ...(config.headers ?? {}),
    };

    let currentUrl = httpUrl(rawUrl);
    let res: Response | null = null;

    // Manual redirect handling so every hop's host is re-validated against the
    // SSRF guard (an external 302 must not be able to bounce us to an internal IP).
    for (let hop = 0; ; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        throw new Error(`Некорректный URL: ${currentUrl}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Неподдерживаемая схема: ${parsed.protocol}`);
      }
      await assertSafeHost(parsed.hostname);

      const init: RequestInit = {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers,
      };
      if (config.body && BODY_METHODS.has(method)) init.body = config.body;

      res = await fetch(currentUrl, init);

      const isRedirect =
        res.status >= 300 && res.status < 400 && res.headers.get("location");
      if (followRedirects && isRedirect) {
        if (hop >= MAX_REDIRECTS) {
          await res.arrayBuffer().catch(() => undefined);
          return {
            status: "down",
            latencyMs: Math.round(performance.now() - start),
            statusCode: res.status,
            errorMessage: `Слишком много редиректов (> ${MAX_REDIRECTS})`,
          };
        }
        await res.arrayBuffer().catch(() => undefined);
        currentUrl = new URL(res.headers.get("location")!, currentUrl).toString();
        continue;
      }
      break;
    }

    const latencyMs = Math.round(performance.now() - start);

    // Read (capped) body so assertions can run and the connection closes cleanly.
    let bodyText = "";
    try {
      const ab = await res!.arrayBuffer();
      const limited = ab.byteLength > MAX_BODY_BYTES ? ab.slice(0, MAX_BODY_BYTES) : ab;
      bodyText = new TextDecoder().decode(limited);
    } catch {
      bodyText = "";
    }

    const headerObj: Record<string, string> = {};
    res!.headers.forEach((v, k) => {
      headerObj[k.toLowerCase()] = v;
    });

    // Expected status: if configured, only those codes count as success.
    const statusOk =
      expected && expected.length > 0 ? expected.includes(res!.status) : res!.status < 400;

    if (!statusOk) {
      const expectedNote =
        expected && expected.length > 0 ? `, ожидались: ${expected.join(", ")}` : "";
      return {
        status: "down",
        latencyMs,
        statusCode: res!.status,
        errorMessage: `Код ${res!.status} ${res!.statusText}`.trim() + expectedNote,
      };
    }

    // Content assertions.
    const assertions = config.assertions ?? [];
    if (assertions.length > 0) {
      const failure = evaluateAssertions(assertions, {
        statusCode: res!.status,
        headers: headerObj,
        bodyText,
      });
      if (failure) {
        return { status: "down", latencyMs, statusCode: res!.status, errorMessage: failure };
      }
    }

    return {
      status:
        latencyMs > (config.degradedLatencyMs ?? DEGRADED_LATENCY_MS) ? "degraded" : "up",
      latencyMs,
      statusCode: res!.status,
      errorMessage: null,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      status: "down",
      latencyMs,
      statusCode: null,
      errorMessage: describeError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkTcp(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const { host, port } = parseTarget(raw, 80);
  try {
    await assertSafeHost(host);
  } catch (err) {
    return { status: "down", latencyMs: 0, errorMessage: describeError(err) };
  }
  const degraded = config.degradedLatencyMs ?? DEGRADED_LATENCY_MS;
  const start = performance.now();
  return new Promise<CheckResult>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => {
      const latencyMs = Math.round(performance.now() - start);
      finish({
        status: latencyMs > degraded ? "degraded" : "up",
        latencyMs,
        errorMessage: null,
      });
    });
    socket.once("timeout", () =>
      finish({
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        errorMessage: `TCP connect to ${host}:${port} timed out`,
      })
    );
    socket.once("error", (err) =>
      finish({
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        errorMessage: describeError(err),
      })
    );
    socket.connect(port, host);
  });
}

function dnsRecordsToStrings(records: unknown, type: string): string[] {
  if (!Array.isArray(records)) return [];
  if (type === "MX") {
    return (records as { priority: number; exchange: string }[]).map(
      (r) => `${r.priority} ${r.exchange}`
    );
  }
  if (type === "TXT") {
    return (records as string[][]).map((r) => (Array.isArray(r) ? r.join("") : String(r)));
  }
  if (records.length > 0 && typeof records[0] === "object") {
    return records.map((r) => JSON.stringify(r));
  }
  return records.map((r) => String(r));
}

async function checkDns(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const { host } = parseTarget(raw, 0);
  const type = (config.dnsRecordType || "A").toUpperCase();
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      dns.resolve(host, type as never),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup (${type}) for ${host} timed out`)),
          TIMEOUT_MS
        );
      }),
    ]);
    const latencyMs = Math.round(performance.now() - start);
    const values = dnsRecordsToStrings(records, type);
    if (values.length === 0) {
      return { status: "down", latencyMs, errorMessage: `Нет ${type}-записей для ${host}` };
    }
    // Optional value assertion (detects DNS hijack / misconfiguration).
    if (config.dnsExpected && config.dnsExpected.trim()) {
      const needle = config.dnsExpected.trim();
      const ok = values.some((v) => v.includes(needle));
      if (!ok) {
        return {
          status: "down",
          latencyMs,
          errorMessage: `Ожидалось «${needle}» в ${type}; получено: ${values.join(", ").slice(0, 80)}`,
        };
      }
    }
    return { status: "up", latencyMs, errorMessage: null };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - start),
      errorMessage: describeError(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TLS_ORDER = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];
function tlsBelowMin(actual: string | null, min: string): boolean {
  if (!actual) return false;
  const a = TLS_ORDER.indexOf(actual);
  const m = TLS_ORDER.indexOf(min);
  return a >= 0 && m >= 0 && a < m;
}

async function checkSsl(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const { host, port } = parseTarget(raw, 443);
  try {
    await assertSafeHost(host);
  } catch (err) {
    return { status: "down", latencyMs: 0, errorMessage: describeError(err) };
  }
  const warnDays = config.warnDays ?? SSL_WARN_DAYS;
  const start = performance.now();
  return new Promise<CheckResult>((resolve) => {
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect(
      // verifyChain → reject untrusted/invalid certificate chains.
      { host, port, servername: host, rejectUnauthorized: Boolean(config.verifyChain) },
      () => {
        const latencyMs = Math.round(performance.now() - start);
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) {
          finish({ status: "down", latencyMs, errorMessage: "Сертификат не предоставлен" });
          return;
        }
        const expiry = new Date(cert.valid_to);
        const daysLeft = (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        let status: CheckStatus = "up";
        let errorMessage: string | null = null;
        if (daysLeft <= 0) {
          status = "down";
          errorMessage = `Сертификат истёк ${expiry.toISOString().slice(0, 10)}`;
        } else if (daysLeft <= warnDays) {
          status = "degraded";
          errorMessage = `Сертификат истекает через ${Math.floor(daysLeft)} дн.`;
        }
        // Minimum TLS version enforcement.
        if (status === "up" && config.minTlsVersion) {
          const proto = socket.getProtocol();
          if (tlsBelowMin(proto, config.minTlsVersion)) {
            status = "degraded";
            errorMessage = `Используется ${proto}, требуется ≥ ${config.minTlsVersion}`;
          }
        }
        finish({ status, latencyMs, errorMessage, sslExpiry: expiry });
      }
    );
    socket.setTimeout(TIMEOUT_MS);
    socket.once("timeout", () =>
      finish({
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        errorMessage: `TLS handshake to ${host}:${port} timed out`,
      })
    );
    socket.once("error", (err) =>
      finish({
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        errorMessage: describeError(err),
      })
    );
  });
}

const DEFAULT_RBL = ["zen.spamhaus.org", "bl.spamcop.net", "b.barracudacentral.org"];

async function checkPing(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const { host } = parseTarget(raw, 0);
  try {
    await assertSafeHost(host);
  } catch (err) {
    return { status: "down", latencyMs: 0, errorMessage: describeError(err) };
  }
  const count = Math.min(Math.max(config.pingCount ?? 3, 1), 10);
  const degraded = config.degradedLatencyMs ?? DEGRADED_LATENCY_MS;
  const start = performance.now();
  try {
    const { stdout } = await execFileAsync("ping", ["-c", String(count), "-W", "2", host], {
      timeout: TIMEOUT_MS,
    });
    const lossM = stdout.match(/(\d+)% packet loss/);
    const loss = lossM ? parseInt(lossM[1], 10) : 100;
    const rttM = stdout.match(/=\s*[\d.]+\/([\d.]+)\//);
    const avg = rttM ? Math.round(parseFloat(rttM[1])) : Math.round(performance.now() - start);
    if (loss >= 100) {
      return { status: "down", latencyMs: avg, errorMessage: `100% потерь пакетов (${host})` };
    }
    if (loss > 0) {
      return { status: "degraded", latencyMs: avg, errorMessage: `Потери пакетов: ${loss}%` };
    }
    return { status: avg > degraded ? "degraded" : "up", latencyMs: avg, errorMessage: null };
  } catch (err) {
    // ping exits non-zero on 100% loss; surface a clear reason.
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    const latencyMs = Math.round(performance.now() - start);
    if (e.stdout && /100% packet loss/.test(e.stdout)) {
      return { status: "down", latencyMs, errorMessage: `100% потерь пакетов (${host})` };
    }
    if (e.code === "ENOENT") {
      return { status: "down", latencyMs, errorMessage: "Команда ping недоступна в системе" };
    }
    return {
      status: "down",
      latencyMs,
      errorMessage: `Хост недоступен: ${host} (потеря пакетов или ICMP заблокирован)`,
    };
  }
}

async function checkDomain(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const domain = parseTarget(raw, 0).host;
  const warnDays = config.warnDays ?? 30;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: { accept: "application/rdap+json" },
    });
    const latencyMs = Math.round(performance.now() - start);
    if (res.status === 404) {
      return { status: "down", latencyMs, statusCode: 404, errorMessage: `Домен не найден: ${domain}` };
    }
    if (!res.ok) {
      return { status: "down", latencyMs, statusCode: res.status, errorMessage: `RDAP ${res.status}` };
    }
    const data = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
    const exp = (data.events ?? []).find((e) => e.eventAction === "expiration");
    if (!exp?.eventDate) {
      return { status: "up", latencyMs, errorMessage: "Дата истечения недоступна" };
    }
    const expiry = new Date(exp.eventDate);
    const daysLeft = (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft <= 0) {
      return {
        status: "down",
        latencyMs,
        errorMessage: `Домен истёк ${expiry.toISOString().slice(0, 10)}`,
        sslExpiry: expiry,
      };
    }
    if (daysLeft <= warnDays) {
      return {
        status: "degraded",
        latencyMs,
        errorMessage: `Домен истекает через ${Math.floor(daysLeft)} дн.`,
        sslExpiry: expiry,
      };
    }
    return { status: "up", latencyMs, errorMessage: null, sslExpiry: expiry };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - start),
      errorMessage: describeError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkBlacklist(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const host = parseTarget(raw, 0).host;
  const start = performance.now();
  let ip = host;
  if (net.isIP(host) !== 4) {
    try {
      const a = await dns.lookup(host, { family: 4 });
      ip = a.address;
    } catch {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        errorMessage: `Не удалось разрешить ${host} в IPv4`,
      };
    }
  }
  const zones = config.rblZones && config.rblZones.length > 0 ? config.rblZones : DEFAULT_RBL;
  const rev = ip.split(".").reverse().join(".");
  const listed: string[] = [];
  await Promise.all(
    zones.map(async (z) => {
      try {
        const recs = await dns.resolve4(`${rev}.${z}`);
        // 127.255.255.x are query-error sentinels (e.g. a public/cloud resolver is
        // blocked or over quota), NOT a real listing — ignore them.
        const real = recs.filter((r) => !r.startsWith("127.255.255."));
        if (real.length > 0) listed.push(z);
      } catch {
        /* not listed on this zone */
      }
    })
  );
  const latencyMs = Math.round(performance.now() - start);
  if (listed.length > 0) {
    return { status: "down", latencyMs, errorMessage: `${ip} в чёрных списках: ${listed.join(", ")}` };
  }
  return { status: "up", latencyMs, errorMessage: null };
}

// Generic, secret-free error messages keyed only on the error code — raw driver
// messages embed internal host/port/user and would otherwise be persisted and
// shown on the PUBLIC status page.
function netError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ECONNREFUSED":
      return "Соединение отклонено";
    case "ETIMEDOUT":
      return "Таймаут соединения";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Хост не найден";
    case "ECONNRESET":
      return "Соединение сброшено";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "Хост недоступен";
    default:
      return "Ошибка соединения";
  }
}

function dbError(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === "28P01" || code === "28000" || code === "ER_ACCESS_DENIED_ERROR") {
    return "Ошибка аутентификации";
  }
  if (code === "3D000" || code === "ER_BAD_DB_ERROR") return "База данных не найдена";
  if (code === "42601" || code === "ER_PARSE_ERROR") return "Ошибка проверочного запроса";
  return netError(err);
}

const BLOCKED_MSG = "Адрес заблокирован политикой безопасности";

// All hosts a DB driver could actually dial — including pg's `?host=` / `?hostaddr=`
// query overrides — so the SSRF guard validates what is really connected to.
function dbHostsToValidate(url: string, fallback: string, defaultPort: number): string[] {
  const hosts = new Set<string>();
  try {
    const u = new URL(url);
    if (u.hostname) hosts.add(u.hostname);
    for (const key of ["host", "hostaddr"]) {
      const v = u.searchParams.get(key);
      if (v) hosts.add(v);
    }
  } catch {
    /* not a parseable URL */
  }
  if (hosts.size === 0) hosts.add(parseTarget(fallback, defaultPort).host);
  return [...hosts];
}

async function checkPostgres(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const url = config.dbUrl || raw;
  try {
    for (const h of dbHostsToValidate(url, raw, 5432)) await assertSafeHost(h);
  } catch {
    return { status: "down", latencyMs: 0, errorMessage: BLOCKED_MSG };
  }
  const degraded = config.degradedLatencyMs ?? DEGRADED_LATENCY_MS;
  const start = performance.now();
  const client = new PgClient({
    connectionString: url,
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query(config.dbQuery || "SELECT 1");
    const latencyMs = Math.round(performance.now() - start);
    return { status: latencyMs > degraded ? "degraded" : "up", latencyMs, errorMessage: null };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - start),
      errorMessage: dbError(err),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkMysql(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const url = config.dbUrl || raw;
  try {
    for (const h of dbHostsToValidate(url, raw, 3306)) await assertSafeHost(h);
  } catch {
    return { status: "down", latencyMs: 0, errorMessage: BLOCKED_MSG };
  }
  const degraded = config.degradedLatencyMs ?? DEGRADED_LATENCY_MS;
  const start = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let conn: any = null;
  try {
    const mysql = await import("mysql2/promise");
    conn = await mysql.createConnection(url);
    await conn.query(config.dbQuery || "SELECT 1");
    const latencyMs = Math.round(performance.now() - start);
    return { status: latencyMs > degraded ? "degraded" : "up", latencyMs, errorMessage: null };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - start),
      errorMessage: dbError(err),
    };
  } finally {
    if (conn) await conn.end().catch(() => undefined);
  }
}

async function checkRedis(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const { host, port } = parseTarget(raw, 6379);
  try {
    await assertSafeHost(host);
  } catch {
    return { status: "down", latencyMs: 0, errorMessage: BLOCKED_MSG };
  }
  const degraded = config.degradedLatencyMs ?? DEGRADED_LATENCY_MS;
  const start = performance.now();
  return new Promise<CheckResult>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buf = "";
    // PING first: only send the password AFTER the server proves it speaks Redis
    // (replies -NOAUTH), so a non-Redis / echo host can never reflect the secret.
    let stage: "ping" | "auth" | "ping2" = "ping";
    const finish = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    const up = () =>
      finish({
        status: Math.round(performance.now() - start) > degraded ? "degraded" : "up",
        latencyMs: Math.round(performance.now() - start),
        errorMessage: null,
      });
    const down = (msg: string) =>
      finish({ status: "down", latencyMs: Math.round(performance.now() - start), errorMessage: msg });

    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => socket.write("PING\r\n"));
    socket.on("data", (d) => {
      buf += d.toString();
      if (!buf.includes("\r\n")) return;
      if (stage === "ping") {
        if (buf.startsWith("+PONG")) return up();
        if (/^-NOAUTH/i.test(buf) || /^-ERR.*auth/i.test(buf)) {
          if (config.redisPassword) {
            stage = "auth";
            buf = "";
            socket.write(`AUTH ${config.redisPassword}\r\n`);
          } else {
            down("Требуется аутентификация Redis");
          }
          return;
        }
        return down("Неожиданный ответ Redis");
      }
      if (stage === "auth") {
        if (buf.startsWith("+OK")) {
          stage = "ping2";
          buf = "";
          socket.write("PING\r\n");
        } else {
          down("Ошибка аутентификации Redis");
        }
        return;
      }
      if (buf.startsWith("+PONG")) return up();
      down("Неожиданный ответ Redis");
    });
    socket.once("timeout", () => down("Таймаут соединения"));
    socket.once("error", (err) => down(netError(err)));
    socket.connect(port, host);
  });
}

async function checkSmtp(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const { host, port } = parseTarget(raw, 25);
  try {
    await assertSafeHost(host);
  } catch {
    return { status: "down", latencyMs: 0, errorMessage: BLOCKED_MSG };
  }
  const degraded = config.degradedLatencyMs ?? DEGRADED_LATENCY_MS;
  const start = performance.now();
  return new Promise<CheckResult>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buf = "";
    let stage: "greet" | "ehlo" = "greet";
    const finish = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.write("QUIT\r\n");
      } catch {
        /* ignore */
      }
      socket.destroy();
      resolve(r);
    };
    const down = (msg: string) =>
      finish({ status: "down", latencyMs: Math.round(performance.now() - start), errorMessage: msg });
    socket.setTimeout(TIMEOUT_MS);
    socket.on("data", (d) => {
      buf += d.toString();
      if (stage === "greet") {
        // Wait for the FINAL greeting line ("220 ", not a "220-" continuation).
        if (/(^|\n)220 /.test(buf)) {
          stage = "ehlo";
          buf = "";
          socket.write("EHLO sentela.example\r\n");
        } else if (/(^|\n)[45]\d\d/.test(buf)) {
          down("SMTP: сервер отклонил приветствие");
        }
        return;
      }
      if (/(^|\n)250 /.test(buf)) {
        const latencyMs = Math.round(performance.now() - start);
        finish({ status: latencyMs > degraded ? "degraded" : "up", latencyMs, errorMessage: null });
      } else if (/(^|\n)[45]\d\d/.test(buf)) {
        down("SMTP: EHLO отклонён");
      }
    });
    socket.once("timeout", () => down("Таймаут соединения"));
    socket.once("error", (err) => down(netError(err)));
    socket.connect(port, host);
  });
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

export async function runCheck(monitor: {
  type: string;
  url: string;
  config?: MonitorConfig | null;
}): Promise<CheckResult> {
  const config = monitor.config ?? {};
  switch (monitor.type) {
    case "tcp":
      return checkTcp(monitor.url, config);
    case "dns":
      return checkDns(monitor.url, config);
    case "ssl":
      return checkSsl(monitor.url, config);
    case "ping":
      return checkPing(monitor.url, config);
    case "domain":
      return checkDomain(monitor.url, config);
    case "blacklist":
      return checkBlacklist(monitor.url, config);
    case "postgres":
      return checkPostgres(monitor.url, config);
    case "mysql":
      return checkMysql(monitor.url, config);
    case "redis":
      return checkRedis(monitor.url, config);
    case "smtp":
      return checkSmtp(monitor.url, config);
    case "api":
    case "http":
    default:
      return checkHttpLike(monitor.url, config);
  }
}
