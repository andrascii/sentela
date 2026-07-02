-- InfraPulse database schema
-- Applied automatically on first Postgres boot (docker-entrypoint-initdb.d)
-- and idempotently by the app/worker at startup (see src/lib/db.ts).

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status_slug   TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan               TEXT NOT NULL DEFAULT 'starter',
  status             TEXT NOT NULL DEFAULT 'active',
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ,
  auto_renew         BOOLEAN NOT NULL DEFAULT false,
  payment_method_id  TEXT,
  price_rub          INTEGER,
  renew_last_attempt TIMESTAMPTZ,
  canceled_at        TIMESTAMPTZ
);

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
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id              INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  url                  TEXT NOT NULL,
  type                 TEXT NOT NULL DEFAULT 'http',
  interval_seconds     INTEGER NOT NULL DEFAULT 300,
  status               TEXT NOT NULL DEFAULT 'pending',
  ssl_expiry           TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ,
  config               JSONB NOT NULL DEFAULT '{}'::jsonb,
  fail_threshold       INTEGER NOT NULL DEFAULT 2,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  group_name           TEXT,
  heartbeat_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_monitors_team ON monitors(team_id);

CREATE TABLE IF NOT EXISTS monitor_checks (
  id            SERIAL PRIMARY KEY,
  monitor_id    INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  latency_ms    INTEGER,
  status_code   INTEGER,
  error_message TEXT,
  region        TEXT,
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

-- Collaborative, live incident timeline (streamed over the realtime WS service).
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
