# Sentela

Distributed monitoring for websites, APIs and infrastructure — uptime, latency, SSL, DNS and
API health checks with Telegram alerts, a dashboard, public status pages and stubbed plan
tiers.

This is an MVP that **actually works**: the background worker performs real HTTP / TCP / DNS /
SSL checks on the schedule you configure and sends Telegram alerts on outage and recovery.

## Stack

- **Frontend & API:** Next.js 14 (App Router) + TypeScript + Tailwind CSS
- **Database:** PostgreSQL 17
- **Auth:** email + password (bcrypt), signed HTTP-only cookie sessions (JWT via `jose`)
- **Worker:** standalone Node process (`tsx`) running scheduled checks
- **Notifications:** Telegram Bot API
- **Deploy:** Docker Compose (`app`, `worker`, `postgres`)

## Quick start (Docker)

```bash
cp .env.example .env
# (optional) set TELEGRAM_BOT_TOKEN in .env to enable alerts
docker compose up --build
```

Then open http://localhost:3000

- `app` — the Next.js site + API on port 3000
- `worker` — runs checks every `WORKER_TICK_SECONDS` (default 15s)
- `postgres` — database; schema is applied automatically on first boot

The database schema is also applied idempotently by the app/worker at startup, so it works on a
fresh volume either way.

## Local development (without Docker)

Requires Node 20+ and a reachable PostgreSQL.

```bash
npm install
cp .env.example .env   # point DATABASE_URL at your Postgres
npm run dev            # web app on :3000
npm run worker         # in a second terminal — runs the checks
```

## Environment variables

| Variable               | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`         | PostgreSQL connection string                               |
| `JWT_SECRET`           | Secret used to sign session cookies — set a long random value |
| `TELEGRAM_BOT_TOKEN`   | Bot token from @BotFather (alerts skipped if empty)        |
| `WORKER_TICK_SECONDS`  | How often the worker scans for due monitors (default 15)   |
| `APP_BASE_URL`         | Public base URL, used in alert links / metadata            |
| `ALLOW_PRIVATE_TARGETS`| Allow monitors to target private/loopback IPs (SSRF). Demo `true`; prod unset/`false` |

## How it works

1. You register and add a **monitor** (name, target, check type, interval).
2. The **worker** selects monitors whose interval has elapsed, runs the check, stores the
   result in `monitor_checks`, and updates the monitor status.
3. On an **up → down** (or recovery) transition it sends a **Telegram** message to the
   notification channels on your account.
4. The **dashboard** shows live status, latency, uptime (24h / 7d / 30d) and history; each
   monitor has a detail page with a latency chart and recent errors.
5. A public **status page** is available at `/status/<your-slug>`.

### Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. On the dashboard, click **«Подключить Telegram»** in the *Оповещения* card — it opens a
   `t.me/<bot>?start=<token>` deep link. Press **Start** in the bot; the worker picks up the
   `/start <token>` message (via `getUpdates`) and binds your chat automatically — no manual
   chat-ID entry.
3. Per-monitor alerts are controlled by the **«Присылать уведомления»** checkbox in monitor
   settings; the global **«Получать уведомления в Telegram»** toggle lives in the same
   dashboard card. Alerts fan out to every team member who linked Telegram (and has the
   global toggle on).

Note for multi-region deployments: only the primary worker (no `REGION` set) polls
`getUpdates` — Telegram allows a single consumer per bot token.

## Check types

| Type        | What it does                                                                 | Target example            |
| ----------- | --------------------------------------------------------------------------- | ------------------------- |
| HTTP        | GET the URL, record status code + latency, assert expected status codes      | `https://example.com`     |
| API         | Custom method/headers/body + response assertions (JSON path, body, header)   | `https://api.example.com` |
| TCP         | Open a TCP connection, measure connect time                                  | `db.example.com:5432`     |
| DNS         | Resolve a record (A/AAAA/MX/TXT/CNAME/NS); optionally assert an expected value | `example.com`             |
| SSL         | TLS handshake, cert expiry, optional min-TLS-version + chain verification     | `example.com`             |
| Ping        | ICMP latency + packet loss                                                   | `8.8.8.8`                 |
| Heartbeat   | Dead-man's switch — your job pings a URL; down if pings stop                  | _(push)_                  |
| Domain      | Domain registration expiry via RDAP                                          | `example.com`             |
| Blacklist   | DNSBL lookup — is the IP/host on spam blocklists                             | `1.2.3.4`                 |
| PostgreSQL  | Connect + run a query (default `SELECT 1`), measure latency                  | `postgres://…`            |
| MySQL       | Connect + run a query                                                        | `mysql://…`               |
| Redis       | `PING` over RESP (optional AUTH)                                             | `cache.example.com:6379`  |
| SMTP        | Connect, read `220` greeting, `EHLO` → `250`                                 | `mail.example.com:25`     |

Monitors can be organized into **groups** (a free-text label per monitor) and the
dashboard renders them in grouped sections; existing monitors can be regrouped inline.

> **Not yet implemented** (need heavy runtime infra, deferred deliberately): headless-browser
> synthetic transactions & Lighthouse/Core-Web-Vitals, a server-side metrics agent
> (CPU/RAM/disk), and gRPC health checks.

## Key capabilities

- **Expected status codes** — list acceptable codes (e.g. `401`) so an intentionally-protected
  endpoint reads as *up* instead of *down*.
- **API assertions** — for `api` monitors: custom HTTP method, request headers (incl.
  `Authorization`), request body, and response checks: `body contains`, `JSON field equals`,
  `JSON field exists`, `header contains`.
- **Alert confirmation (retries)** — a monitor must fail N consecutive checks (configurable
  1–5) before it is confirmed *down* and an alert fires, suppressing false positives. During
  confirmation it shows an amber *degraded* state.
- **Teams** — invite teammates by email (existing users join immediately; others get a
  one-time invite link bound to their address). Monitors are shared per active team; switch
  teams from the header. Alerts fan out to every team member's Telegram channels.
- **Auto-refresh** — the dashboard, monitor detail, and public status pages refresh live
  every 10s (toggleable).

## Responsible use & SSRF

Sentela runs **single, low-frequency probes** bounded by each monitor's interval
(60 seconds minimum) and per-plan monitor caps. It is a diagnostics tool — not a load /
stress-testing tool — and must only be used against systems you own or are authorized to
monitor.

The worker validates every target (and each redirect hop, plus DB `?host=` overrides) against
an SSRF guard: link-local / cloud-metadata (`169.254.0.0/16`) is **always blocked**;
private/loopback ranges are blocked unless `ALLOW_PRIVATE_TARGETS=true`. The Docker demo sets
it to `true` so it can monitor its own internal services — **leave it unset in production**.
Secret config values (Authorization headers, DB connection strings, Redis passwords) are
masked in API responses, stripped from the stored target URL, and never echoed into
error messages shown on the public status page. See [`/terms`](http://localhost:3000/terms)
and [`/about`](http://localhost:3000/about).

### Known limitations (hardening backlog)

- **DNS-rebinding / TOCTOU on the SSRF guard.** The guard resolves the host and the connector
  re-resolves at dial time; a fully robust fix pins the validated IP. Low risk in practice
  (same resolver), tracked for a follow-up.
- **Heartbeat endpoint has no rate limiting.** Tokens are 128-bit and unguessable, but a
  *leaked* token is replayable; put a rate limiter / WAF in front in production and rotate
  tokens if one leaks.
- **Billing is stubbed**; **gRPC / synthetic-browser / Lighthouse / server-agent** monitors are
  not implemented (see Check types).

## Project structure

```
src/
  app/
    (site)/        marketing + legal pages (home, pricing, about, terms, privacy, contacts)
    (auth)/        login, register
    dashboard/     dashboard, add monitor, monitor detail
    status/        public status page
    api/           auth, monitors, channels route handlers
  components/       UI components
  lib/             db, auth, session, checks, telegram, plans, monitors, channels, status
worker/            background check worker
db/schema.sql      database schema (also embedded for idempotent startup migration)
```
