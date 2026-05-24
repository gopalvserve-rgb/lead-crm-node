/**
 * DEVICE_DIAG_v1 (Celeste / Stockbox — single-tenant variant)
 *
 * Same diagnosis logic as smartcrm-saas, but no super-admin / no per-tenant
 * pool routing — runs against the single tenant DB directly. Admin-only.
 *
 * Endpoints:
 *   api_recHealth_byTenant (admin) — per-user diagnosis
 *   api_devicediag_ingest  (any logged-in user) — writes telemetry
 *   api_recHealth_timeline (admin) — drilldown events for one user
 *
 * NO edits to any locked recording file.
 */
'use strict';

const db = require('../db/pg');
const DAY = 24 * 60 * 60 * 1000;

function _daysAgo(iso) {
  if (!iso) return null;
  const t = (iso instanceof Date) ? iso.getTime() : Date.parse(String(iso));
  if (!t || isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY);
}

async function _requireAdmin(token) {
  const { authUser } = require('../utils/auth');
  const me = await authUser(token);
  if (!me) throw new Error('Auth required');
  if (me.role !== 'admin' && me.role !== 'super_admin') throw new Error('Admin only');
  return me;
}

async function _decodeUser(token) {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(String(token || '').replace(/^Bearer\s+/i, ''));
    return decoded && decoded.id ? Number(decoded.id) || null : null;
  } catch (e) { return null; }
}

async function _ensureDiagTable() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS device_diag_events (" +
    "  id BIGSERIAL PRIMARY KEY, user_id BIGINT, device_id TEXT," +
    "  event_type TEXT NOT NULL, severity TEXT, step TEXT," +
    "  payload JSONB, created_at TIMESTAMPTZ DEFAULT NOW())"
  ).catch(() => {});
  await db.query("CREATE INDEX IF NOT EXISTS idx_devicediag_user_created ON device_diag_events (user_id, created_at DESC)").catch(() => {});
}

async function api_recHealth_byTenant(token, opts) {
  await _requireAdmin(token);

  let users;
  try {
    users = await db.query(
      "SELECT id, name, email, role, created_at, COALESCE(last_login_at, last_seen_at) AS last_login_at" +
      " FROM users WHERE COALESCE(is_active, true) = true ORDER BY name ASC"
    ).then(r => r.rows || []);
  } catch (_) {
    try {
      users = await db.query("SELECT id, name, email, role, created_at, last_login_at FROM users ORDER BY name ASC")
        .then(r => r.rows || []);
    } catch (_e) {
      users = await db.query("SELECT id, name, email, role, created_at FROM users ORDER BY name ASC")
        .then(r => r.rows || []).catch(() => []);
    }
  }

  const recRows = await db.query(
    "SELECT user_id, MAX(uploaded_at) AS last_uploaded_at, MAX(created_at) AS last_created_at," +
    " COUNT(*) AS total_count, COUNT(*) FILTER (WHERE lead_id IS NOT NULL) AS matched_count" +
    " FROM recordings WHERE COALESCE(uploaded_at, created_at) > NOW() - INTERVAL '60 days'" +
    " GROUP BY user_id"
  ).then(r => r.rows || []).catch(() => []);
  const recByUser = new Map(recRows.map(r => [Number(r.user_id) || null, r]));

  const callRows = await db.query(
    "SELECT user_id, MAX(created_at) AS last_event_at, COUNT(*) AS total_count" +
    " FROM call_events WHERE created_at > NOW() - INTERVAL '60 days' GROUP BY user_id"
  ).then(r => r.rows || []).catch(() => []);
  const callByUser = new Map(callRows.map(r => [Number(r.user_id) || null, r]));

  let fcmRows = [];
  try {
    fcmRows = await db.query("SELECT user_id, MAX(registered_at) AS last_registered_at FROM fcm_tokens GROUP BY user_id")
      .then(r => r.rows || []);
  } catch (_) {
    try {
      fcmRows = await db.query("SELECT user_id, MAX(created_at) AS last_registered_at FROM fcm_tokens GROUP BY user_id")
        .then(r => r.rows || []);
    } catch (_e) { fcmRows = []; }
  }
  const fcmByUser = new Map(fcmRows.map(r => [Number(r.user_id) || null, r]));

  const perUser = users.map(u => {
    const r = recByUser.get(Number(u.id)) || {};
    const c = callByUser.get(Number(u.id)) || {};
    const f = fcmByUser.get(Number(u.id)) || {};
    const lastLoginIso = u.last_login_at || u.created_at;
    const lastRecIso = r.last_uploaded_at || r.last_created_at;
    const lastCallIso = c.last_event_at;
    const lastFcmIso  = f.last_registered_at;
    const total = Number(r.total_count) || 0;
    const matched = Number(r.matched_count) || 0;
    const matchedPct = total > 0 ? Math.round((matched / total) * 100) : null;

    let diag = { step: 'healthy', severity: 'green', message: 'All signals healthy' };
    const dLogin = _daysAgo(lastLoginIso);
    const dCall  = _daysAgo(lastCallIso);
    const dRec   = _daysAgo(lastRecIso);
    const dFcm   = _daysAgo(lastFcmIso);

    if (dLogin === null) {
      diag = { step: 'app_open', severity: 'red', message: 'User never logged in to mobile app' };
    } else if (dLogin > 7) {
      diag = { step: 'app_open', severity: 'red', message: 'App not opened in ' + dLogin + ' days' };
    } else if (dFcm === null) {
      diag = { step: 'fcm_register', severity: 'yellow', message: 'Never registered FCM token' };
    } else if (dFcm > 14) {
      diag = { step: 'fcm_register', severity: 'yellow', message: 'FCM token last refreshed ' + dFcm + 'd ago' };
    } else if (dCall === null) {
      diag = { step: 'call_detect', severity: 'red', message: 'No call events ever — Phone perm or PhoneStateReceiver not firing' };
    } else if (dCall > 3) {
      diag = { step: 'call_detect', severity: 'red', message: 'Last call event ' + dCall + 'd ago — Phone perm revoked OR app killed (Sleeping Apps)' };
    } else if (dRec === null) {
      diag = { step: 'rec_upload', severity: 'red', message: 'Calls detected but no recording uploaded — Storage perm OR folder path wrong' };
    } else if (dRec > 3) {
      diag = { step: 'rec_upload', severity: 'red', message: 'Last recording ' + dRec + 'd ago — Sync worker stopped (Sleeping Apps / All-Files-Access revoked)' };
    } else if (matchedPct !== null && matchedPct < 50 && total >= 4) {
      diag = { step: 'lead_match', severity: 'yellow', message: 'Only ' + matchedPct + '% matched to a lead' };
    }

    return {
      user_id: u.id, user_name: u.name || u.email, user_email: u.email, user_role: u.role,
      last_login_at: lastLoginIso, last_fcm_at: lastFcmIso,
      last_call_event_at: lastCallIso, last_recording_at: lastRecIso,
      days_since_login: dLogin, days_since_call: dCall, days_since_recording: dRec,
      recordings_total: total, recordings_matched: matched, recordings_matched_pct: matchedPct,
      diagnosis: diag,
    };
  });

  const sevRank = { red: 0, yellow: 1, green: 2 };
  perUser.sort((a, b) =>
    (sevRank[a.diagnosis.severity] ?? 3) - (sevRank[b.diagnosis.severity] ?? 3)
    || (b.recordings_total || 0) - (a.recordings_total || 0));

  return {
    ok: true,
    summary: {
      users_total: perUser.length,
      users_red:    perUser.filter(u => u.diagnosis.severity === 'red').length,
      users_yellow: perUser.filter(u => u.diagnosis.severity === 'yellow').length,
      users_green:  perUser.filter(u => u.diagnosis.severity === 'green').length,
    },
    users: perUser
  };
}

async function api_devicediag_ingest(token, payload) {
  const userId = await _decodeUser(token);
  await _ensureDiagTable();

  const events = Array.isArray(payload && payload.events) ? payload.events : [];
  const deviceId = String((payload && payload.device_id) || '').slice(0, 64) || null;
  if (!events.length) return { ok: true, written: 0 };

  const batch = events.slice(0, 50);
  let written = 0;
  for (const ev of batch) {
    try {
      const created = ev && ev.created_at_ms && Number(ev.created_at_ms)
                       ? new Date(Number(ev.created_at_ms)) : new Date();
      await db.query(
        "INSERT INTO device_diag_events (user_id, device_id, event_type, severity, step, payload, created_at)" +
        " VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          userId, deviceId,
          String(ev.event_type || 'unknown').slice(0, 64),
          String(ev.severity || 'info').slice(0, 16),
          String(ev.step || '').slice(0, 32) || null,
          ev.payload && typeof ev.payload === 'object' ? ev.payload : { raw: ev.payload },
          created,
        ]
      );
      written++;
    } catch (_e) {}
  }
  try {
    await db.query("DELETE FROM device_diag_events WHERE id < (SELECT MAX(id) - 5000 FROM device_diag_events)");
  } catch (_e) {}
  return { ok: true, written };
}

async function api_recHealth_timeline(token, opts) {
  await _requireAdmin(token);
  await _ensureDiagTable();
  const userId = Number((opts && opts.user_id) || 0) || null;
  const limit  = Math.min(Number((opts && opts.limit) || 200), 500);
  const where = userId ? 'WHERE user_id = $1' : '';
  const params = userId ? [userId, limit] : [limit];
  const sql = "SELECT id, user_id, device_id, event_type, severity, step, payload, created_at" +
              " FROM device_diag_events " + where +
              " ORDER BY created_at DESC LIMIT $" + params.length;
  const rows = await db.query(sql, params).then(r => r.rows || []);
  return { ok: true, events: rows };
}

module.exports = {
  api_recHealth_byTenant,
  api_devicediag_ingest,
  api_recHealth_timeline,
};
