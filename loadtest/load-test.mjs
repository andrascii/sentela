#!/usr/bin/env node
/**
 * Sentela realistic load generator.
 *
 * Drives REAL traffic against a Sentela deployment (origin or a CDN-fronted
 * domain) so you can compare how different CDNs behave under load before you
 * send real users at the site. It exercises the actual endpoints that exist on
 * the site — anonymous page loads with their /_next/static assets, authenticated
 * dashboard navigations (RSC fetches), the /realtime WebSocket, and a trickle of
 * real POSTs — and regulates itself to a target bandwidth (Mbit/s) that follows
 * a configurable time-of-day curve (lower in the morning, higher midday, peak in
 * the evening).
 *
 * Design goals:
 *   - Faithful: hits the same URLs/subrequests a browser does (see ENDPOINTS).
 *   - Self-pacing: a closed-loop controller adjusts offered load to hit the
 *     target Mbit/s for the current hour. No fixed RPS guesswork.
 *   - Safe for YOUR origin: logins are bcrypt-bound, so they're capped and cookies
 *     are reused (a real browser logs in once). Register/heartbeat default OFF.
 *     An ALLOWED_HOSTS allowlist stops you pointing it at someone else's domain.
 *   - Days-long stable: fixed-memory histograms, bounded WS pool, error handling
 *     that logs-and-continues, graceful shutdown, JSONL metrics for offline graphs.
 *
 * No build step, one dependency (`ws`). Run with: node load-test.mjs
 * Configure entirely via environment variables (see config.example.env / README).
 *
 *   MODE=smoke node load-test.mjs     # one functional pass per target, then exit
 *   MODE=schedule node load-test.mjs  # print the 24h Mbit/s curve and exit
 *   node load-test.mjs                # run the load test (default)
 */

import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const env = process.env;
const str = (k, d) => (env[k] != null && env[k] !== "" ? env[k] : d);
const num = (k, d) => {
  const v = env[k];
  if (v == null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d) => {
  const v = env[k];
  if (v == null || v === "") return d;
  return /^(1|true|yes|on)$/i.test(v);
};
const list = (k, d = []) => {
  const parts = str(k, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : d;
};

// Default time-of-day curve (0..1): deep-night low, morning rising, midday mid,
// evening peak (~20:00), late-night taper. Honors "mornings lower, day more,
// evening even more". 24 values, one per hour. Defined before CONFIG because the
// CONFIG initializer calls parseDiurnal(), which falls back to this.
const DEFAULT_DIURNAL = [
  0.18, 0.12, 0.06, 0.04, 0.05, 0.1, // 00..05
  0.16, 0.22, 0.28, 0.34, 0.42, 0.5, // 06..11
  0.55, 0.58, 0.56, 0.54, 0.58, 0.66, // 12..17
  0.78, 0.9, 1.0, 0.92, 0.7, 0.4, // 18..23
];

const MODE = str("MODE", "run"); // run | smoke | schedule

const CONFIG = {
  targets: list("TARGETS", ["https://top661743905.mwscdn.ru"]),

  // Bandwidth band (Mbit/s) PER TARGET. The diurnal curve sweeps between these.
  minMbps: num("MIN_MBPS", 50),
  maxMbps: num("MAX_MBPS", 150),
  jitter: num("JITTER", 0.08), // ±8% random wobble on the target each tick
  warmupSec: num("WARMUP_SEC", 60), // ease load in instead of slamming from 0

  // Time-of-day. If TZ_OFFSET_HOURS is set, hour is computed as UTC+offset;
  // otherwise the test server's local time is used. DIURNAL is an optional
  // 24-value comma list of 0..1 multipliers (one per hour); defaults below.
  tzOffsetHours: env.TZ_OFFSET_HOURS != null && env.TZ_OFFSET_HOURS !== ""
    ? Number(env.TZ_OFFSET_HOURS)
    : null,
  diurnal: parseDiurnal(str("DIURNAL", "")),

  // Auth / accounts. "email:pass,email2:pass2". Needed for dashboard + WebSocket.
  accounts: parseAccounts(str("TEST_ACCOUNTS", "")),
  authFraction: num("AUTH_FRACTION", 0.2), // share of visits that are logged-in users
  loginRefreshSec: num("LOGIN_REFRESH_SEC", 3600), // reuse a cookie this long

  // WebSocket pool (steady concurrent connections), per target. 0 disables.
  wsTarget: num("WS_TARGET", 40),
  wsHoldSec: num("WS_HOLD_SEC", 300), // hold a connection this long, then recycle
  wsPath: str("WS_PATH", "/realtime"),

  // Optional explicit POST coverage of the login path WITHOUT bcrypt cost:
  // logins with random non-existent emails return 401 fast (no password hash to
  // verify). Tests CDN POST passthrough under load without burning origin CPU.
  postProbeRps: num("POST_PROBE_RPS", 0),

  // Heartbeat pings (writes to DB). OFF unless you provide real tokens.
  heartbeatTokens: list("HEARTBEAT_TOKENS", []),
  heartbeatRps: num("HEARTBEAT_RPS", 0),

  // Real ids to make authed traffic faithful (optional but recommended).
  monitorIds: list("MONITOR_IDS", []), // e.g. "12,15,18" → /dashboard/monitors/<id>
  statusProjects: list("STATUS_PROJECTS", []), // public /status/<slug> pages

  // Limits / safety.
  maxConcurrency: num("MAX_CONCURRENCY", 400), // max simultaneous in-flight visits per target
  maxSockets: num("MAX_SOCKETS", 256), // keep-alive socket pool per target
  maxAssetsPerVisit: num("MAX_ASSETS_PER_VISIT", 64),
  requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 15000),
  thinkMinMs: num("THINK_MIN_MS", 400),
  thinkMaxMs: num("THINK_MAX_MS", 2500),
  allowedHosts: list("ALLOWED_HOSTS", []), // if set, every host must match
  insecureTLS: bool("INSECURE_TLS", false),

  // Output.
  metricsIntervalSec: num("METRICS_INTERVAL_SEC", 10),
  logDir: str("LOG_DIR", "./logs"),
  durationSec: num("DURATION_SEC", 0), // 0 = run until stopped
  stopFile: str("STOP_FILE", "./STOP"), // touch this file to drain & exit
  verbose: bool("VERBOSE", false),
};

// Controller gain — how aggressively offered load chases the target bandwidth.
const KP = 0.35;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
];

// Weighted page mixes. Anonymous traffic is the bulk (what ads bring).
const ANON_PAGES = [
  ["/", 40],
  ["/pricing", 15],
  ["/login", 12],
  ["/about", 8],
  ["/register", 7],
  ["/contacts", 4],
  ["/terms", 3],
  ["/privacy", 3],
  ["__status__", 8], // resolved to /status/<slug> if STATUS_PROJECTS given
];
const AUTHED_PAGES = [
  ["/dashboard", 45],
  ["/dashboard/incidents", 15],
  ["/dashboard/monitors/new", 10],
  ["/dashboard/billing", 8],
  ["/dashboard/team", 7],
  ["__monitor__", 15], // resolved to /dashboard/monitors/<id> if MONITOR_IDS given
];

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────────

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function weightedPick(pairs) {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

function parseAccounts(s) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(":");
      if (i < 0) return null;
      return { email: pair.slice(0, i), password: pair.slice(i + 1) };
    })
    .filter(Boolean);
}

function parseDiurnal(s) {
  if (!s) return DEFAULT_DIURNAL;
  const vals = s.split(",").map((x) => Number(x.trim()));
  if (vals.length !== 24 || vals.some((v) => !Number.isFinite(v))) {
    console.error("[config] DIURNAL must be 24 numeric values; using default curve.");
    return DEFAULT_DIURNAL;
  }
  return vals;
}

// Fixed-bucket latency histogram — O(1) memory, reset each interval.
const BUCKETS = [
  5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000,
  5000, 10000, Infinity,
];
class Histogram {
  constructor() {
    this.reset();
  }
  reset() {
    this.counts = new Array(BUCKETS.length).fill(0);
    this.n = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = 0;
  }
  record(v) {
    this.n++;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    for (let i = 0; i < BUCKETS.length; i++) {
      if (v <= BUCKETS[i]) {
        this.counts[i]++;
        return;
      }
    }
  }
  pct(p) {
    if (this.n === 0) return 0;
    const target = p * this.n;
    let cum = 0;
    for (let i = 0; i < BUCKETS.length; i++) {
      cum += this.counts[i];
      if (cum >= target) return BUCKETS[i] === Infinity ? this.max : BUCKETS[i];
    }
    return this.max;
  }
  get avg() {
    return this.n ? this.sum / this.n : 0;
  }
}

function classifyError(e) {
  const c = (e && (e.code || e.message)) || "";
  if (/timeout|ETIMEDOUT/i.test(c)) return "timeout";
  if (/ECONNRESET|socket hang up/i.test(c)) return "reset";
  if (/ECONNREFUSED/i.test(c)) return "refused";
  if (/ENOTFOUND|EAI_AGAIN/i.test(c)) return "dns";
  if (/CERT|TLS|SSL|altname|self.signed/i.test(c)) return "tls";
  return "other";
}

function cacheStatusFrom(headers) {
  if (!headers) return "unknown";
  const h = (k) => headers[k];
  const x =
    h("x-cache-status") || h("x-cache") || h("cf-cache-status") || h("x-mwscdn-cache");
  if (x) {
    if (/hit/i.test(x)) return "hit";
    if (/miss|expired|bypass/i.test(x)) return "miss";
  }
  const age = Number(h("age"));
  if (Number.isFinite(age) && age > 0) return "hit";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP request with byte accounting (counts wire/compressed body bytes)
// ─────────────────────────────────────────────────────────────────────────────

function approxHeaderBytes(res) {
  let n = 20; // status line-ish
  const raw = res.rawHeaders || [];
  for (const s of raw) n += s.length + 2;
  return n;
}

/**
 * Perform one HTTP request. Resolves to a result object (never rejects). Counts
 * received bytes into the runner and records latency/status/cache. `wantBody`
 * returns the decoded text body (only used for the HTML page that we parse for
 * assets — assets themselves are streamed and discarded to save memory).
 */
function httpRequest(runner, { method = "GET", url, headers = {}, body = null, klass = "page", wantBody = false }) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      runner.recordError(klass, new Error("badurl"));
      resolve({ ok: false, err: "badurl" });
      return;
    }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const agent = isHttps ? runner.httpsAgent : runner.httpAgent;

    const reqHeaders = {
      "user-agent": runner.ua,
      accept:
        klass === "page"
          ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          : "*/*",
      "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      "accept-encoding": "gzip, deflate, br",
      ...headers,
    };
    if (body != null) {
      reqHeaders["content-length"] = Buffer.byteLength(body);
    }

    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: reqHeaders,
      agent,
      servername: u.hostname,
    };

    const start = now();
    let settled = false;
    let ttfb = null;
    let bytes = 0;
    const chunks = wantBody ? [] : null;

    // Hard wall-clock backstop: req.setTimeout only arms once a socket is
    // assigned, so a request stuck waiting for a free socket (pool exhausted)
    // could otherwise leak its promise forever. This guarantees `done` always
    // runs and `inflight` is released, even in that case.
    const deadline = setTimeout(() => {
      try {
        req.destroy(Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }));
      } catch {
        /* ignore */
      }
      runner.recordError(klass, new Error("deadline"));
      done({ ok: false, err: "timeout" });
    }, CONFIG.requestTimeoutMs + 5000);

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const req = mod.request(opts, (res) => {
      const status = res.statusCode || 0;
      bytes += approxHeaderBytes(res);
      res.on("data", (chunk) => {
        if (ttfb === null) ttfb = now() - start;
        bytes += chunk.length;
        if (chunks) chunks.push(chunk);
      });
      res.on("end", () => {
        const dur = now() - start;
        runner.recordBytes(bytes);
        runner.recordReq(klass, dur, ttfb ?? dur, status, res.headers);
        let text = null;
        if (chunks) {
          try {
            text = decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]);
          } catch {
            text = null;
          }
        }
        done({ ok: true, status, bytes, dur, headers: res.headers, body: text });
      });
      res.on("error", (e) => {
        runner.recordError(klass, e);
        done({ ok: false, err: classifyError(e) });
      });
    });

    req.setTimeout(CONFIG.requestTimeoutMs, () => {
      req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    req.on("error", (e) => {
      runner.recordError(klass, e);
      done({ ok: false, err: classifyError(e) });
    });
    if (body != null) req.write(body);
    req.end();
  });
}

let zlib = null;
function decodeBody(buf, enc) {
  if (!enc) return buf.toString("utf8");
  if (!zlib) zlib = require("node:zlib");
  try {
    if (/\bbr\b/.test(enc)) return zlib.brotliDecompressSync(buf).toString("utf8");
    if (/\bgzip\b/.test(enc)) return zlib.gunzipSync(buf).toString("utf8");
    if (/\bdeflate\b/.test(enc)) return zlib.inflateSync(buf).toString("utf8");
  } catch {
    return buf.toString("utf8");
  }
  return buf.toString("utf8");
}
// `require` shim for ESM (only used lazily for zlib above).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// Asset extraction (parse a page like a browser would)
// ─────────────────────────────────────────────────────────────────────────────

function extractAssets(html, base) {
  if (!html) return [];
  const urls = new Set();
  const add = (raw) => {
    if (!raw) return;
    try {
      const abs = new URL(raw, base);
      // Same-origin static-ish resources only.
      if (abs.host !== new URL(base).host) return;
      if (/\.(js|mjs|css|woff2?|ttf|png|jpe?g|svg|webp|gif|ico|avif)(\?|$)/i.test(abs.pathname) ||
          abs.pathname.startsWith("/_next/static/")) {
        urls.add(abs.toString());
      }
    } catch {
      /* ignore */
    }
  };
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && urls.size < CONFIG.maxAssetsPerVisit * 2) add(m[1]);
  // Next.js also references chunks inside inline scripts.
  const re2 = /["'](\/_next\/static\/[^"']+?\.(?:js|css))["']/gi;
  while ((m = re2.exec(html)) && urls.size < CONFIG.maxAssetsPerVisit * 2) add(m[1]);
  return [...urls].slice(0, CONFIG.maxAssetsPerVisit);
}

async function fetchInPool(runner, urls, klass, concurrency = 6) {
  let i = 0;
  const worker = async () => {
    while (i < urls.length && runner.running) {
      const idx = i++;
      await httpRequest(runner, { url: urls[idx], klass });
    }
  };
  const n = Math.min(concurrency, urls.length);
  await Promise.all(Array.from({ length: n }, worker));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-target runner
// ─────────────────────────────────────────────────────────────────────────────

class TargetRunner {
  constructor(base) {
    this.base = base.replace(/\/+$/, "");
    this.host = new URL(this.base).host;
    this.ua = pick(USER_AGENTS);
    this.running = true;

    const agentOpts = {
      keepAlive: true,
      maxSockets: CONFIG.maxSockets,
      maxFreeSockets: Math.ceil(CONFIG.maxSockets / 4),
      timeout: CONFIG.requestTimeoutMs,
    };
    this.httpsAgent = new https.Agent({ ...agentOpts, rejectUnauthorized: !CONFIG.insecureTLS });
    this.httpAgent = new http.Agent(agentOpts);

    // Controller state.
    this.arrivalRate = 1; // visits per second (tuned by controller)
    this.inflight = 0;
    this.saturated = false;
    this.startedAt = Date.now();

    // Bandwidth window (last ~5s of per-second byte counts).
    this.byteRing = new Array(5).fill(0);
    this.byteRingIdx = 0;
    this.byteRingFilled = 0;
    this.bytesThisSecond = 0;

    // Cookie pool: account email -> { cookie, ts } | "pending".
    this.cookies = new Map();

    // WebSocket pool.
    this.ws = new Set();
    this.wsPending = 0;
    this.wsFailStreak = 0;

    this.resetMetrics();
  }

  resetMetrics() {
    this.m = {
      bytes: 0,
      reqByClass: {}, // klass -> { hist, ttfb, n, statuses:{2,3,4,5}, cache:{hit,miss,unknown} }
      errors: {}, // type -> n
      ws: { connectAttempt: 0, connectOk: 0, connectFail: 0, connectLat: new Histogram(), msgs: 0, bytes: 0, closedUnexpected: 0 },
    };
  }

  classBucket(klass) {
    let b = this.m.reqByClass[klass];
    if (!b) {
      b = {
        hist: new Histogram(),
        ttfb: new Histogram(),
        n: 0,
        statuses: { 2: 0, 3: 0, 4: 0, 5: 0, 0: 0 },
        cache: { hit: 0, miss: 0, unknown: 0 },
      };
      this.m.reqByClass[klass] = b;
    }
    return b;
  }

  recordBytes(n) {
    this.m.bytes += n;
    this.bytesThisSecond += n;
  }
  recordReq(klass, dur, ttfb, status, headers) {
    const b = this.classBucket(klass);
    b.hist.record(dur);
    b.ttfb.record(ttfb);
    b.n++;
    const cls = status >= 500 ? 5 : status >= 400 ? 4 : status >= 300 ? 3 : status >= 200 ? 2 : 0;
    b.statuses[cls]++;
    b.cache[cacheStatusFrom(headers)]++;
  }
  recordError(klass, e) {
    const t = classifyError(e);
    this.m.errors[t] = (this.m.errors[t] || 0) + 1;
    if (CONFIG.verbose) console.error(`[${this.host}] ${klass} error: ${e.code || e.message}`);
  }

  // Live bandwidth estimate (Mbit/s) over the sliding window. Divides by the
  // number of seconds actually recorded so the first few seconds after start
  // aren't underestimated (which would make the controller overshoot).
  currentMbps() {
    const filled = Math.max(1, this.byteRingFilled);
    let bytes = 0;
    for (let i = 0; i < filled; i++) bytes += this.byteRing[i];
    return (bytes * 8) / 1e6 / filled;
  }

  tickBandwidthWindow() {
    this.byteRing[this.byteRingIdx] = this.bytesThisSecond;
    this.byteRingIdx = (this.byteRingIdx + 1) % this.byteRing.length;
    if (this.byteRingFilled < this.byteRing.length) this.byteRingFilled++;
    this.bytesThisSecond = 0;
  }

  // ── cookies ────────────────────────────────────────────────────────────────
  async getCookie() {
    if (CONFIG.accounts.length === 0) return null;
    const acct = pick(CONFIG.accounts);
    const cached = this.cookies.get(acct.email);
    if (cached && cached !== "pending") {
      if (cached.cookie && Date.now() - cached.ts < CONFIG.loginRefreshSec * 1000) {
        return cached.cookie;
      }
      // Back off after a failed login so bad credentials can't hammer bcrypt
      // on the origin for days. Exponential, capped at 60s.
      if (cached.cookie == null && cached.failedAt != null) {
        const wait = Math.min(60000, Math.pow(2, cached.failures) * 250);
        if (Date.now() - cached.failedAt < wait) return null;
      }
    }
    if (cached === "pending") return null; // a login is already underway
    this.cookies.set(acct.email, "pending");
    const cookie = await this.login(acct.email, acct.password);
    if (cookie) {
      this.cookies.set(acct.email, { cookie, ts: Date.now(), failures: 0 });
    } else {
      const failures = (cached && cached.failures) || 0;
      this.cookies.set(acct.email, { cookie: null, failedAt: Date.now(), failures: failures + 1 });
    }
    return cookie;
  }

  // Invalidate the account a cookie belongs to (called when an authed request
  // unexpectedly returns 401/redirect) so the next visit re-logs-in. Uses the
  // failure path so the re-login is rate-limited.
  invalidateCookie(cookieStr) {
    for (const [email, v] of this.cookies) {
      if (v && v !== "pending" && v.cookie === cookieStr) {
        this.cookies.set(email, { cookie: null, failedAt: Date.now(), failures: (v.failures || 0) + 1 });
        return;
      }
    }
  }

  // An authed response that came back 401/403 or a redirect (to /login) means
  // the session wasn't accepted — we're no longer on the authenticated path.
  looksUnauthed(res) {
    if (!res || !res.ok) return false;
    return res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400);
  }

  async login(email, password) {
    const res = await this.rawRequest({
      method: "POST",
      url: `${this.base}/api/auth/login`,
      headers: { "content-type": "application/json", origin: this.base, accept: "application/json" },
      body: JSON.stringify({ email, password }),
      klass: "api-login",
    });
    if (!res.ok || res.status !== 200) return null;
    const sc = res.setCookie || [];
    const parts = [];
    for (const c of sc) {
      const kv = c.split(";")[0];
      if (/^(ip_session|ip_team)=/.test(kv)) parts.push(kv);
    }
    return parts.length ? parts.join("; ") : null;
  }

  // Like httpRequest but also surfaces set-cookie (used for login).
  rawRequest({ method, url, headers, body, klass }) {
    return new Promise((resolve) => {
      let u;
      try {
        u = new URL(url);
      } catch {
        resolve({ ok: false });
        return;
      }
      const isHttps = u.protocol === "https:";
      const mod = isHttps ? https : http;
      const agent = isHttps ? this.httpsAgent : this.httpAgent;
      const reqHeaders = {
        "user-agent": this.ua,
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        ...headers,
      };
      if (body != null) reqHeaders["content-length"] = Buffer.byteLength(body);
      const start = now();
      let settled = false;
      let bytes = 0;
      const deadline = setTimeout(() => {
        try {
          req.destroy(Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }));
        } catch {
          /* ignore */
        }
        this.recordError(klass, new Error("deadline"));
        done({ ok: false });
      }, CONFIG.requestTimeoutMs + 5000);
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(r);
      };
      const req = mod.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          headers: reqHeaders,
          agent,
          servername: u.hostname,
        },
        (res) => {
          bytes += approxHeaderBytes(res);
          res.on("data", (c) => (bytes += c.length));
          res.on("end", () => {
            this.recordBytes(bytes);
            this.recordReq(klass, now() - start, now() - start, res.statusCode || 0, res.headers);
            done({ ok: true, status: res.statusCode || 0, setCookie: res.headers["set-cookie"], headers: res.headers });
          });
          res.on("error", (e) => {
            this.recordError(klass, e);
            done({ ok: false });
          });
        }
      );
      req.setTimeout(CONFIG.requestTimeoutMs, () =>
        req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      );
      req.on("error", (e) => {
        this.recordError(klass, e);
        done({ ok: false });
      });
      if (body != null) req.write(body);
      req.end();
    });
  }

  // ── one realistic visit ─────────────────────────────────────────────────────
  async runVisit() {
    this.inflight++;
    try {
      const authed = CONFIG.accounts.length > 0 && Math.random() < CONFIG.authFraction;
      let cookie = null;
      if (authed) cookie = await this.getCookie();

      const pagePath = this.choosePage(!!cookie);
      const pageHeaders = cookie ? { cookie } : {};
      const pageRes = await httpRequest(this, {
        url: this.base + pagePath,
        headers: pageHeaders,
        klass: "page",
        wantBody: true,
      });

      // If a cookie went stale (server restart, account change, expiry), an
      // authed page silently 401s or redirects to /login — which means we'd be
      // measuring the WRONG path. Detect it and force a re-login next visit.
      if (cookie && this.looksUnauthed(pageRes)) {
        this.invalidateCookie(cookie);
        cookie = null;
      }

      // Pull the page's static assets, like a fresh visitor's browser.
      if (pageRes.ok && pageRes.body) {
        const assets = extractAssets(pageRes.body, this.base + pagePath);
        if (assets.length) await fetchInPool(this, assets, "asset");
      }

      // Authenticated users navigate client-side → RSC fetches.
      if (cookie) {
        const hops = randInt(1, 3);
        for (let i = 0; i < hops && this.running; i++) {
          const to = this.choosePage(true);
          const sep = to.includes("?") ? "&" : "?";
          const rsc = await httpRequest(this, {
            url: `${this.base}${to}${sep}_rsc=${Math.random().toString(36).slice(2, 8)}`,
            headers: { cookie, RSC: "1", "Next-Router-Prefetch": "1" },
            klass: "rsc",
          });
          if (this.looksUnauthed(rsc)) {
            this.invalidateCookie(cookie);
            break;
          }
          await sleep(rand(CONFIG.thinkMinMs, CONFIG.thinkMaxMs));
        }
      }

      // Brief think time before the visit ends.
      await sleep(rand(CONFIG.thinkMinMs, CONFIG.thinkMaxMs));
    } catch (e) {
      this.recordError("visit", e);
    } finally {
      this.inflight--;
    }
  }

  choosePage(authed) {
    const set = authed ? AUTHED_PAGES : ANON_PAGES;
    let p = weightedPick(set);
    if (p === "__status__") {
      p = CONFIG.statusProjects.length ? `/status/${pick(CONFIG.statusProjects)}` : "/pricing";
    } else if (p === "__monitor__") {
      p = CONFIG.monitorIds.length ? `/dashboard/monitors/${pick(CONFIG.monitorIds)}` : "/dashboard";
    }
    return p;
  }

  // ── WebSocket pool ───────────────────────────────────────────────────────────
  topUpWebSockets() {
    if (CONFIG.wsTarget <= 0 || CONFIG.accounts.length === 0 || !this.running) return;
    const need = CONFIG.wsTarget - this.ws.size - this.wsPending;
    // Back off if connects are failing in a streak (e.g. origin/CDN refusing).
    const budget = this.wsFailStreak > 5 ? 1 : Math.min(need, 10);
    for (let i = 0; i < budget; i++) this.openWebSocket();
  }

  async openWebSocket() {
    if (!this.running) return;
    const cookie = await this.getCookie();
    if (!cookie) return;
    const wsUrl = this.base.replace(/^http/, "ws") + CONFIG.wsPath;
    const start = now();
    let socket;
    try {
      socket = new WebSocket(wsUrl, {
        headers: { Cookie: cookie, "User-Agent": this.ua, Origin: this.base },
        rejectUnauthorized: !CONFIG.insecureTLS,
        handshakeTimeout: CONFIG.requestTimeoutMs,
      });
    } catch (e) {
      // Constructor threw → no socket created, so nothing was counted as pending.
      this.m.ws.connectAttempt++;
      this.m.ws.connectFail++;
      this.wsFailStreak++;
      return;
    }

    // WS_HOLD_SEC drives a timed-close pattern that exercises connection churn
    // and the CDN/origin's reconnect handling. Real browser tabs hold a single
    // connection for the whole session; recycling here is a deliberate
    // load-generation choice (raise WS_HOLD_SEC to model long-lived sessions).
    const holdMs = CONFIG.wsHoldSec * 1000 * rand(0.7, 1.3);

    // Count this socket as "pending" exactly once, and decrement it exactly once
    // when it leaves the pending state — via open, or close, or a guard timer if
    // the `ws` lib somehow never emits close. This makes wsPending drift-proof
    // over a multi-day run (a stuck counter would otherwise starve the pool).
    this.wsPending++;
    this.m.ws.connectAttempt++;
    let opened = false;
    let pendingCleared = false;
    const clearPending = () => {
      if (pendingCleared) return;
      pendingCleared = true;
      this.wsPending = Math.max(0, this.wsPending - 1);
    };
    const pendingGuard = setTimeout(() => {
      if (!opened) {
        clearPending();
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
      }
    }, CONFIG.requestTimeoutMs + 2000);
    let closeTimer = null;

    socket.on("open", () => {
      opened = true;
      clearTimeout(pendingGuard);
      clearPending();
      this.m.ws.connectOk++;
      this.m.ws.connectLat.record(now() - start);
      this.wsFailStreak = 0;
      this.ws.add(socket);
      closeTimer = setTimeout(() => {
        try {
          socket.close(1000);
        } catch {
          /* ignore */
        }
      }, holdMs);
    });
    socket.on("message", (data) => {
      this.m.ws.msgs++;
      this.m.ws.bytes += data.length || 0;
      this.recordBytes(data.length || 0);
    });
    socket.on("error", () => {
      if (!opened) {
        this.m.ws.connectFail++;
        this.wsFailStreak++;
      }
    });
    socket.on("close", (code) => {
      clearTimeout(pendingGuard);
      if (closeTimer) clearTimeout(closeTimer);
      clearPending();
      if (opened) {
        this.ws.delete(socket);
        if (code !== 1000 && code !== 1001) this.m.ws.closedUnexpected++;
      }
    });
  }

  closeAllWebSockets() {
    for (const s of this.ws) {
      try {
        s.terminate();
      } catch {
        /* ignore */
      }
    }
    this.ws.clear();
  }

  destroy() {
    this.running = false;
    this.closeAllWebSockets();
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Diurnal target bandwidth
// ─────────────────────────────────────────────────────────────────────────────

function localHourFraction(d = new Date()) {
  if (CONFIG.tzOffsetHours == null) {
    return { h: d.getHours(), f: d.getMinutes() / 60 };
  }
  const totalMin = (d.getUTCHours() * 60 + d.getUTCMinutes() + CONFIG.tzOffsetHours * 60 + 1440 * 10) % 1440;
  return { h: Math.floor(totalMin / 60), f: (totalMin % 60) / 60 };
}

function diurnalMultiplier(d = new Date()) {
  const { h, f } = localHourFraction(d);
  const a = CONFIG.diurnal[h];
  const b = CONFIG.diurnal[(h + 1) % 24];
  return a + (b - a) * f; // linear interpolation between hours
}

function targetMbpsNow(runner) {
  const curve = diurnalMultiplier();
  let mbps = CONFIG.minMbps + (CONFIG.maxMbps - CONFIG.minMbps) * curve;
  // Warmup ramp.
  const elapsed = (Date.now() - runner.startedAt) / 1000;
  if (elapsed < CONFIG.warmupSec) mbps *= clamp(elapsed / CONFIG.warmupSec, 0.05, 1);
  // Jitter.
  mbps *= 1 + CONFIG.jitter * (Math.random() * 2 - 1);
  return clamp(mbps, 1, CONFIG.maxMbps * 1.15);
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller + scheduler (per runner)
// ─────────────────────────────────────────────────────────────────────────────

function startRunner(runner) {
  // 1s control loop: update bandwidth window, chase target via arrival rate.
  const control = setInterval(() => {
    if (!runner.running) return;
    runner.tickBandwidthWindow();
    const target = targetMbpsNow(runner);
    runner.targetMbps = target;
    const actual = runner.currentMbps();
    const err = (target - actual) / Math.max(target, 1);
    // Limit how much offered load can change per second so it tracks the target
    // band smoothly instead of overshooting on bursty (asset-heavy) windows.
    const factor = clamp(1 + KP * err, 0.7, 1.3);
    runner.arrivalRate = clamp(runner.arrivalRate * factor, 0.2, 5000);
    runner.saturated = runner.inflight >= CONFIG.maxConcurrency;
    runner.topUpWebSockets();
  }, 1000);

  // 100ms scheduler: launch a slice of the arrival rate, respecting the cap.
  const sched = setInterval(() => {
    if (!runner.running) return;
    let toStart = Math.round(runner.arrivalRate / 10);
    if (toStart < 1 && Math.random() < runner.arrivalRate / 10) toStart = 1;
    for (let i = 0; i < toStart; i++) {
      if (runner.inflight >= CONFIG.maxConcurrency) break;
      runner.runVisit();
    }
  }, 100);

  // Optional steady POST probe (cheap 401 logins → CDN POST passthrough test).
  let postTimer = null;
  if (CONFIG.postProbeRps > 0) {
    postTimer = setInterval(() => {
      if (!runner.running) return;
      const n = Math.max(1, Math.round(CONFIG.postProbeRps / 5));
      for (let i = 0; i < n; i++) {
        const fake = `probe_${Math.random().toString(36).slice(2)}@loadtest.invalid`;
        runner.rawRequest({
          method: "POST",
          url: `${runner.base}/api/auth/login`,
          headers: { "content-type": "application/json", origin: runner.base, accept: "application/json" },
          body: JSON.stringify({ email: fake, password: "x" }),
          klass: "api-postprobe",
        });
      }
    }, 200);
  }

  // Optional heartbeat pings (writes — only with real tokens).
  let hbTimer = null;
  if (CONFIG.heartbeatRps > 0 && CONFIG.heartbeatTokens.length) {
    hbTimer = setInterval(() => {
      if (!runner.running) return;
      const n = Math.max(1, Math.round(CONFIG.heartbeatRps / 5));
      for (let i = 0; i < n; i++) {
        const tok = pick(CONFIG.heartbeatTokens);
        httpRequest(runner, { url: `${runner.base}/api/heartbeat/${tok}`, klass: "heartbeat" });
      }
    }, 200);
  }

  runner._timers = [control, sched, postTimer, hbTimer].filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics reporting
// ─────────────────────────────────────────────────────────────────────────────

function snapshotAndReset(runner, windowSec) {
  const m = runner.m;
  const out = {
    ts: new Date().toISOString(),
    target: runner.base,
    host: runner.host,
    window_sec: windowSec,
    target_mbps: round1(runner.targetMbps || 0),
    actual_mbps: round1((m.bytes * 8) / 1e6 / windowSec),
    req_total: 0,
    req_per_sec: 0,
    inflight: runner.inflight,
    arrival_rate: round1(runner.arrivalRate),
    saturated: runner.saturated,
    by_class: {},
    status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, err: 0 },
    cache: { hit: 0, miss: 0, unknown: 0 },
    errors: { ...m.errors },
    ws: {
      active: runner.ws.size,
      connect_attempt: m.ws.connectAttempt,
      connect_ok: m.ws.connectOk,
      connect_fail: m.ws.connectFail,
      connect_p95_ms: Math.round(m.ws.connectLat.pct(0.95)),
      msgs: m.ws.msgs,
      mb: round1(m.ws.bytes / 1e6),
      closed_unexpected: m.ws.closedUnexpected,
    },
  };
  for (const [klass, b] of Object.entries(m.reqByClass)) {
    out.req_total += b.n;
    out.by_class[klass] = {
      n: b.n,
      p50: Math.round(b.hist.pct(0.5)),
      p95: Math.round(b.hist.pct(0.95)),
      p99: Math.round(b.hist.pct(0.99)),
      ttfb_p95: Math.round(b.ttfb.pct(0.95)),
      max: Math.round(b.hist.max || 0),
    };
    out.status["2xx"] += b.statuses[2];
    out.status["3xx"] += b.statuses[3];
    out.status["4xx"] += b.statuses[4];
    out.status["5xx"] += b.statuses[5];
    out.status.err += b.statuses[0];
    out.cache.hit += b.cache.hit;
    out.cache.miss += b.cache.miss;
    out.cache.unknown += b.cache.unknown;
  }
  out.req_per_sec = round1(out.req_total / windowSec);
  runner.resetMetrics();
  return out;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function printSummary(s) {
  const cls = s.by_class.page || { p95: 0, p99: 0 };
  const asset = s.by_class.asset || { p95: 0, n: 0 };
  const sat = s.saturated ? " ⚠SAT" : "";
  console.log(
    `[${s.ts.slice(11, 19)}] ${s.host}  ` +
      `${s.actual_mbps}/${s.target_mbps} Mbps  ` +
      `${s.req_per_sec} rps  ` +
      `page p95=${cls.p95}ms p99=${cls.p99}ms  ` +
      `asset p95=${asset.p95}ms  ` +
      `2xx=${s.status["2xx"]} 4xx=${s.status["4xx"]} 5xx=${s.status["5xx"]} err=${s.status.err}  ` +
      `ws=${s.ws.active}(ok ${s.ws.connect_ok}/${s.ws.connect_attempt})  ` +
      `cache h/m/u=${s.cache.hit}/${s.cache.miss}/${s.cache.unknown}` +
      `${sat}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety, modes, bootstrap
// ─────────────────────────────────────────────────────────────────────────────

function safetyCheck() {
  const hosts = new Set();
  for (const t of CONFIG.targets) {
    try {
      hosts.add(new URL(t).host);
    } catch {
      console.error(`[config] invalid TARGET url: ${t}`);
      process.exit(1);
    }
  }
  if (CONFIG.allowedHosts.length) {
    for (const h of hosts) {
      const ok = CONFIG.allowedHosts.some((a) => h === a || h.endsWith("." + a));
      if (!ok) {
        console.error(
          `[safety] ${h} is not in ALLOWED_HOSTS (${CONFIG.allowedHosts.join(", ")}). Refusing to run.`
        );
        process.exit(1);
      }
    }
  } else {
    console.error(
      "[safety] ALLOWED_HOSTS is empty — refusing to run. A load generator pointed at\n" +
        "          the wrong host is a DoS. Set ALLOWED_HOSTS to your own domains, e.g.\n" +
        "          ALLOWED_HOSTS=mwscdn.ru,sentela.org"
    );
    process.exit(1);
  }
  if (CONFIG.maxMbps > 1000) {
    console.error("[safety] MAX_MBPS > 1000 looks like a mistake. Aborting.");
    process.exit(1);
  }
}

function printSchedule() {
  console.log(`Diurnal Mbit/s schedule (band ${CONFIG.minMbps}–${CONFIG.maxMbps} Mbit/s per target):\n`);
  const tz = CONFIG.tzOffsetHours == null ? "server local time" : `UTC${CONFIG.tzOffsetHours >= 0 ? "+" : ""}${CONFIG.tzOffsetHours}`;
  console.log(`(${tz})`);
  for (let h = 0; h < 24; h++) {
    const d = new Date(2025, 0, 1, h, 0, 0);
    const curve = CONFIG.diurnal[h]; // table is per wall-clock hour; tz only shifts when each hour occurs
    const mbps = CONFIG.minMbps + (CONFIG.maxMbps - CONFIG.minMbps) * curve;
    const bar = "█".repeat(Math.round((mbps / CONFIG.maxMbps) * 40));
    console.log(`${String(h).padStart(2, "0")}:00  ${String(Math.round(mbps)).padStart(4)} Mbps  ${bar}`);
  }
}

async function smoke() {
  console.log("SMOKE TEST — one functional pass per target.\n");
  for (const base of CONFIG.targets) {
    const r = new TargetRunner(base);
    console.log(`── ${base} ──`);
    // Anonymous page + assets.
    const page = await httpRequest(r, { url: base + "/", klass: "page", wantBody: true });
    const assets = page.body ? extractAssets(page.body, base + "/") : [];
    console.log(`  GET /              -> ${page.ok ? page.status : "ERR " + page.err}  (${assets.length} assets found, ${round1((page.bytes || 0) / 1024)} KB)`);
    if (assets.length) {
      const a = await httpRequest(r, { url: assets[0], klass: "asset" });
      console.log(`  GET asset[0]       -> ${a.ok ? a.status : "ERR " + a.err}  cache=${cacheStatusFrom(a.headers)}`);
    }
    // Login + authed page + WS.
    if (CONFIG.accounts.length) {
      const cookie = await r.getCookie();
      console.log(`  POST /api/auth/login -> ${cookie ? "200 (cookie ok)" : "FAILED (check TEST_ACCOUNTS)"}`);
      if (cookie) {
        const dash = await httpRequest(r, { url: base + "/dashboard", headers: { cookie }, klass: "page" });
        console.log(`  GET /dashboard     -> ${dash.ok ? dash.status : "ERR " + dash.err}`);
        await new Promise((resolve) => {
          const wsUrl = base.replace(/^http/, "ws") + CONFIG.wsPath;
          const s = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: base }, rejectUnauthorized: !CONFIG.insecureTLS, handshakeTimeout: 8000 });
          const t = setTimeout(() => {
            console.log("  WS /realtime       -> TIMEOUT");
            try { s.terminate(); } catch {}
            resolve();
          }, 9000);
          s.on("open", () => { console.log("  WS /realtime       -> 101 OK (connected)"); clearTimeout(t); try { s.close(); } catch {} resolve(); });
          s.on("error", (e) => { console.log(`  WS /realtime       -> ERROR ${e.message}`); clearTimeout(t); resolve(); });
        });
      }
    } else {
      console.log("  (no TEST_ACCOUNTS — skipping login + WebSocket checks)");
    }
    r.destroy();
    console.log("");
  }
  process.exit(0);
}

function ensureLogStream() {
  try {
    fs.mkdirSync(CONFIG.logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const fname = `loadtest-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const stream = fs.createWriteStream(path.join(CONFIG.logDir, fname), { flags: "a" });
  // NB: `errored` is a read-only built-in on Writable — use our own flag name.
  stream._ltFailed = false;
  stream.on("error", (e) => {
    stream._ltFailed = true; // stop trying to write; keep the run alive (metrics still print)
    console.error("[log] write error (continuing without file log):", e.message);
  });
  return stream;
}

function printEffectiveConfig() {
  console.log("Sentela load generator — effective config:");
  console.log(`  targets         : ${CONFIG.targets.join(", ")}`);
  console.log(`  band (per tgt)  : ${CONFIG.minMbps}–${CONFIG.maxMbps} Mbit/s (diurnal)`);
  console.log(`  accounts        : ${CONFIG.accounts.length} (auth share ${CONFIG.authFraction})`);
  console.log(`  ws target       : ${CONFIG.wsTarget} per target`);
  console.log(`  post probe rps  : ${CONFIG.postProbeRps}`);
  console.log(`  heartbeat rps   : ${CONFIG.heartbeatRps} (tokens: ${CONFIG.heartbeatTokens.length})`);
  console.log(`  max concurrency : ${CONFIG.maxConcurrency}, max sockets ${CONFIG.maxSockets}`);
  console.log(`  duration        : ${CONFIG.durationSec ? CONFIG.durationSec + "s" : "until stopped"}`);
  console.log(`  log dir         : ${CONFIG.logDir}`);
  console.log(`  total peak load : ~${Math.round(CONFIG.maxMbps * CONFIG.targets.length)} Mbit/s across all targets`);
  console.log("");
}

async function main() {
  if (MODE === "schedule") return printSchedule();
  safetyCheck();
  if (MODE === "smoke") return smoke();

  printEffectiveConfig();
  const runners = CONFIG.targets.map((t) => new TargetRunner(t));
  for (const r of runners) startRunner(r);

  const logStream = ensureLogStream();
  let stopping = false;
  let reporter = null;
  let exitCode = 0;

  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[shutdown] ${reason} — draining…`);
    if (reporter) clearInterval(reporter);
    for (const r of runners) {
      for (const t of r._timers) clearInterval(t);
      r.destroy();
    }
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(exitCode), 1500);
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (e) => {
    if (CONFIG.verbose) console.error("[unhandledRejection]", e);
  });
  // An uncaught exception means unexpected/possibly-corrupt state. Don't keep a
  // half-broken zombie running under systemd — shut down cleanly and exit non-zero
  // so `Restart=always` brings up a fresh process.
  process.on("uncaughtException", (e) => {
    console.error("[uncaughtException]", (e && e.stack) || e);
    exitCode = 1;
    stop("uncaughtException");
  });

  // Metrics + stop-file loop.
  const intervalMs = CONFIG.metricsIntervalSec * 1000;
  reporter = setInterval(() => {
    for (const r of runners) {
      const s = snapshotAndReset(r, CONFIG.metricsIntervalSec);
      printSummary(s);
      if (!logStream._ltFailed) {
        try {
          logStream.write(JSON.stringify(s) + "\n");
        } catch (e) {
          logStream._ltFailed = true;
          console.error("[log] write failed (continuing without file log):", e.message);
        }
      }
    }
    if (fs.existsSync(CONFIG.stopFile)) {
      stop(`stop file ${CONFIG.stopFile} present`);
    }
  }, intervalMs);

  if (CONFIG.durationSec > 0) {
    setTimeout(() => {
      clearInterval(reporter);
      stop(`duration ${CONFIG.durationSec}s reached`);
    }, CONFIG.durationSec * 1000);
  }

  console.log(`Running. Ctrl-C or "touch ${CONFIG.stopFile}" to stop.\n`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
