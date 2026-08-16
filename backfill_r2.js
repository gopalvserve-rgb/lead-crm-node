/**
 * backfill_r2.js — move existing lead_recordings BYTEA into Cloudflare R2.
 * Safe to re-run: only touches rows where r2_key IS NULL AND audio_bytes IS NOT NULL.
 * Run: node backfill_r2.js
 */
'use strict';
require('dotenv').config();
const db = require('./db/pg');
const r2 = require('./utils/r2');

(async () => {
  if (!r2.enabled()) { console.error('R2 not enabled (set R2_OFFLOAD=on and creds).'); process.exit(1); }
  console.log('R2 backfill starting. bucket=%s prefix=%s', r2.BUCKET, r2.PREFIX);
  await db.query('ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS r2_key TEXT');
  let done = 0, bytes = 0, fail = 0;
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, user_id, device_path, mime_type, audio_bytes
         FROM lead_recordings
        WHERE r2_key IS NULL AND audio_bytes IS NOT NULL
        ORDER BY id LIMIT 20`);
    if (!rows.length) break;
    for (const row of rows) {
      try {
        let buf = row.audio_bytes;
        if (!buf || !buf.length) { await db.query('UPDATE lead_recordings SET audio_bytes=NULL WHERE id=$1', [row.id]); continue; }
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
        const k = r2.key('recordings', String(row.user_id == null ? row.id : row.user_id), row.device_path || 'audio.m4a');
        await r2.put(k, buf, row.mime_type || 'audio/mp4');
        await db.query('UPDATE lead_recordings SET r2_key=$1, audio_bytes=NULL WHERE id=$2', [k, row.id]);
        done++; bytes += buf.length;
      } catch (e) {
        fail++; console.warn('[backfill] id=' + row.id + ' failed:', e.message);
        if (fail > 50) { console.error('too many failures, aborting'); break; }
      }
    }
  }
  console.log(`lead_recordings: DONE ${done} objects, ${(bytes / 1048576).toFixed(2)} MB moved, ${fail} failed`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
