/**
 * Data retention worker — CEL_RETENTION_v1.
 *
 * Auto-deletes call recordings and activity logs older than a
 * configurable number of days (default 30) from PostgreSQL.
 *
 * Why this exists:
 *   - lead_recordings.audio_bytes stores raw audio inline as BYTEA →
 *     the table grows fast (1-5 MB per call) and the Railway-managed
 *     Postgres has a finite storage tier. Without expiry, the disk
 *     fills up.
 *   - call_events / lead_actions / wa_activity_log / automation_log /
 *     webhook_log all accumulate forever otherwise. After 30 days the
 *     value of a single call_event or automation_run row is near zero
 *     but the row count keeps the activity timeline render slow and
 *     the indexes bloated.
 *
 * Config keys (settable via the admin RPC api_admin_dataRetentionSet):
 *   RETENTION_DAYS         — int, 1..3650 (default 30)
 *   RETENTION_ENABLED      — '1' | '0'   (default '1')
 *   RETENTION_LAST_RUN     — ISO timestamp of last successful run
 *   RETENTION_LAST_DELETED — total rows deleted in last run
 *
 * Storage backend: PostgreSQL (Railway-managed). Call audio is stored
 * INLINE inside the lead_recordings.audio_bytes column — there is no
 * separate filesystem or object store, so cleaning the DB row also
 * cleans the audio bytes. No external files to chase.
 */

const db = require('../db/pg');

/**
 * Tables we clean and the timestamp column we use as "how old".
 * label is shown in the admin UI so the operator knows what each row
 * actually represents in plain English.
 */
const TARGETS = [
  { table: 'lead_recordings', dateCol: 'created_at',  label: 'Call recordings (audio bytes)' },
  { table: 'call_events',     dateCol: 'created_at',  label: 'Call activity events' },
  { table: 'lead_actions',    dateCol: 'created_at',  label: 'Lead activity timeline' },
  { table: 'wa_activity_log', dateCol: 'recorded_on', label: 'WhatsApp API activity log' },
  { table: 'automation_log',  dateCol: 'created_at',  label: 'Automation run history' },
  { table: 'webhook_log',     dateCol: 'received_at', label: 'Incoming webhook log' }
];

async function _getDays() {
  const raw = await db.getConfig('RETENTION_DAYS', '30');
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 30;
  if (n > 3650) return 3650;
  return Math.floor(n);
}

async function _isEnabled() {
  return String(await db.getConfig('RETENTION_ENABLED', '1')) === '1';
}

/**
 * Delete rows older than `days` from every target table. Returns a
 * per-table breakdown so the admin UI can show what was actually
 * removed. Each table is wrapped in its own try/catch — if one table
 * is missing (e.g. older tenant DB), the others still get cleaned.
 */
async function runCleanup(opts) {
  opts = opts || {};
  const days = Number(opts.days) || await _getDays();
  if (!opts.force && !(await _isEnabled())) {
    return { skipped: true, reason: 'RETENTION_ENABLED=0', days };
  }
  const startedAt = new Date();
  const results = [];
  for (const t of TARGETS) {
    try {
      const r = await db.query(
        `DELETE FROM ${t.table} WHERE ${t.dateCol} < NOW() - INTERVAL '${days} days'`
      );
      results.push({ table: t.table, label: t.label, deleted: r.rowCount || 0 });
    } catch (e) {
      // Table may not exist on very old tenants — log and continue.
      results.push({ table: t.table, label: t.label, deleted: 0, error: e.message });
    }
  }
  const total = results.reduce((s, r) => s + (r.deleted || 0), 0);
  await db.setConfig('RETENTION_LAST_RUN', startedAt.toISOString());
  await db.setConfig('RETENTION_LAST_DELETED', String(total));
  console.log(`[retention] deleted ${total} rows older than ${days}d across ${TARGETS.length} tables`);
  return { ran: true, days, total, results, startedAt: startedAt.toISOString() };
}

/**
 * Return current retention configuration + per-table row counts AND
 * how many rows would be deleted on the next run. Used by the admin
 * UI to show what's about to disappear.
 */
async function getStatus() {
  const days = await _getDays();
  const enabled = await _isEnabled();
  const lastRun = await db.getConfig('RETENTION_LAST_RUN', '');
  const lastDeleted = Number(await db.getConfig('RETENTION_LAST_DELETED', '0')) || 0;
  const counts = [];
  for (const t of TARGETS) {
    try {
      const r = await db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${t.dateCol} < NOW() - INTERVAL '${days} days')::int AS expiring
           FROM ${t.table}`
      );
      counts.push({
        table: t.table,
        label: t.label,
        total: r.rows[0]?.total || 0,
        expiring: r.rows[0]?.expiring || 0
      });
    } catch (e) {
      counts.push({ table: t.table, label: t.label, total: 0, expiring: 0, error: e.message });
    }
  }
  return {
    days,
    enabled,
    lastRun,
    lastDeleted,
    storageBackend: 'PostgreSQL (Railway-managed)',
    audioStorage: 'Inline BYTEA column lead_recordings.audio_bytes — no separate file store',
    counts
  };
}

/**
 * Boot-time scheduler. Runs the first cleanup 10 minutes after boot
 * (so app boot stays quick), then every 24 hours after that.
 */
let _started = false;
function start() {
  if (_started) return;
  _started = true;
  setTimeout(
    () => runCleanup().catch(e => console.error('[retention] initial run failed:', e.message)),
    10 * 60 * 1000
  );
  setInterval(
    () => runCleanup().catch(e => console.error('[retention] tick failed:', e.message)),
    24 * 60 * 60 * 1000
  );
  console.log('[retention] worker started — daily cleanup, default 30 days (RETENTION_DAYS config)');
}

module.exports = { runCleanup, getStatus, start, TARGETS };
