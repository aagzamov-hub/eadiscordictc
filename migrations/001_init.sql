-- Core schema for the Discord connector. Plain Postgres, no provider-specific features.

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id           BIGSERIAL PRIMARY KEY,
  channel_id   TEXT        NOT NULL,
  content      TEXT        NOT NULL,
  cron         TEXT,                       -- recurring schedule (5-field cron); NULL for one-off
  timezone     TEXT        NOT NULL,
  next_run_at  TIMESTAMPTZ NOT NULL,
  last_run_at  TIMESTAMPTZ,
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  fail_count   INTEGER     NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx ON scheduled_messages (next_run_at) WHERE active;

-- A cohort maps Discord places (channels, categories, roles) to the people responsible for them.
CREATE TABLE IF NOT EXISTS cohorts (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT   NOT NULL UNIQUE,
  channel_ids           TEXT[] NOT NULL DEFAULT '{}',
  category_ids          TEXT[] NOT NULL DEFAULT '{}',
  role_ids              TEXT[] NOT NULL DEFAULT '{}',
  facilitator_user_ids  TEXT[] NOT NULL DEFAULT '{}',   -- Discord user IDs to DM
  alert_channel_id      TEXT,                           -- private facilitator channel
  planner_plan_id       TEXT,
  planner_bucket_id     TEXT,
  planner_assignee_ids  TEXT[] NOT NULL DEFAULT '{}',   -- Entra ID (Azure AD) user object IDs
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS triage_categories (
  name               TEXT PRIMARY KEY,
  description        TEXT    NOT NULL,
  alert_immediately  BOOLEAN NOT NULL DEFAULT FALSE,  -- alert facilitators right away (high/critical always alert)
  dm_facilitators    BOOLEAN NOT NULL DEFAULT FALSE,
  create_ticket      BOOLEAN NOT NULL DEFAULT FALSE,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO triage_categories (name, description, alert_immediately, dm_facilitators, create_ticket) VALUES
  ('abusive',          'Harassment, hate, threats, slurs, sexual content, or bullying aimed at anyone.', TRUE,  TRUE,  TRUE),
  ('urgent',           'Time-critical problems: safety concerns, someone blocked right before a deadline or live session, outages affecting many people.', TRUE, TRUE, TRUE),
  ('technical_support','Problems with platforms, logins, links, tools, software, or access.', FALSE, FALSE, TRUE),
  ('course_support',   'Questions about the course: deadlines, assignments, grading, schedule, enrolment, certificates.', FALSE, FALSE, TRUE),
  ('content_support',  'Questions or errors about the learning material itself: unclear instructions, broken or wrong content.', FALSE, FALSE, TRUE)
ON CONFLICT (name) DO NOTHING;

-- Only messages that need a human are stored here (not general chatter).
CREATE TABLE IF NOT EXISTS triage_events (
  id               BIGSERIAL PRIMARY KEY,
  guild_id         TEXT,
  channel_id       TEXT NOT NULL,
  message_id       TEXT NOT NULL UNIQUE,
  author_id        TEXT NOT NULL,
  author_name      TEXT,
  excerpt          TEXT NOT NULL,
  category         TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  summary          TEXT NOT NULL,
  cohort_id        BIGINT REFERENCES cohorts(id) ON DELETE SET NULL,
  alerted          BOOLEAN NOT NULL DEFAULT FALSE,
  ticket_id        TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS triage_events_status_idx ON triage_events (status, created_at DESC);

-- Destructive actions wait here until a human approves them.
CREATE TABLE IF NOT EXISTS pending_actions (
  id           BIGSERIAL PRIMARY KEY,
  action       TEXT  NOT NULL,
  params       JSONB NOT NULL,
  summary      TEXT  NOT NULL,
  status       TEXT  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','failed')),
  result       JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tool        TEXT    NOT NULL,
  params      JSONB,
  ok          BOOLEAN NOT NULL,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
