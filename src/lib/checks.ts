import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
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
  /** Override the Host header (CDN routing / fronting). Sent verbatim; SNI still
   *  follows the connected URL host. Forces the Node http(s) path. */
  hostHeader?: string;
  /** Skip TLS certificate verification (curl -k) — for hosts whose cert doesn't
   *  match the connected name (e.g. CDN fronting). Forces the Node http(s) path. */
  insecureTls?: boolean;
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
  // A Host-header override or insecure TLS can't be expressed through fetch (undici
  // forbids the Host header and has no per-request cert-verify toggle) — route those
  // through Node's http(s) module, which gives full header + TLS control.
  if (config.hostHeader || config.insecureTls) {
    return checkViaNode(rawUrl, config);
  }
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

// HTTP/API request via Node's http(s) module — used only when a Host-header
// override or insecure TLS is configured (things fetch can't do). No auto-redirect
// (callers that need a 3xx assert it via expectedStatus anyway).
async function checkViaNode(rawUrl: string, config: MonitorConfig): Promise<CheckResult> {
  const method = (config.method || "GET").toUpperCase();
  const expected = config.expectedStatus;
  const degradedMs = config.degradedLatencyMs ?? DEGRADED_LATENCY_MS;

  let parsed: URL;
  try {
    parsed = new URL(httpUrl(rawUrl));
  } catch {
    return { status: "down", latencyMs: 0, errorMessage: `Некорректный URL: ${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "down", latencyMs: 0, errorMessage: `Неподдерживаемая схема: ${parsed.protocol}` };
  }
  try {
    await assertSafeHost(parsed.hostname);
  } catch (err) {
    return { status: "down", latencyMs: 0, errorMessage: describeError(err) };
  }

  const headers: Record<string, string> = {
    "user-agent": "Sentela-Monitor/1.0 (+https://sentela.example)",
    ...(config.headers ?? {}),
  };
  if (config.hostHeader) headers["host"] = config.hostHeader;

  const start = performance.now();
  // Typed as https options (a superset) so the http branch accepts it too — the
  // TLS fields are simply ignored over plain http.
  const options: https.RequestOptions = {
    method,
    headers,
    servername: parsed.hostname, // SNI tracks the connected host, not the Host header
    rejectUnauthorized: !config.insecureTls,
    timeout: TIMEOUT_MS,
  };

  return new Promise<CheckResult>((resolve) => {
    let settled = false;
    const done = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const onResponse = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        let len = 0;
        res.on("data", (c: Buffer) => {
          len += c.length;
          if (len <= MAX_BODY_BYTES) chunks.push(c);
        });
        res.on("end", () => {
          const latencyMs = Math.round(performance.now() - start);
          const statusCode = res.statusCode ?? 0;
          const statusOk =
            expected && expected.length > 0 ? expected.includes(statusCode) : statusCode < 400;
          if (!statusOk) {
            const note = expected && expected.length > 0 ? `, ожидались: ${expected.join(", ")}` : "";
            done({ status: "down", latencyMs, statusCode, errorMessage: `Код ${statusCode}${note}` });
            return;
          }
          const assertions = config.assertions ?? [];
          if (assertions.length > 0) {
            const headerObj: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              headerObj[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
            }
            const bodyText = Buffer.concat(chunks).toString("utf8");
            const failure = evaluateAssertions(assertions, { statusCode, headers: headerObj, bodyText });
            if (failure) {
              done({ status: "down", latencyMs, statusCode, errorMessage: failure });
              return;
            }
          }
          done({
            status: latencyMs > degradedMs ? "degraded" : "up",
            latencyMs,
            statusCode,
            errorMessage: null,
          });
        });
    };
    const req =
      parsed.protocol === "https:"
        ? https.request(parsed, options, onResponse)
        : http.request(parsed, options, onResponse);
    req.on("timeout", () => {
      req.destroy();
      done({
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        statusCode: null,
        errorMessage: "Таймаут запроса",
      });
    });
    req.on("error", (err) => {
      done({
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        statusCode: null,
        errorMessage: describeError(err),
      });
    });
    if (config.body && BODY_METHODS.has(method)) req.write(config.body);
    req.end();
  });
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
  let result = await sslHandshake(host, port, config);
  // One retry on a "down" smooths transient TLS timeouts / resets on healthy hosts
  // (common when many monitors run at once). A genuinely expired cert or an
  // unreachable host stays "down" on the second attempt too.
  if (result.status === "down") {
    result = await sslHandshake(host, port, config);
  }
  return result;
}

function sslHandshake(
  host: string,
  port: number,
  config: MonitorConfig
): Promise<CheckResult> {
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

// ── Domain registration expiry ──────────────────────────────────────────────
// The expiry date lives only at the registry, so SOME external query is
// unavoidable — but we go DIRECT, no rdap.org middleman: RDAP via the IANA
// bootstrap for TLDs that support it, else WHOIS on port 43 (covers ccTLDs like
// .ru, which have no RDAP). Results are cached so registry servers are queried
// rarely; per-check liveness comes from cheap DNS delegation instead.
const EXPIRY_TTL_OK_MS = 12 * 60 * 60 * 1000; // re-check a known expiry every 12h
const EXPIRY_TTL_FAIL_MS = 60 * 60 * 1000; // retry an unknown expiry every 1h
const RDAP_BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

const domainExpiryCache = new Map<string, { expiry: Date | null; at: number }>();
const whoisServerCache = new Map<string, string | null>();
let rdapBootstrap: { at: number; map: Map<string, string> } | null = null;

/** Reject `p` if it doesn't settle within `ms` (used to bound DNS lookups). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  // Swallow a late rejection if the timeout wins the race, so `p` settling after
  // doesn't surface as an unhandled rejection.
  p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => {
    if (t) clearTimeout(t);
  });
}

function tldOf(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

async function checkDomain(raw: string, config: MonitorConfig = {}): Promise<CheckResult> {
  const domain = parseTarget(raw, 0).host;
  const warnDays = config.warnDays ?? 30;
  const start = performance.now();

  // Liveness: is the domain still delegated? DNS is cheap and not rate-limited, so
  // it's the per-check signal — NXDOMAIN means gone, a transient error is ignored.
  try {
    const ns = await withTimeout(dns.resolveNs(domain), TIMEOUT_MS, "DNS NS timed out");
    if (ns.length === 0) {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        errorMessage: `Домен не делегирован: ${domain}`,
      };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const latencyMs = Math.round(performance.now() - start);
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { status: "down", latencyMs, errorMessage: `Домен не делегирован: ${domain}` };
    }
    return { status: "up", latencyMs, errorMessage: `DNS временно недоступен (${describeError(err)})` };
  }

  // Live — enrich with the registration expiry (cached; fetched rarely).
  const expiry = await getDomainExpiry(domain).catch(() => null);
  const latencyMs = Math.round(performance.now() - start);
  if (!expiry) {
    return { status: "up", latencyMs, errorMessage: "Срок истечения не определён" };
  }
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
}

/** Registration expiry from the registry, cached. Direct RDAP first, then WHOIS. */
async function getDomainExpiry(domain: string): Promise<Date | null> {
  const key = domain.toLowerCase();
  const cached = domainExpiryCache.get(key);
  if (cached) {
    const ttl = cached.expiry ? EXPIRY_TTL_OK_MS : EXPIRY_TTL_FAIL_MS;
    if (Date.now() - cached.at < ttl) return cached.expiry;
  }
  let expiry: Date | null = null;
  try {
    expiry = await rdapDirectExpiry(key);
  } catch {
    /* fall through to WHOIS */
  }
  if (!expiry) {
    try {
      expiry = await whoisExpiry(key);
    } catch {
      /* leave null — DNS already confirmed the domain is live */
    }
  }
  domainExpiryCache.set(key, { expiry, at: Date.now() });
  return expiry;
}

/** Authoritative RDAP base URL for a TLD via the cached IANA bootstrap registry. */
async function rdapBaseForTld(tld: string): Promise<string | null> {
  if (!rdapBootstrap || Date.now() - rdapBootstrap.at > RDAP_BOOTSTRAP_TTL_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch("https://data.iana.org/rdap/dns.json", { signal: controller.signal });
      if (!res.ok) throw new Error(`bootstrap ${res.status}`);
      const data = (await res.json()) as { services?: [string[], string[]][] };
      const map = new Map<string, string>();
      for (const [tlds, urls] of data.services ?? []) {
        const base = urls.find((u) => u.startsWith("https://")) ?? urls[0];
        if (!base) continue;
        for (const t of tlds) map.set(t.toLowerCase(), base.replace(/\/+$/, ""));
      }
      rdapBootstrap = { at: Date.now(), map };
    } finally {
      clearTimeout(timer);
    }
  }
  return rdapBootstrap?.map.get(tld) ?? null;
}

async function rdapDirectExpiry(domain: string): Promise<Date | null> {
  const base = await rdapBaseForTld(tldOf(domain));
  if (!base) return null; // TLD has no RDAP (e.g. .ru) — WHOIS will handle it
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/domain/${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: { accept: "application/rdap+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
    const exp = (data.events ?? []).find((e) => e.eventAction === "expiration");
    if (!exp?.eventDate) return null;
    const d = new Date(exp.eventDate);
    return isNaN(d.getTime()) ? null : d;
  } finally {
    clearTimeout(timer);
  }
}

// WHOIS field names that carry the expiry date — formats differ per registry.
const WHOIS_EXPIRY_FIELDS = new Set([
  "paid-till", // .ru / .su / .рф
  "registry expiry date",
  "registrar registration expiration date",
  "expiry date",
  "expiration date",
  "expiration time",
  "expire",
  "expires",
  "renewal date",
]);

function parseWhoisExpiry(text: string): Date | null {
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    if (!WHOIS_EXPIRY_FIELDS.has(key)) continue;
    const d = new Date(line.slice(idx + 1).trim());
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/** Registry WHOIS server for a TLD (discovered via whois.iana.org), cached. */
async function whoisServerForTld(tld: string): Promise<string | null> {
  if (whoisServerCache.has(tld)) return whoisServerCache.get(tld) ?? null;
  let server: string | null = null;
  try {
    const text = await whoisQuery("whois.iana.org", tld);
    const m = text.match(/^whois:\s*(\S+)/im);
    server = m ? m[1] : null;
  } catch {
    server = null;
  }
  whoisServerCache.set(tld, server);
  return server;
}

async function whoisExpiry(domain: string): Promise<Date | null> {
  const server = await whoisServerForTld(tldOf(domain));
  if (!server) return null;
  return parseWhoisExpiry(await whoisQuery(server, domain));
}

/** Minimal WHOIS (RFC 3912): connect to <server>:43, send the query, read reply. */
async function whoisQuery(server: string, query: string): Promise<string> {
  await assertSafeHost(server); // server comes from IANA, but keep the SSRF guard
  return new Promise<string>((resolve, reject) => {
    const socket = new net.Socket();
    let buf = "";
    let settled = false;
    const done = (err: Error | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(buf);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => socket.write(`${query}\r\n`));
    socket.on("data", (d) => {
      buf += d.toString();
      if (buf.length > MAX_BODY_BYTES) done(null); // cap, use what we have
    });
    socket.once("end", () => done(null));
    socket.once("timeout", () => done(new Error("WHOIS timed out")));
    socket.once("error", (err) => done(err));
    socket.connect(43, server);
  });
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

// ── Response-time waterfall ─────────────────────────────────────────────────
// Per-phase timing breakdown of a single HTTP(S) request, captured from the raw
// socket lifecycle (fetch/undici doesn't expose these). Used by the live monitor
// panel to draw a real-time waterfall — it does NOT run in the normal worker loop
// and its result is never persisted (a live-only, ephemeral measurement).
export interface HttpTiming {
  /** DNS resolution. */
  dnsMs: number;
  /** TCP connect (SYN→ACK). */
  connectMs: number;
  /** TLS handshake (0 for plain http). */
  tlsMs: number;
  /** Time to first byte (request sent → response headers). */
  ttfbMs: number;
  /** Body download (first byte → last byte). */
  downloadMs: number;
  /** Wall-clock total. */
  totalMs: number;
}

export interface TimedResult {
  timing: HttpTiming;
  statusCode: number | null;
  errorMessage: string | null;
}

const ZERO_TIMING: HttpTiming = {
  dnsMs: 0,
  connectMs: 0,
  tlsMs: 0,
  ttfbMs: 0,
  downloadMs: 0,
  totalMs: 0,
};

/** Measure the phase-by-phase timing of one HTTP(S) request. Never throws. */
export async function measureHttpTiming(
  rawUrl: string,
  config: MonitorConfig = {}
): Promise<TimedResult> {
  let parsed: URL;
  try {
    parsed = new URL(httpUrl(rawUrl));
  } catch {
    return { timing: ZERO_TIMING, statusCode: null, errorMessage: `Некорректный URL: ${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      timing: ZERO_TIMING,
      statusCode: null,
      errorMessage: `Неподдерживаемая схема: ${parsed.protocol}`,
    };
  }
  try {
    await assertSafeHost(parsed.hostname);
  } catch (err) {
    return { timing: ZERO_TIMING, statusCode: null, errorMessage: describeError(err) };
  }

  const isHttps = parsed.protocol === "https:";
  const method = (config.method || "GET").toUpperCase();
  const headers: Record<string, string> = {
    "user-agent": "Sentela-Monitor/1.0 (+https://sentela.example)",
    ...(config.headers ?? {}),
  };
  if (config.hostHeader) headers["host"] = config.hostHeader;

  const options: https.RequestOptions = {
    method,
    headers,
    servername: parsed.hostname,
    rejectUnauthorized: !config.insecureTls,
    timeout: TIMEOUT_MS,
    // Force a fresh, non-pooled socket every call: keep-alive reuse would skip
    // the lookup/connect/secureConnect events and collapse DNS/TCP/TLS to 0 on
    // repeated probes. A cold connection is also the correct thing to measure.
    agent: false,
  };

  const clamp = (n: number): number => Math.max(0, Math.round(n));

  return new Promise<TimedResult>((resolve) => {
    const t0 = performance.now();
    let tDns = 0;
    let tConnect = 0;
    let tTls = 0;
    let tTtfb = 0;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const finish = (r: TimedResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(r);
    };
    const fail = (msg: string) =>
      finish({
        timing: { ...ZERO_TIMING, totalMs: clamp(performance.now() - t0) },
        statusCode: null,
        errorMessage: msg,
      });

    const requestFn = isHttps ? https.request : http.request;
    const req = requestFn(parsed, options, (res) => {
      tTtfb = performance.now();
      res.on("data", () => {
        /* drain so 'end' fires and the socket closes */
      });
      res.once("end", () => {
        const end = performance.now();
        // Connect phase ends at TLS start (https) or at the connect event (http).
        const connectEnd = isHttps && tTls ? tTls : tConnect;
        const timing: HttpTiming = {
          dnsMs: clamp((tDns || t0) - t0),
          connectMs: clamp(tConnect - (tDns || t0)),
          tlsMs: isHttps && tTls ? clamp(tTls - tConnect) : 0,
          ttfbMs: clamp(tTtfb - (connectEnd || tConnect || t0)),
          downloadMs: clamp(end - tTtfb),
          totalMs: clamp(end - t0),
        };
        finish({ timing, statusCode: res.statusCode ?? null, errorMessage: null });
      });
    });

    // Absolute deadline: the `timeout` option only fires on socket IDLE, so a
    // response that trickles bytes forever would never time out on its own.
    deadline = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      fail("Таймаут запроса");
    }, TIMEOUT_MS);

    req.on("socket", (socket) => {
      socket.once("lookup", () => {
        if (!tDns) tDns = performance.now();
      });
      socket.once("connect", () => {
        if (!tConnect) tConnect = performance.now();
      });
      socket.once("secureConnect", () => {
        if (!tTls) tTls = performance.now();
      });
    });
    req.on("timeout", () => {
      req.destroy();
      fail("Таймаут запроса");
    });
    req.on("error", (err) => fail(describeError(err)));

    if (config.body && BODY_METHODS.has(method)) req.write(config.body);
    req.end();
  });
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
