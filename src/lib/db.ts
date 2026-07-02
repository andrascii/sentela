import { Pool, type QueryResult, type QueryResultRow } from "pg";

// Idempotent schema — kept in sync with db/schema.sql. Applied once per process
// so the app and worker both work even on a fresh database.
const SCHEMA_SQL = `
BEGIN;
-- Serialize concurrent app/worker migrations so the DDL + backfill can't race
-- (auto-released on COMMIT/ROLLBACK).
SELECT pg_advisory_xact_lock(8765432123);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status_slug   TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan       TEXT NOT NULL DEFAULT 'starter',
  status     TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS teams (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT 'Моя команда',
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id);

CREATE TABLE IF NOT EXISTS team_members (
  id         SERIAL PRIMARY KEY,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

CREATE TABLE IF NOT EXISTS team_invites (
  id          SERIAL PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  token       TEXT UNIQUE NOT NULL,
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_team_invites_team ON team_invites(team_id);

CREATE TABLE IF NOT EXISTS monitors (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'http',
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  status           TEXT NOT NULL DEFAULT 'pending',
  ssl_expiry       TIMESTAMPTZ,
  last_checked_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_id);

-- Columns added in later iterations (idempotent).
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS fail_threshold INTEGER NOT NULL DEFAULT 2;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_monitors_team ON monitors(team_id);

CREATE TABLE IF NOT EXISTS monitor_checks (
  id            SERIAL PRIMARY KEY,
  monitor_id    INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  latency_ms    INTEGER,
  status_code   INTEGER,
  error_message TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monitor_checks_monitor
  ON monitor_checks(monitor_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS notification_channels (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'telegram',
  target     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON notification_channels(user_id);

-- Which probe node ran a check (multi-region live feed). Nullable: a single-region
-- deployment leaves it NULL; extra workers set REGION and tag their checks.
ALTER TABLE monitor_checks ADD COLUMN IF NOT EXISTS region TEXT;

-- Collaborative, live incident timeline: team members annotate incidents in real
-- time (streamed over the realtime WS service; see ws-server/index.ts).
CREATE TABLE IF NOT EXISTS incident_comments (
  id           SERIAL PRIMARY KEY,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  monitor_id   INTEGER REFERENCES monitors(id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_email TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_comments_team
  ON incident_comments(team_id, created_at DESC);

-- Billing (YooKassa recurring) — idempotent.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method_id TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS price_rub INTEGER;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renew_last_attempt TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS payments (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'yookassa',
  provider_payment_id TEXT UNIQUE NOT NULL,
  plan                TEXT NOT NULL,
  amount_rub          INTEGER NOT NULL,
  status              TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'initial',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);

-- Backfill teams for existing data (idempotent).
DO $$
BEGIN
  -- Personal team for every user that doesn't own one.
  INSERT INTO teams (name, owner_id)
  SELECT 'Личная команда', u.id FROM users u
  WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.owner_id = u.id);

  -- Owner membership for every team.
  INSERT INTO team_members (team_id, user_id, role)
  SELECT t.id, t.owner_id, 'owner' FROM teams t
  WHERE NOT EXISTS (
    SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = t.owner_id
  )
  ON CONFLICT (team_id, user_id) DO NOTHING;

  -- Attach orphan monitors to their creator's personal team.
  UPDATE monitors mo
  SET team_id = (
    SELECT t.id FROM teams t WHERE t.owner_id = mo.user_id ORDER BY t.id LIMIT 1
  )
  WHERE mo.team_id IS NULL;
END $$;

COMMIT;
`;

// Reuse a single pool across hot reloads in dev and across the process in prod.
const globalForDb = globalThis as unknown as {
  __infrapulsePool?: Pool;
  __infrapulseMigrated?: Promise<void>;
};

export function getPool(): Pool {
  if (!globalForDb.__infrapulsePool) {
    const connectionString =
      process.env.DATABASE_URL ||
      "postgres://edgepulse:edgepulse_password@localhost:5432/edgepulse";
    globalForDb.__infrapulsePool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForDb.__infrapulsePool;
}

/** Apply the schema once per process. Safe to call repeatedly. */
export function ensureMigrated(): Promise<void> {
  if (!globalForDb.__infrapulseMigrated) {
    globalForDb.__infrapulseMigrated = getPool()
      .query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        // Reset so a later call can retry after a transient failure.
        globalForDb.__infrapulseMigrated = undefined;
        throw err;
      });
  }
  return globalForDb.__infrapulseMigrated;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  await ensureMigrated();
  return getPool().query<T>(text, params as never[]);
}

/** Run a query without triggering migration (used by ensureMigrated itself). */
export async function rawQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}
