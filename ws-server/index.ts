/**
 * Sentela realtime WebSocket service.
 *
 * A small typed event bus that pushes live updates to browsers instead of
 * polling. A dedicated Postgres LISTEN connection receives events the worker (and
 * the live-probe API route) emit via pg_notify on `sentela_status`; each event
 * carries a `kind` (check | timing | comment) and is fanned out to the right
 * subscribers.
 *
 * Channels (chosen by WebSocket path):
 *   /realtime               → the whole team: check events, live incident feed,
 *                             comments + typing (authenticated; bidirectional).
 *   /realtime/monitor/<id>  → one monitor: check + timing (waterfall) events.
 *   /realtime/status/<slug> → a PUBLIC status page: presence counter + public
 *                             check events. No authentication.
 *
 * Auth for the first two mirrors the app's session cookie (the same JWT). The
 * public channel is unauthenticated by design and only ever receives a
 * public-safe subset of fields.
 *
 * Presence and typing are in-process (single realtime instance). Persisted
 * comments go back through pg_notify, so they'd still fan out correctly across
 * multiple instances; scaling presence/typing horizontally would need a shared
 * bus (e.g. Redis pub/sub).
 *
 * Runs as its own process (`npm run realtime`); nginx proxies `/realtime` (a
 * prefix — covers every channel above). It never imports next/* — only the
 * shared pg pool and node-safe helpers from src/lib.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { Client } from "pg";
import { jwtVerify } from "jose";
import { getPool } from "../src/lib/db";
import {
  insertIncidentComment,
  COMMENT_MAX_LENGTH,
  type IncidentComment,
} from "../src/lib/incidents";

// Cookie names mirror src/lib/session.ts (SESSION_COOKIE) and src/lib/teams.ts
// (TEAM_COOKIE). Kept local so this process never has to import next/headers.
const SESSION_COOKIE = "ip_session";
const TEAM_COOKIE = "ip_team";
const NOTIFY_CHANNEL = "sentela_status";

const PORT = parseInt(process.env.WS_PORT || "3001", 10) || 3001;
const WS_PATH = process.env.WS_PATH || "/realtime";
const PING_INTERVAL_MS = 30_000;
const TYPING_MIN_INTERVAL_MS = 800; // per-connection throttle for typing pings
const COMMENT_MIN_INTERVAL_MS = 400; // per-connection flood guard for comments

function getSecret(): Uint8Array {
  return new TextEncoder().encode(
    process.env.JWT_SECRET || "dev-insecure-secret-change-me"
  );
}

interface Ctx {
  userId: number;
  teamId: number;
  email: string;
}

// An authenticated connection (team or per-monitor channel). `monitorId` is set
// when the client subscribed to a single monitor's channel; null = team channel.
interface Conn {
  ws: WebSocket;
  userId: number;
  teamId: number;
  email: string;
  monitorId: number | null;
  alive: boolean;
  lastTypingAt: number;
  lastCommentAt: number;
}

// A public status-page connection (unauthenticated). Scoped to a status slug and
// the team it maps to (may be null if the owner has no team yet).
interface StatusConn {
  ws: WebSocket;
  slug: string;
  teamId: number | null;
  alive: boolean;
}

const clients = new Set<Conn>();
const statusClients = new Map<string, Set<StatusConn>>();

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

/** Mirror of getActiveTeamId (src/lib/teams.ts) for a cookie-only context. */
async function resolveTeam(userId: number, teamCookie?: string): Promise<number | null> {
  const pool = getPool();
  if (teamCookie) {
    const id = parseInt(teamCookie, 10);
    if (Number.isInteger(id)) {
      const r = await pool.query(
        "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2",
        [id, userId]
      );
      if (r.rows.length > 0) return id;
    }
  }
  const personal = await pool.query<{ id: number }>(
    "SELECT id FROM teams WHERE owner_id = $1 ORDER BY id ASC LIMIT 1",
    [userId]
  );
  if (personal.rows[0]) return personal.rows[0].id;
  const member = await pool.query<{ team_id: number }>(
    "SELECT team_id FROM team_members WHERE user_id = $1 ORDER BY team_id ASC LIMIT 1",
    [userId]
  );
  return member.rows[0]?.team_id ?? null;
}

async function resolveContext(req: IncomingMessage): Promise<Ctx | null> {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  let userId: number;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (typeof payload.uid !== "number") return null;
    userId = payload.uid;
  } catch {
    return null;
  }
  try {
    const teamId = await resolveTeam(userId, cookies[TEAM_COOKIE]);
    if (teamId == null) return null;
    const emailRes = await getPool().query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1",
      [userId]
    );
    return { userId, teamId, email: emailRes.rows[0]?.email ?? "" };
  } catch (err) {
    console.error("[realtime] context resolve failed:", err);
    return null;
  }
}

/** Map a public status slug to its team (mirror of getStatusPageData scoping). */
async function resolveStatusSlug(slug: string): Promise<{ teamId: number | null } | null> {
  const pool = getPool();
  const u = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE status_slug = $1",
    [slug]
  );
  const user = u.rows[0];
  if (!user) return null;
  const t = await pool.query<{ id: number }>(
    "SELECT id FROM teams WHERE owner_id = $1 ORDER BY id ASC LIMIT 1",
    [user.id]
  );
  return { teamId: t.rows[0]?.id ?? null };
}

function safeSend(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* drop on next ping sweep */
  }
}

// ── Presence (public status pages) ──────────────────────────────────────────
function broadcastPresence(slug: string): void {
  const set = statusClients.get(slug);
  if (!set) return;
  const online = set.size;
  for (const c of set) safeSend(c.ws, { type: "presence", online });
}

function registerStatusConnection(ws: WebSocket, slug: string, teamId: number | null): void {
  const conn: StatusConn = { ws, slug, teamId, alive: true };
  let set = statusClients.get(slug);
  if (!set) {
    set = new Set<StatusConn>();
    statusClients.set(slug, set);
  }
  set.add(conn);
  ws.on("pong", () => {
    conn.alive = true;
  });
  const drop = () => {
    const s = statusClients.get(slug);
    if (s) {
      s.delete(conn);
      if (s.size === 0) statusClients.delete(slug);
      else broadcastPresence(slug);
    }
  };
  ws.on("close", drop);
  ws.on("error", drop);
  safeSend(ws, { type: "connected" });
  broadcastPresence(slug); // includes the new viewer
}

// ── Authenticated connections (team / monitor) ──────────────────────────────
function registerConnection(ws: WebSocket, ctx: Ctx, monitorId: number | null): void {
  const conn: Conn = {
    ws,
    userId: ctx.userId,
    teamId: ctx.teamId,
    email: ctx.email,
    monitorId,
    alive: true,
    lastTypingAt: 0,
    lastCommentAt: 0,
  };
  clients.add(conn);
  ws.on("pong", () => {
    conn.alive = true;
  });
  ws.on("close", () => clients.delete(conn));
  ws.on("error", () => clients.delete(conn));
  // Only the team channel is interactive (live incident timeline).
  if (monitorId == null) {
    ws.on("message", (raw) => handleClientMessage(conn, raw));
  }
  safeSend(ws, { type: "connected" });
}

/** Inbound messages from the team channel: typing pings and new comments. */
function handleClientMessage(conn: Conn, raw: RawData): void {
  let msg: { type?: string; body?: unknown };
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === "typing") {
    const now = Date.now();
    if (now - conn.lastTypingAt < TYPING_MIN_INTERVAL_MS) return;
    conn.lastTypingAt = now;
    broadcastTyping(conn);
    return;
  }
  if (msg.type === "comment") {
    const now = Date.now();
    if (now - conn.lastCommentAt < COMMENT_MIN_INTERVAL_MS) return;
    conn.lastCommentAt = now;
    const body = typeof msg.body === "string" ? msg.body.trim().slice(0, COMMENT_MAX_LENGTH) : "";
    if (!body) return;
    void persistAndPublishComment(conn, body);
  }
}

function broadcastTyping(from: Conn): void {
  for (const c of clients) {
    if (c === from || c.monitorId != null || c.teamId !== from.teamId) continue;
    safeSend(c.ws, { type: "typing", name: from.email });
  }
}

async function persistAndPublishComment(conn: Conn, body: string): Promise<void> {
  try {
    const comment = await insertIncidentComment({
      teamId: conn.teamId,
      userId: conn.userId,
      authorEmail: conn.email,
      body,
    });
    // Publish through pg_notify so every realtime instance (incl. this one) fans
    // it out — a single, consistent source of truth for the comment feed.
    await getPool().query("SELECT pg_notify($1, $2)", [
      NOTIFY_CHANNEL,
      JSON.stringify({ kind: "comment", teamId: conn.teamId, comment }),
    ]);
  } catch (err) {
    console.error("[realtime] comment persist failed:", err);
    safeSend(conn.ws, { type: "error", message: "Не удалось сохранить сообщение" });
  }
}

// ── Event fan-out (from Postgres LISTEN) ────────────────────────────────────
interface CheckEvent {
  kind?: "check";
  /** True for ephemeral on-demand "live mode" probes (not persisted). */
  live?: boolean;
  teamId?: number | null;
  userId?: number | null;
  monitorId?: number;
  name?: string;
  type?: string;
  status?: string;
  prevStatus?: string;
  changed?: boolean;
  latencyMs?: number;
  statusCode?: number | null;
  errorMessage?: string | null;
  region?: string | null;
  checkedAt?: string;
}

interface TimingEvent {
  kind: "timing";
  teamId?: number | null;
  userId?: number | null;
  monitorId?: number;
  statusCode?: number | null;
  checkedAt?: string;
  timing?: Record<string, number>;
}

interface CommentEvent {
  kind: "comment";
  teamId: number;
  comment: IncidentComment;
}

type BusEvent = CheckEvent | TimingEvent | CommentEvent;

/** Does an authenticated connection's team/user scope match this event? */
function scopeMatches(c: Conn, teamId?: number | null, userId?: number | null): boolean {
  const teamMatch = teamId != null && c.teamId === teamId;
  const userMatch = teamId == null && userId != null && c.userId === userId;
  return teamMatch || userMatch;
}

function fanoutCheck(evt: CheckEvent): void {
  const full = {
    type: "check",
    live: evt.live ?? false,
    monitorId: evt.monitorId,
    name: evt.name,
    monitorType: evt.type,
    status: evt.status,
    prevStatus: evt.prevStatus,
    changed: evt.changed,
    latencyMs: evt.latencyMs,
    statusCode: evt.statusCode ?? null,
    errorMessage: evt.errorMessage ?? null,
    region: evt.region ?? null,
    checkedAt: evt.checkedAt,
  };
  for (const c of clients) {
    if (!scopeMatches(c, evt.teamId, evt.userId)) continue;
    if (c.monitorId != null && c.monitorId !== evt.monitorId) continue;
    safeSend(c.ws, full);
  }
  // Public status pages: only forward a public-safe subset, and only to viewers
  // of the slug that maps to this event's team. Ephemeral live probes don't
  // change public status, so they're never forwarded there.
  if (evt.teamId != null && !evt.live) {
    const publicPayload = {
      type: "check",
      monitorId: evt.monitorId,
      name: evt.name,
      status: evt.status,
      changed: evt.changed,
      latencyMs: evt.latencyMs,
      checkedAt: evt.checkedAt,
    };
    for (const set of statusClients.values()) {
      for (const c of set) {
        if (c.teamId === evt.teamId) safeSend(c.ws, publicPayload);
      }
    }
  }
}

function fanoutTiming(evt: TimingEvent): void {
  const payload = {
    type: "timing",
    monitorId: evt.monitorId,
    statusCode: evt.statusCode ?? null,
    checkedAt: evt.checkedAt,
    timing: evt.timing ?? {},
  };
  // Timing only matters to the per-monitor detail page.
  for (const c of clients) {
    if (c.monitorId == null || c.monitorId !== evt.monitorId) continue;
    if (!scopeMatches(c, evt.teamId, evt.userId)) continue;
    safeSend(c.ws, payload);
  }
}

function fanoutComment(evt: CommentEvent): void {
  const payload = { type: "comment", comment: evt.comment };
  for (const c of clients) {
    if (c.monitorId != null) continue; // team channel only
    if (c.teamId !== evt.teamId) continue;
    safeSend(c.ws, payload);
  }
}

function dispatch(evt: BusEvent): void {
  switch (evt.kind) {
    case "timing":
      fanoutTiming(evt);
      break;
    case "comment":
      fanoutComment(evt);
      break;
    case "check":
    default:
      // Legacy events (no kind) are check events.
      fanoutCheck(evt as CheckEvent);
      break;
  }
}

// ── Channel routing ─────────────────────────────────────────────────────────
type Channel =
  | { kind: "team" }
  | { kind: "monitor"; monitorId: number }
  | { kind: "status"; slug: string };

function parseChannel(pathname: string): Channel | null {
  if (pathname === WS_PATH) return { kind: "team" };
  const monitorPrefix = `${WS_PATH}/monitor/`;
  if (pathname.startsWith(monitorPrefix)) {
    const rest = pathname.slice(monitorPrefix.length);
    const id = Number(rest);
    if (Number.isInteger(id) && id > 0 && String(id) === rest) {
      return { kind: "monitor", monitorId: id };
    }
    return null;
  }
  const statusPrefix = `${WS_PATH}/status/`;
  if (pathname.startsWith(statusPrefix)) {
    const slug = decodeURIComponent(pathname.slice(statusPrefix.length));
    // Slugs are simple identifiers; reject anything with a path separator.
    if (slug && slug.length <= 128 && !slug.includes("/")) {
      return { kind: "status", slug };
    }
  }
  return null;
}

const wss = new WebSocketServer({ noServer: true });

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("Upgrade Required");
});

function reject(socket: Duplex, line: string): void {
  try {
    socket.write(`HTTP/1.1 ${line}\r\n\r\n`);
    socket.destroy();
  } catch {
    /* ignore */
  }
}

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url || "/", "http://localhost");
  const channel = parseChannel(url.pathname);
  if (!channel) {
    socket.destroy();
    return;
  }

  // Public status channel — no auth, just resolve the slug's team for scoping.
  if (channel.kind === "status") {
    resolveStatusSlug(channel.slug)
      .then((resolved) => {
        if (!resolved) {
          reject(socket, "404 Not Found");
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) =>
          registerStatusConnection(ws, channel.slug, resolved.teamId)
        );
      })
      .catch(() => socket.destroy());
    return;
  }

  // Authenticated channels (team / monitor).
  resolveContext(req)
    .then((ctx) => {
      if (!ctx) {
        reject(socket, "401 Unauthorized");
        return;
      }
      const monitorId = channel.kind === "monitor" ? channel.monitorId : null;
      wss.handleUpgrade(req, socket, head, (ws) => registerConnection(ws, ctx, monitorId));
    })
    .catch(() => socket.destroy());
});

// Drop dead connections (no pong since the last sweep). Snapshot the sets since
// we delete from them while iterating.
setInterval(() => {
  const sweep = (ws: WebSocket, alive: boolean, markDead: () => void) => {
    if (!alive) {
      ws.terminate();
      return true;
    }
    markDead();
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
    return false;
  };
  for (const c of Array.from(clients)) {
    if (sweep(c.ws, c.alive, () => (c.alive = false))) clients.delete(c);
  }
  for (const [slug, set] of Array.from(statusClients.entries())) {
    let changed = false;
    for (const c of Array.from(set)) {
      if (sweep(c.ws, c.alive, () => (c.alive = false))) {
        set.delete(c);
        changed = true;
      }
    }
    if (set.size === 0) statusClients.delete(slug);
    else if (changed) broadcastPresence(slug);
  }
}, PING_INTERVAL_MS).unref();

// Guard so a connect failure + an 'end' event can't schedule two parallel
// reconnects (which would open duplicate LISTEN connections).
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startListener();
  }, 2000);
}

/** Dedicated long-lived connection for LISTEN (the pool rotates connections). */
async function startListener(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://edgepulse:edgepulse_password@localhost:5432/edgepulse";
  const client = new Client({ connectionString });
  client.on("error", (err) => {
    console.error("[realtime] pg listen error:", err);
  });
  client.on("end", () => {
    console.warn("[realtime] pg listen connection ended — reconnecting in 2s");
    scheduleReconnect();
  });
  client.on("notification", (msg) => {
    if (!msg.payload) return;
    try {
      dispatch(JSON.parse(msg.payload) as BusEvent);
    } catch {
      /* malformed payload — ignore */
    }
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    console.log(`[realtime] listening on Postgres channel "${NOTIFY_CHANNEL}"`);
  } catch (err) {
    console.error("[realtime] listener connect failed — retrying in 2s:", err);
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    scheduleReconnect();
  }
}

server.listen(PORT, () => {
  console.log(`[realtime] websocket server on :${PORT}${WS_PATH}`);
});
void startListener();
