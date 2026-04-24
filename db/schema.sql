-- ============================================================
-- Lead CRM — PostgreSQL schema
-- ============================================================
-- Run with:  psql $DATABASE_URL -f db/schema.sql
-- or via:    npm run migrate
-- ============================================================

-- ---- users --------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  phone           TEXT,
  role            TEXT NOT NULL DEFAULT 'sales',  -- admin|manager|team_leader|sales
  password_hash   TEXT NOT NULL,
  parent_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department      TEXT,
  designation     TEXT,
  photo_url       TEXT,
  monthly_salary  NUMERIC(14,2) DEFAULT 0,
  joining_date    DATE,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_role    ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_parent  ON users(parent_id);

-- ---- statuses -----------------------------------------------
CREATE TABLE IF NOT EXISTS statuses (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6b7280',
  sort_order  INTEGER NOT NULL DEFAULT 10,
  is_final    INTEGER NOT NULL DEFAULT 0
);

-- ---- sources ------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id         SERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1
);

-- ---- products -----------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  price        NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ---- custom_fields ------------------------------------------
CREATE TABLE IF NOT EXISTS custom_fields (
  id             SERIAL PRIMARY KEY,
  key            TEXT UNIQUE NOT NULL,
  label          TEXT NOT NULL,
  field_type     TEXT NOT NULL DEFAULT 'text',  -- text|number|date|select|multiselect|checkbox|textarea
  options        TEXT,                          -- pipe-separated for select/multiselect
  is_required    INTEGER NOT NULL DEFAULT 0,
  show_in_list   INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 10,
  is_active      INTEGER NOT NULL DEFAULT 1
);

-- ---- leads --------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                     SERIAL PRIMARY KEY,
  name                   TEXT NOT NULL,
  phone                  TEXT,
  alt_phone              TEXT,
  whatsapp               TEXT,
  email                  TEXT,
  source                 TEXT,
  source_ref             TEXT,
  product                TEXT,
  product_id             INTEGER REFERENCES products(id) ON DELETE SET NULL,
  status_id              INTEGER REFERENCES statuses(id) ON DELETE SET NULL,
  assigned_to            INTEGER REFERENCES users(id)   ON DELETE SET NULL,
  created_by             INTEGER REFERENCES users(id)   ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_status_change_at  TIMESTAMPTZ,
  next_followup_at       TIMESTAMPTZ,
  is_duplicate           INTEGER NOT NULL DEFAULT 0,
  duplicate_of           INTEGER,
  tags                   TEXT,
  notes                  TEXT,
  address                TEXT,
  city                   TEXT,
  state                  TEXT,
  pincode                TEXT,
  country                TEXT,
  company                TEXT,
  value                  NUMERIC(14,2),
  currency               TEXT,
  meta_json              JSONB,
  extra_json             JSONB
);
CREATE INDEX IF NOT EXISTS idx_leads_phone    ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_email    ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status_id);
CREATE INDEX IF NOT EXISTS idx_leads_created  ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_source   ON leads(source);

-- ---- remarks ------------------------------------------------
CREATE TABLE IF NOT EXISTS remarks (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id)           ON DELETE SET NULL,
  remark     TEXT NOT NULL,
  status_id  INTEGER REFERENCES statuses(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_remarks_lead ON remarks(lead_id);

-- ---- followups ----------------------------------------------
CREATE TABLE IF NOT EXISTS followups (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at     TIMESTAMPTZ,
  note       TEXT,
  is_done    INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(user_id);
CREATE INDEX IF NOT EXISTS idx_followups_lead ON followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_followups_due  ON followups(due_at);

-- ---- assignment_rules ---------------------------------------
CREATE TABLE IF NOT EXISTS assignment_rules (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  field        TEXT NOT NULL,
  operator     TEXT NOT NULL,
  value        TEXT NOT NULL,
  assigned_to  TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 100,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ---- notifications ------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT,
  title      TEXT,
  body       TEXT,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- ---- attendance ---------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  check_in         TIMESTAMPTZ,
  check_out        TIMESTAMPTZ,
  check_in_lat     NUMERIC(10,6),
  check_in_lng     NUMERIC(10,6),
  check_out_lat    NUMERIC(10,6),
  check_out_lng    NUMERIC(10,6),
  status           TEXT,  -- present|half_day|leave|absent
  notes            TEXT,
  UNIQUE (user_id, date)
);

-- ---- leaves -------------------------------------------------
CREATE TABLE IF NOT EXISTS leaves (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_date   DATE NOT NULL,
  to_date     DATE NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- tasks --------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_at        TIMESTAMPTZ,
  priority      TEXT DEFAULT 'normal',
  status        TEXT DEFAULT 'open',  -- open|in_progress|done|cancelled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);

-- ---- salaries -----------------------------------------------
CREATE TABLE IF NOT EXISTS salaries (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,  -- 'YYYY-MM'
  base        NUMERIC(14,2) NOT NULL DEFAULT 0,
  allowances  NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions  NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay     NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, month)
);

-- ---- bank_details -------------------------------------------
CREATE TABLE IF NOT EXISTS bank_details (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bank_name       TEXT,
  account_holder  TEXT,
  account_number  TEXT,
  ifsc            TEXT,
  branch          TEXT,
  upi_id          TEXT,
  notes           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- config -------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  id          SERIAL PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- whatsapp_messages --------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id             SERIAL PRIMARY KEY,
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  direction      TEXT NOT NULL,  -- in|out
  from_number    TEXT,
  to_number      TEXT,
  body           TEXT,
  wa_message_id  TEXT,
  status         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_lead ON whatsapp_messages(lead_id);

-- ---- webhook_log --------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_log (
  id           SERIAL PRIMARY KEY,
  source       TEXT NOT NULL,  -- meta|whatsapp|website
  payload      JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed    INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_source ON webhook_log(source, processed);

-- ---- idempotent column additions for existing DBs -----------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_status_change_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_duplicate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS duplicate_of INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_salary NUMERIC(14,2) DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS joining_date DATE;
ALTER TABLE remarks ADD COLUMN IF NOT EXISTS status_id INTEGER;
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS show_in_list INTEGER NOT NULL DEFAULT 0;

-- ---- automations --------------------------------------------
CREATE TABLE IF NOT EXISTS automations (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  event        TEXT NOT NULL,          -- lead_created | status_changed | lead_assigned | followup_due | source_is
  condition    TEXT,                   -- e.g. status_id=3 OR source=Website OR tag:vip
  channel      TEXT NOT NULL,          -- email | whatsapp | webhook
  recipient    TEXT,                   -- 'lead' | 'assignee' | 'admin' | specific email/phone
  subject      TEXT,
  template     TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automation_log (
  id            SERIAL PRIMARY KEY,
  automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  event         TEXT,
  channel       TEXT,
  recipient     TEXT,
  status        TEXT,   -- sent | failed | skipped
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auto_log_lead ON automation_log(lead_id);

-- v6: device + IP columns for attendance
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_info TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS ip TEXT;

-- v6: role permissions
CREATE TABLE IF NOT EXISTS role_permissions (
  id         SERIAL PRIMARY KEY,
  role       TEXT NOT NULL,
  permission TEXT NOT NULL,
  scope      TEXT,          -- 'global' | 'team' | 'self' | null
  is_granted INTEGER NOT NULL DEFAULT 1,
  UNIQUE (role, permission)
);

-- v7: in-app dialer + call recordings
CREATE TABLE IF NOT EXISTS lead_recordings (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone        TEXT,
  direction    TEXT,             -- 'out' | 'in' | 'missed'
  duration_s   INTEGER DEFAULT 0,
  device_path  TEXT,              -- original path on the device
  mime_type    TEXT,               -- e.g. audio/m4a
  size_bytes   INTEGER DEFAULT 0,
  audio_bytes  BYTEA,              -- the actual audio file (stored inline in PG)
  started_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_rec_lead    ON lead_recordings(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_rec_user    ON lead_recordings(user_id);
CREATE INDEX IF NOT EXISTS idx_lead_rec_created ON lead_recordings(created_at);

-- Call events timeline (every call_start / call_end logged, even without audio)
CREATE TABLE IF NOT EXISTS call_events (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone        TEXT,
  direction    TEXT,            -- out | in | missed
  event        TEXT,            -- outgoing_call | incoming_ringing | call_answered | call_ended
  duration_s   INTEGER DEFAULT 0,
  recording_id INTEGER REFERENCES lead_recordings(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_events_lead ON call_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_events_user ON call_events(user_id, created_at);
