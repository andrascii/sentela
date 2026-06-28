/**
 * Sentela realtime WebSocket service.
 *
 * Pushes live monitor updates to dashboard clients instead of polling:
 *   - a dedicated Postgres LISTEN connection receives `sentela_status` events
 *     that the worker emits (pg_notify) after every monitor check;
 *   - each browser WebSocket is authenticated from the session cookie (the same
 *     JWT the app issues) and scoped to the user's active team, so a client only
 *     receives events for monitors it is allowed to see;
 *   - clients pick a channel by path: /realtime (the whole team) or
 *     /realtime/monitor/<id> (a single monitor).
 *
 * Runs as its own process (`npm run realtime`); nginx proxies `/realtime` to it.
 * It never imports next/* — only the shared pg pool from src/lib/db.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { Client } from "pg";
import { jwtVerify } from "jose";
import { getPool } from "../src/lib/db";

// Cookie names mirror src/lib/session.ts (SESSION_COOKIE) and src/lib/teams.ts
// (TEAM_COOKIE). Kept local so this process never has to import next/headers.
const SESSION_COOKIE = "ip_session";
const TEAM_COOKIE = "ip_team";
const NOTIFY_CHANNEL = "sentela_status";

const PORT = parseInt(process.env.WS_PORT || "3001", 10) || 3001;
const WS_PATH = process.env.WS_PATH || "/realtime";
const PING_INTERVAL_MS = 30_000;

function getSecret(): Uint8Array {
  return new TextEncoder().encode(
    process.env.JWT_SECRET || "dev-insecure-secret-change-me"
  );
}

interface Ctx {
  userId: number;
  teamId: number;
}
// A live connection. `monitorId` is set when the client subscribed to a single
// monitor's channel (/realtime/monitor/<id>); null = the whole-team channel.
interface Conn {
  ws: WebSocket;
  userId: number;
  teamId: number;
  monitorId: number | null;
  alive: boolean;
}

const clients = new Set<Conn>();

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
    return { userId, teamId };
  } catch (err) {
    console.error("[realtime] team resolve failed:", err);
    return null;
  }
}

function registerConnection(ws: WebSocket, ctx: Ctx, monitorId: number | null): void {
  const conn: Conn = {
    ws,
    userId: ctx.userId,
    teamId: ctx.teamId,
    monitorId,
    alive: true,
  };
  clients.add(conn);
  ws.on("pong", () => {
    conn.alive = true;
  });
  ws.on("close", () => clients.delete(conn));
  ws.on("error", () => clients.delete(conn));
  try {
    ws.send(JSON.stringify({ type: "connected" }));
  } catch {
    /* ignore */
  }
}

interface StatusEvent {
  teamId?: number | null;
  userId?: number | null;
  monitorId?: number;
  name?: string;
  status?: string;
  prevStatus?: string;
}

function broadcast(evt: StatusEvent): void {
  const payload = JSON.stringify({
    type: "status",
    monitorId: evt.monitorId,
    name: evt.name,
    status: evt.status,
    prevStatus: evt.prevStatus,
  });
  for (const c of clients) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    // Team scope (per-check payloads always carry teamId); fall back to the
    // creator only for legacy monitors with no team.
    const teamMatch = evt.teamId != null && c.teamId === evt.teamId;
    const userMatch = evt.teamId == null && evt.userId != null && c.userId === evt.userId;
    if (!teamMatch && !userMatch) continue;
    // Channel scope: a per-monitor subscriber only wants its own monitor's events.
    if (c.monitorId != null && c.monitorId !== evt.monitorId) continue;
    try {
      c.ws.send(payload);
    } catch {
      /* drop on next ping sweep */
    }
  }
}

// Path-based channels — one WS service, several endpoints:
//   /realtime               → all of the team's monitor updates (dashboard, incidents)
//   /realtime/monitor/<id>  → a single monitor's updates (its detail page)
// Returns the parsed channel, or null for an unknown path (connection rejected).
function parseChannel(pathname: string): { monitorId: number | null } | null {
  if (pathname === WS_PATH) return { monitorId: null };
  const prefix = `${WS_PATH}/monitor/`;
  if (pathname.startsWith(prefix)) {
    const rest = pathname.slice(prefix.length);
    const id = Number(rest);
    if (Number.isInteger(id) && id > 0 && String(id) === rest) {
      return { monitorId: id };
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

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url || "/", "http://localhost");
  const channel = parseChannel(url.pathname);
  if (!channel) {
    socket.destroy();
    return;
  }
  resolveContext(req)
    .then((ctx) => {
      if (!ctx) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        registerConnection(ws, ctx, channel.monitorId)
      );
    })
    .catch(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
});

// Drop dead connections (no pong since the last sweep). Snapshot the set since
// we delete from it while iterating.
setInterval(() => {
  for (const c of Array.from(clients)) {
    if (!c.alive) {
      c.ws.terminate();
      clients.delete(c);
      continue;
    }
    c.alive = false;
    try {
      c.ws.ping();
    } catch {
      /* ignore */
    }
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
  // Registered once on this (fresh) client, before connect — a new client is
  // created on every reconnect, so handlers never accumulate.
  client.on("notification", (msg) => {
    if (!msg.payload) return;
    try {
      broadcast(JSON.parse(msg.payload) as StatusEvent);
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
