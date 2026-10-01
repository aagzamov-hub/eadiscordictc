-- Multi-server cohorts, hashtag tracking, email notifications, Wrike sync.

-- A cohort can now be a whole Discord server (one server per cohort).
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS code TEXT;                      -- short label, e.g. C01 (also the Wrike "Cohort" value)
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS guild_id TEXT;                  -- the cohort's Discord server
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS announcement_channel_id TEXT;   -- default target for "post to all cohorts"
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS notify_emails TEXT[] NOT NULL DEFAULT '{}'; -- critical alerts + weekly recap
CREATE UNIQUE INDEX IF NOT EXISTS cohorts_code_idx ON cohorts (code) WHERE code IS NOT NULL;

-- Follow-ups come from staff hashtags and quiet-learner checks.
INSERT INTO triage_categories (name, description, alert_immediately, dm_facilitators, create_ticket) VALUES
  ('follow_up', 'A facilitator asked for a follow-up with this learner.', FALSE, FALSE, TRUE)
ON CONFLICT (name) DO NOTHING;

-- Hashtags people type in Discord, and what each one does.
--   ticket   → treated as a request for help in `category` (AI may still downgrade obvious misuse)
--   count    → only counted for engagement stats and the recap
--   followup / escalate / resolve → staff-only actions on the message they reply to
CREATE TABLE IF NOT EXISTS hashtags (
  tag          TEXT PRIMARY KEY,                       -- lowercase, without '#'
  action       TEXT NOT NULL CHECK (action IN ('ticket','count','followup','escalate','resolve')),
  category     TEXT,                                   -- triage category for 'ticket'
  min_severity TEXT CHECK (min_severity IN ('low','medium','high','critical')),
  staff_only   BOOLEAN NOT NULL DEFAULT FALSE,
  description  TEXT NOT NULL DEFAULT ''
);

INSERT INTO hashtags (tag, action, category, min_severity, staff_only, description) VALUES
  ('urgent',   'ticket',   'urgent',           'high',   FALSE, 'Needs a facilitator now'),
  ('blocker',  'ticket',   'course_support',   'high',   FALSE, 'Learner cannot continue'),
  ('help',     'ticket',   'course_support',   'medium', FALSE, 'Question for a facilitator'),
  ('question', 'ticket',   'course_support',   'medium', FALSE, 'Question for a facilitator'),
  ('tech',     'ticket',   'technical_support','medium', FALSE, 'Platform, login or tool problem'),
  ('content',  'ticket',   'content_support',  'medium', FALSE, 'Error or unclear course material'),
  ('feedback', 'count',    NULL, NULL, FALSE, 'Feedback, collected for the weekly recap'),
  ('win',      'count',    NULL, NULL, FALSE, 'A learner success, highlighted in the recap'),
  ('capstone', 'count',    NULL, NULL, FALSE, 'Capstone work'),
  ('resource', 'count',    NULL, NULL, FALSE, 'A shared resource'),
  ('followup', 'followup', 'follow_up', 'medium', TRUE, 'Staff: create a follow-up task about the replied-to message'),
  ('escalate', 'escalate', 'urgent',    'high',   TRUE, 'Staff: escalate the replied-to message to the program lead'),
  ('resolved', 'resolve',  NULL, NULL, TRUE, 'Staff: close the ticket for the replied-to message')
ON CONFLICT (tag) DO NOTHING;
INSERT INTO hashtags (tag, action, description)
  SELECT 'week' || n, 'count', 'Week ' || n FROM generate_series(1, 14) AS n
ON CONFLICT (tag) DO NOTHING;

-- One row per hashtag use. author_id is only stored when TRACK_LEARNER_ACTIVITY=true.
CREATE TABLE IF NOT EXISTS hashtag_events (
  id          BIGSERIAL PRIMARY KEY,
  tag         TEXT NOT NULL,
  cohort_id   BIGINT REFERENCES cohorts(id) ON DELETE SET NULL,
  guild_id    TEXT,
  channel_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  author_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, tag)
);
CREATE INDEX IF NOT EXISTS hashtag_events_cohort_idx ON hashtag_events (cohort_id, created_at);

-- Thread grouping and ticket sync.
ALTER TABLE triage_events ADD COLUMN IF NOT EXISTS thread_key TEXT;          -- channel/thread the conversation lives in
ALTER TABLE triage_events ADD COLUMN IF NOT EXISTS source_tag TEXT;          -- hashtag that triggered it, if any
ALTER TABLE triage_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS triage_events_ticket_idx ON triage_events (ticket_id) WHERE ticket_id IS NOT NULL;

-- What was emailed (no message bodies; recipients only for staff notifications, never for learner nudges).
CREATE TABLE IF NOT EXISTS email_log (
  id               BIGSERIAL PRIMARY KEY,
  kind             TEXT NOT NULL,          -- critical_alert | weekly_recap | nudge
  subject          TEXT NOT NULL,
  recipient_count  INTEGER NOT NULL,
  recipients       TEXT[],                 -- staff only; NULL for learner nudges
  cohort_id        BIGINT REFERENCES cohorts(id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN ('sent','preview','failed')),
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  job        TEXT PRIMARY KEY,
  last_run   TIMESTAMPTZ NOT NULL
);
