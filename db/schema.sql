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

-- v8: editable email templates (one row per event_type)
CREATE TABLE IF NOT EXISTS email_templates (
  id           SERIAL PRIMARY KEY,
  event_type   TEXT UNIQUE NOT NULL,    -- new_lead | lead_assigned | new_device_login | morning_followups | day_end
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body_html    TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Track which devices each user has signed in from. Drives the
-- new_device_login email — fires only when an unfamiliar fingerprint shows up.
CREATE TABLE IF NOT EXISTS user_devices (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,            -- sha256 of UA + IP
  user_agent    TEXT,
  ip            TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);

-- ---- v10: admin-managed tag library --------------------------------
-- Tags are now centrally managed by admins. Non-admin users can only
-- choose from this list, not create new tags freeform. The leads.tags
-- column stays as a comma-separated string (back-compat) but now only
-- contains values from this table when set via the UI.
CREATE TABLE IF NOT EXISTS tag_library (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  color        TEXT NOT NULL DEFAULT '#6366f1',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- v10: qualified flag --------------------------------
-- Separate from status — answers "did this lead pass our minimum
-- qualification?" regardless of where they are in the pipeline.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- ---- v11: TAT (Turn-Around Time) tracking ----------------------------
-- A lead's lifecycle is recorded as two parallel logs:
--   1. lead_stage_log — every time the status changes, log from→to + when.
--   2. lead_actions   — every "action" the user takes on the lead
--      (created, status_change, remark, call, followup_set). The first
--      such action AFTER `created_at` is the "1st action"; the next is
--      the "2nd action", etc. Used by the action-timeline report.
CREATE TABLE IF NOT EXISTS lead_stage_log (
  id              SERIAL PRIMARY KEY,
  lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status_id  INTEGER,
  to_status_id    INTEGER,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  duration_s      INTEGER,                  -- seconds spent in from_status (filled when leaving it)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stage_log_lead ON lead_stage_log(lead_id, created_at);

CREATE TABLE IF NOT EXISTS lead_actions (
  id            SERIAL PRIMARY KEY,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  action_type   TEXT NOT NULL,             -- created | status_change | remark | call | followup_set | assigned
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  meta_json     JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_actions_lead ON lead_actions(lead_id, created_at);

-- TAT threshold per status (admin-configured). If absent, no TAT enforcement.
CREATE TABLE IF NOT EXISTS tat_thresholds (
  id                 SERIAL PRIMARY KEY,
  status_id          INTEGER UNIQUE REFERENCES statuses(id) ON DELETE CASCADE,
  threshold_minutes  INTEGER NOT NULL DEFAULT 60,
  is_active          INTEGER NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per lead-stage breach. Escalation level walks up: 1=employee,
-- 2=manager, 3=admin. resolved_at populated when the lead leaves the stage.
CREATE TABLE IF NOT EXISTS tat_violations (
  id                 SERIAL PRIMARY KEY,
  lead_id            INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status_id          INTEGER,
  user_id            INTEGER,                  -- the assigned salesperson
  threshold_minutes  INTEGER,
  triggered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ,
  escalation_level   INTEGER NOT NULL DEFAULT 1,
  last_escalated_at  TIMESTAMPTZ,
  notes              TEXT
);
CREATE INDEX IF NOT EXISTS idx_tat_v_open ON tat_violations(lead_id) WHERE resolved_at IS NULL;

-- ---- v12: WhatsBot module ------------------------------------
-- Enrich whatsapp_messages with media + reply tracking
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS user_id      INTEGER;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS message_type TEXT;       -- text|image|video|audio|document|template|button|interactive
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_url    TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_id     TEXT;       -- WhatsApp media id (for retrieval)
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS reply_to     TEXT;       -- wa_message_id of the message being replied to
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS read_at      TIMESTAMPTZ;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON whatsapp_messages(from_number, to_number, created_at);
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS error_text TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS template_name TEXT;

-- ---- v13: Google Ads / UTM attribution as first-class columns ------
-- The webhook handler already stores these in meta_json, but as columns
-- they're filterable / reportable / displayable in the leads list.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gclid          TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gad_campaignid TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source     TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_medium     TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_campaign   TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_term       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_content    TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_gclid    ON leads(gclid);
CREATE INDEX IF NOT EXISTS idx_leads_utm      ON leads(utm_source, utm_campaign);

-- ---- v14: HR fields on users -------------------------------
-- Onboarding info admins / HR want to capture per employee.
ALTER TABLE users ADD COLUMN IF NOT EXISTS father_name           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_email        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS aadhaar_number        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pan_number            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_company          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_name  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_name      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_phone     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_relation  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_name      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_phone     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_relation  TEXT;

-- Cached approved templates from Meta (refreshed periodically)
CREATE TABLE IF NOT EXISTS wa_templates (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  language        TEXT NOT NULL,
  status          TEXT,                       -- APPROVED | PENDING | REJECTED
  category        TEXT,                       -- MARKETING | UTILITY | AUTHENTICATION
  body_text       TEXT,
  components_json JSONB,
  body_params     INTEGER NOT NULL DEFAULT 0,
  header_type     TEXT,
  has_buttons     INTEGER NOT NULL DEFAULT 0,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, language)
);

-- Outbound campaigns (broadcast a template to many recipients)
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  relation_type    TEXT NOT NULL DEFAULT 'leads',  -- leads|users (for now leads)
  template_name    TEXT NOT NULL,
  template_language TEXT NOT NULL DEFAULT 'en_US',
  variables_json   JSONB,                      -- [{var:'V1', value:'@{name}'}, ...]
  image_url        TEXT,
  filter_json      JSONB,                      -- {status_id, source, assigned_to, tag, ids[]}
  scheduled_at     TIMESTAMPTZ,
  send_now         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft',  -- draft|queued|sending|paused|completed|failed
  recipients_total INTEGER NOT NULL DEFAULT 0,
  recipients_sent  INTEGER NOT NULL DEFAULT 0,
  recipients_failed INTEGER NOT NULL DEFAULT 0,
  recipients_delivered INTEGER NOT NULL DEFAULT 0,
  recipients_read  INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wa_camp_status ON wa_campaigns(status);

-- Per-recipient row of a campaign (so we can resume / track / show progress)
CREATE TABLE IF NOT EXISTS wa_campaign_targets (
  id            SERIAL PRIMARY KEY,
  campaign_id   INTEGER NOT NULL REFERENCES wa_campaigns(id) ON DELETE CASCADE,
  lead_id       INTEGER,
  phone         TEXT NOT NULL,
  name          TEXT,
  rendered_message TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|delivered|read|failed
  wa_message_id TEXT,
  error         TEXT,
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_camp_targets ON wa_campaign_targets(campaign_id, status);

-- Message bots — when an incoming message matches `trigger`, send `reply_text`
CREATE TABLE IF NOT EXISTS wa_message_bots (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  relation_type   TEXT NOT NULL DEFAULT 'leads',
  reply_text      TEXT NOT NULL,
  reply_type      TEXT NOT NULL DEFAULT 'contains',   -- exact | contains
  trigger_text    TEXT NOT NULL,                       -- comma-separated keywords
  header          TEXT,
  footer          TEXT,
  buttons_json    JSONB,                               -- option 1: reply buttons
  cta_button_json JSONB,                               -- option 2: CTA button
  image_url       TEXT,                                -- option 3: image
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Template bots — when an incoming message matches `trigger`, send a template
CREATE TABLE IF NOT EXISTS wa_template_bots (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  relation_type   TEXT NOT NULL DEFAULT 'leads',
  template_name   TEXT NOT NULL,
  template_language TEXT NOT NULL DEFAULT 'en_US',
  variables_json  JSONB,
  reply_type      TEXT NOT NULL DEFAULT 'exact',
  trigger_text    TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Activity log — every Meta API request we make
CREATE TABLE IF NOT EXISTS wa_activity_log (
  id              SERIAL PRIMARY KEY,
  category        TEXT NOT NULL,    -- campaign|template_bot|message_bot|chat|template_sync
  name            TEXT,
  template_name   TEXT,
  response_code   INTEGER,
  type            TEXT,             -- leads|users
  request_json    JSONB,
  response_json   JSONB,
  recorded_on     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_act_cat ON wa_activity_log(category, recorded_on DESC);
