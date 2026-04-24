/**
 * routes/recordings.js — Call recordings + call event logging
 *
 * Recordings are stored as BYTEA in Postgres for simplicity (Railway disk
 * isn't persistent across deploys). For files >2MB this is fine; for heavier
 * use move to S3/R2.
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

/** Find a lead by matching the last 10 digits of the phone. */
async function _findLeadByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const tail = digits.slice(-10);
  const { rows } = await db.query(
    `SELECT * FROM leads WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE $1
       OR regexp_replace(whatsapp, '[^0-9]', '', 'g') LIKE $1
       OR regexp_replace(alt_phone, '[^0-9]', '', 'g') LIKE $1
     LIMIT 1`,
    ['%' + tail]
  );
  return rows[0] || null;
}

/**
 * Log a generic call event (no audio). Used by the native broadcast receiver
 * every time TelephonyManager fires an event, so the call history is complete
 * even for calls without recording.
 */
async function api_call_logEvent(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const lead = await _findLeadByPhone(p.phone);
  await db.insert('call_events', {
    lead_id: lead ? lead.id : null,
    user_id: me.id,
    phone: p.phone || '',
    direction: p.direction || (p.event === 'incoming_ringing' ? 'in' : 'out'),
    event: p.event || 'unknown',
    duration_s: Number(p.duration_s) || 0,
    recording_id: p.recording_id || null,
    created_at: db.nowIso()
  });
  return { ok: true, lead_id: lead ? lead.id : null };
}

/** List recordings for a lead (newest first). Returns metadata only, not bytes. */
async function api_leads_recordings(token, leadId) {
  await authUser(token);
  const { rows } = await db.query(
    `SELECT id, lead_id, user_id, phone, direction, duration_s,
            device_path, mime_type, size_bytes, started_at, created_at
       FROM lead_recordings
      WHERE lead_id = $1
      ORDER BY created_at DESC`,
    [leadId]
  );
  return rows;
}

/** Recent calls for the current user (call history list). */
async function api_call_history(token, limit) {
  const me = await authUser(token);
  const lim = Math.min(Number(limit) || 100, 500);
  const { rows } = await db.query(
    `SELECT ce.id, ce.lead_id, ce.user_id, ce.phone, ce.direction, ce.event,
            ce.duration_s, ce.recording_id, ce.created_at,
            l.name AS lead_name,
            r.id AS rec_id, r.duration_s AS rec_duration, r.size_bytes AS rec_size
       FROM call_events ce
       LEFT JOIN leads l ON l.id = ce.lead_id
       LEFT JOIN lead_recordings r ON r.id = ce.recording_id
      WHERE ce.user_id = $1
      ORDER BY ce.created_at DESC
      LIMIT $2`,
    [me.id, lim]
  );
  return rows;
}

/** All recordings belonging to the current user, newest first. */
async function api_my_recordings(token, limit) {
  const me = await authUser(token);
  const lim = Math.min(Number(limit) || 100, 500);
  const { rows } = await db.query(
    `SELECT r.id, r.lead_id, r.phone, r.direction, r.duration_s,
            r.mime_type, r.size_bytes, r.created_at, l.name AS lead_name
       FROM lead_recordings r
       LEFT JOIN leads l ON l.id = r.lead_id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [me.id, lim]
  );
  return rows;
}

async function api_recordings_delete(token, recId) {
  const me = await authUser(token);
  const rec = await db.findById('lead_recordings', recId);
  if (!rec) throw new Error('recording not found');
  if (me.role !== 'admin' && Number(rec.user_id) !== Number(me.id)) {
    throw new Error('not allowed');
  }
  await db.removeRow('lead_recordings', recId);
  return { ok: true };
}

module.exports = {
  api_call_logEvent,
  api_leads_recordings,
  api_call_history,
  api_my_recordings,
  api_recordings_delete,
  _findLeadByPhone
};
