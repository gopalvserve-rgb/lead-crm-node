/**
 * Lead-source integrations.
 *
 * 1. Google Sheet sync â admin pastes a sheet URL, the CRM polls
 *    its public CSV export every poll_interval_min and creates new
 *    leads from new rows.
 *
 * 2. Multi-source lead webhooks â `POST /hook/leadsource/:source/:key`
 *    accepts each Indian aggregator's payload format and maps it
 *    to the CRM's lead shape. Supported: indiamart, magicbricks,
 *    justdial, tradeindia, 99acres, housing, nobroker, exportersindia,
 *    sulekha, googleads, wordpress, googleforms, pabbly, zapier, make,
 *    leadsquared, zoho, hubspot, salesforce, generic.
 *
 * Both call api_leads_create internally so the existing duplicate
 * policy / cap / round-robin / auto-assignment all apply uniformly.
 */
const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('../db/pg');
const _sourceMapping = require('../utils/sourceMapping');
const { authUser } = require('../utils/auth');

// ============================================================
// Google Sheet sync
// ============================================================

function _parseSheetUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : String(url || '').trim();
  const g = String(url || '').match(/[?#&]gid=(\d+)/);
  return { sheet_id: id, sheet_gid: g ? g[1] : '0' };
}

function _hashRow(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

function _csvParse(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* SHEET_SYNC_v3 — header alias resolution + column_mapping + smart messages. */
function _normaliseHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}
const _HEADER_ALIASES = {
  name: ['name', 'full_name', 'customer_name', 'lead_name', 'contact_name', 'sender_name'],
  phone: ['phone', 'mobile', 'mobile_no', 'contact_number', 'contact', 'phone_number', 'whatsapp_number', 'cell'],
  whatsapp: ['whatsapp', 'whatsapp_no', 'wa_number'],
  email: ['email', 'e_mail', 'email_id', 'emailaddress', 'email_address'],
  source: ['source', 'lead_source'],
  city: ['city', 'town'],
  state: ['state'],
  country: ['country'],
  company: ['company', 'firm', 'business'],
  notes: ['notes', 'message', 'remarks', 'requirement', 'enquiry'],
  tags: ['tags', 'tag'],
  value: ['value', 'budget', 'price']
};
function _parseMapping(integration) {
  let mapping = {};
  try {
    if (integration.column_mapping) {
      mapping = typeof integration.column_mapping === 'string'
        ? JSON.parse(integration.column_mapping)
        : (integration.column_mapping || {});
    }
  } catch (_) {}
  return mapping;
}
function _resolveColumnTarget(rawHeader, mapping) {
  const norm = _normaliseHeader(rawHeader);
  if (mapping && Object.prototype.hasOwnProperty.call(mapping, rawHeader)) return mapping[rawHeader];
  if (mapping && Object.prototype.hasOwnProperty.call(mapping, norm))      return mapping[norm];
  for (const [crmField, aliases] of Object.entries(_HEADER_ALIASES)) {
    if (aliases.includes(norm)) return crmField;
  }
  return norm;
}

let _schemaHealed = false;
async function _ensureSchema() {
  if (_schemaHealed) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS sheet_integrations (
        id SERIAL PRIMARY KEY,
        name TEXT,
        sheet_id TEXT,
        sheet_gid TEXT DEFAULT '0',
        default_source TEXT DEFAULT 'Google Sheet',
        default_assignee_id INTEGER,
        poll_interval_min INTEGER DEFAULT 15,
        last_synced_at TIMESTAMPTZ,
        last_synced_count INTEGER DEFAULT 0,
        last_error TEXT,
        is_active INTEGER DEFAULT 1,
        created_by INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        webhook_token TEXT,
        column_mapping TEXT DEFAULT '{}'
      )
    `);
    const colsToAdd = [
      ['name', 'TEXT'], ['sheet_id', 'TEXT'], ['sheet_gid', "TEXT DEFAULT '0'"],
      ['default_source', "TEXT DEFAULT 'Google Sheet'"], ['default_assignee_id', 'INTEGER'],
      ['poll_interval_min', 'INTEGER DEFAULT 15'], ['last_synced_at', 'TIMESTAMPTZ'],
      ['last_synced_count', 'INTEGER DEFAULT 0'], ['last_error', 'TEXT'],
      ['is_active', 'INTEGER DEFAULT 1'], ['created_by', 'INTEGER'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'], ['webhook_token', 'TEXT'],
      ['column_mapping', "TEXT DEFAULT '{}'"]
    ];
    for (const [col, type] of colsToAdd) {
      try { await db.query('ALTER TABLE sheet_integrations ADD COLUMN IF NOT EXISTS ' + col + ' ' + type); } catch (_) {}
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS sheet_imported_rows (
        id SERIAL PRIMARY KEY,
        integration_id INTEGER,
        row_hash TEXT,
        imported_at TIMESTAMPTZ DEFAULT NOW(),
        lead_id INTEGER
      )
    `);
    for (const [col, type] of [['integration_id', 'INTEGER'], ['row_hash', 'TEXT'], ['imported_at', 'TIMESTAMPTZ DEFAULT NOW()'], ['lead_id', 'INTEGER']]) {
      try { await db.query('ALTER TABLE sheet_imported_rows ADD COLUMN IF NOT EXISTS ' + col + ' ' + type); } catch (_) {}
    }
  } catch (e) { console.warn('[_ensureSchema sheet_integrations]', e.message); }
  _schemaHealed = true;
}

async function _fetchSheetCsv(integration, opts) {
  opts = opts || {};
  const sheet_id  = (opts.sheet_id  || integration.sheet_id  || '').trim();
  const sheet_gid = (opts.sheet_gid || integration.sheet_gid || '0').trim();
  if (!sheet_id) return { ok: false, error: 'No sheet URL configured (push-only integration)' };
  const url = 'https://docs.google.com/spreadsheets/d/' + sheet_id + '/export?format=csv&gid=' + sheet_gid;
  let res;
  try { res = await fetch(url, { redirect: 'follow', timeout: 20000 }); }
  catch (e) { return { ok: false, error: 'Fetch failed: ' + e.message }; }
  if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' (is the sheet shared as Anyone with link – Viewer?)' };
  const text = await res.text();
  const rows = _csvParse(text);
  return { ok: true, sheet_id, sheet_gid, csv_text_bytes: text.length, total_rows: rows.length, raw: rows };
}

async function _runSheetSync(integration) {
  await _ensureSchema();
  const sheet_id = String(integration.sheet_id || '').trim();
  if (!sheet_id) {
    if (integration.last_error) {
      try { await db.update('sheet_integrations', integration.id, { last_error: '' }); } catch (_) {}
    }
    const lastAt = integration.last_synced_at;
    const lastN  = Number(integration.last_synced_count || 0);
    let message = '✅ PUSH mode is active — nothing to sync manually. Your Apps Script POSTs each new row to the CRM automatically.';
    if (lastAt) message += ' Last lead received via webhook: ' + new Date(lastAt).toLocaleString() + ' (' + lastN + ' lead' + (lastN === 1 ? '' : 's') + ' in that batch).';
    else message += ' No leads received yet — open your sheet → Extensions → Apps Script → Triggers and confirm the pushNewRowsToCRM function has a clock or onChange trigger.';
    return { imported: 0, skipped: 0, total: 0, mode: 'push_only', message };
  }
  const fetched = await _fetchSheetCsv(integration);
  if (!fetched.ok) throw new Error(fetched.error);
  const rows = fetched.raw;
  if (rows.length < 2) return { imported: 0, skipped: 0, total: 0, mode: 'pull', message: 'Sheet has no data rows (only header found)' };

  const rawHeaders = rows[0].map(h => String(h || ''));
  const mapping = _parseMapping(integration);
  const colTargets = rawHeaders.map(h => _resolveColumnTarget(h, mapping));

  const data = rows.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));
  const seen = new Set((await db.getAll('sheet_imported_rows'))
    .filter(r => Number(r.integration_id) === Number(integration.id))
    .map(r => r.row_hash));
  let imported = 0, skipped = 0;
  const skipped_reasons = { duplicate: 0, no_phone: 0, error: 0 };
  for (const r of data) {
    const obj = {};
    colTargets.forEach((t, i) => {
      if (!t) return;
      const v = String(r[i] || '').trim();
      if (!v) return;
      obj[t] = v;
    });
    const hash = _hashRow(obj);
    if (seen.has(hash)) { skipped++; skipped_reasons.duplicate++; continue; }
    if (!obj.name && !obj.phone && !obj.mobile && !obj.whatsapp) { skipped++; skipped_reasons.no_phone++; continue; }
    obj.source = obj.source || integration.default_source || 'Google Sheet';
    if (!obj.assigned_to && integration.default_assignee_id) obj.assigned_to = integration.default_assignee_id;
    try {
      const created = await _internalCreateLead(obj, integration.created_by);
      await db.insert('sheet_imported_rows', {
        integration_id: integration.id, row_hash: hash, imported_at: db.nowIso(), lead_id: created.id || null
      });
      imported++;
    } catch (e) {
      console.warn('[sheetSync] row failed:', e.message);
      await db.insert('sheet_imported_rows', {
        integration_id: integration.id, row_hash: hash, imported_at: db.nowIso(), lead_id: null
      });
      skipped++; skipped_reasons.error++;
    }
  }
  await db.update('sheet_integrations', integration.id, {
    last_synced_at: db.nowIso(), last_synced_count: imported, last_error: ''
  });
  let message;
  if (imported > 0)            message = 'Imported ' + imported + ' new lead(s), skipped ' + skipped + '.';
  else if (data.length === 0)  message = 'Sheet has no data rows.';
  else if (skipped_reasons.duplicate === data.length) message = 'All ' + data.length + ' row(s) were already imported earlier (deduped by row content hash).';
  else if (skipped_reasons.no_phone === data.length)  message = 'Found ' + data.length + ' row(s) but none mapped to a name/phone/mobile/whatsapp column. Use Column Mapping to point your columns to CRM fields.';
  else message = 'Imported 0 of ' + data.length + ' rows — ' + skipped_reasons.duplicate + ' duplicate, ' + skipped_reasons.no_phone + ' missing phone, ' + skipped_reasons.error + ' errored.';
  return { imported, skipped, total: data.length, mode: 'pull', skipped_reasons, message };
}

async function runDueSheetSyncs() {
  const all = await db.getAll('sheet_integrations').catch(() => []);
  const active = all.filter(i => Number(i.is_active) === 1);
  const now = Date.now();
  for (const i of active) {
    const last = i.last_synced_at ? new Date(i.last_synced_at).getTime() : 0;
    const interval = (Number(i.poll_interval_min) || 15) * 60 * 1000;
    if (now - last < interval) continue;
    try { await _runSheetSync(i); }
    catch (e) {
      console.error('[sheetSync] integration', i.id, 'failed:', e.message);
      try { await db.update('sheet_integrations', i.id, { last_synced_at: db.nowIso(), last_error: String(e.message || e).slice(0, 500) }); } catch (_) {}
    }
  }
}

async function _internalCreateLead(payload, asUserId) {
  const me = await db.findOneBy('users', 'id', asUserId);
  if (!me) throw new Error('Integration owner missing');
  const _status = await db.findOneBy('statuses', 'name', 'New');
  const _phone = String(payload.phone || payload.mobile || '').replace(/^'/, '').trim();
  const _phoneDigits = _phone.replace(/\D/g, '');
  if (!_phoneDigits) throw new Error('No phone');

  // ---- Harvest custom-field values + UTM attribution ---------------
  // Mirrors routes/webhooks.js so /hook/leadsource and /hook/website
  // both honour the per-source field mapping saved in Settings -> Webhook
  // logs -> Map fields. Without this loop, an admin who mapped
  // utm_campaign -> cf_campaign_id would see the cf_campaign_id value
  // silently dropped because _internalCreateLead only picked standard
  // top-level columns.
  let extraJson = {};
  try {
    const customFields = (await db.getAll('custom_fields'))
      .filter(f => Number(f.is_active) !== 0);
    for (const f of customFields) {
      const k = String(f.key || '').trim();
      if (!k) continue;
      let v = payload[k];
      if (v === undefined || v === null || v === '') v = payload['cf_' + k];
      if ((v === undefined || v === null || v === '') && payload.extra && typeof payload.extra === 'object') {
        v = payload.extra[k];
      }
      if (v !== undefined && v !== null && v !== '') {
        extraJson[k] = (typeof v === 'object') ? v : String(v);
      }
    }
  } catch (e) {
    console.warn('[integrations] custom-field merge failed:', e.message);
  }

  const lead = {
    name: String(payload.name || _phone).trim(),
    phone: _phone,
    whatsapp: String(payload.whatsapp || _phone).replace(/^'/, '').trim(),
    email: String(payload.email || '').trim(),
    source: payload.source || 'Sheet sync',
    source_ref: payload.source_ref || '',
    status_id: _status ? _status.id : null,
    assigned_to: payload.assigned_to ? Number(payload.assigned_to) : me.id,
    city: payload.city || '',
    state: payload.state || '',
    company: payload.company || '',
    address: payload.address || '',
    pincode: payload.pincode || payload.zip || '',
    notes: payload.notes || payload.message || '',
    tags: payload.tags || '',
    product: payload.product || '',
    value: Number(payload.value) || null,
    currency: payload.currency || '',
    // First-class attribution columns — mapping can target these directly.
    gclid:          payload.gclid || '',
    gad_campaignid: payload.gad_campaignid || '',
    utm_source:     payload.utm_source || '',
    utm_medium:     payload.utm_medium || '',
    utm_campaign:   payload.utm_campaign || '',
    utm_term:       payload.utm_term || '',
    utm_content:    payload.utm_content || '',
    extra_json: Object.keys(extraJson).length ? extraJson : null,
    created_by: me.id,
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    last_status_change_at: db.nowIso()
  };
  const id = await db.insert('leads', lead);
  return { id };
}

// ---- API wrappers ---------------------------------------------

async function api_sheetSync_list(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  const all = await db.getAll('sheet_integrations');
  return all.sort((a, b) => Number(b.id) - Number(a.id));
}

async function api_sheetSync_save(token, payload) {
  const me = await authUser(token);
  await _ensureSchema();
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if (!p.name) throw new Error('Name required');
  let sheet_id = '', sheet_gid = '0';
  if (p.sheet_url || p.sheet_id) {
    const parsed = p.sheet_id
      ? { sheet_id: p.sheet_id, sheet_gid: p.sheet_gid || '0' }
      : _parseSheetUrl(p.sheet_url);
    sheet_id = parsed.sheet_id || '';
    sheet_gid = parsed.sheet_gid || '0';
  }
  let column_mapping = '{}';
  try {
    if (p.column_mapping && typeof p.column_mapping === 'object') column_mapping = JSON.stringify(p.column_mapping);
    else if (typeof p.column_mapping === 'string' && p.column_mapping.trim()) column_mapping = p.column_mapping.trim();
  } catch (_) {}
  const data = {
    name: String(p.name).trim(),
    sheet_id, sheet_gid,
    default_source: p.default_source || 'Google Sheet',
    default_assignee_id: p.default_assignee_id ? Number(p.default_assignee_id) : null,
    poll_interval_min: Math.max(5, Number(p.poll_interval_min) || 15),
    is_active: p.is_active === 0 ? 0 : 1,
    column_mapping
  };
  if (p.id) {
    await db.update('sheet_integrations', p.id, data);
    const existing = await db.findOneBy('sheet_integrations', 'id', p.id);
    if (!existing.webhook_token) {
      await db.update('sheet_integrations', p.id, { webhook_token: 'sht_' + crypto.randomBytes(20).toString('hex') });
    }
    return { id: Number(p.id), ok: true };
  }
  data.created_by = me.id;
  data.created_at = db.nowIso();
  data.webhook_token = 'sht_' + crypto.randomBytes(20).toString('hex');
  const id = await db.insert('sheet_integrations', data);
  return { id, ok: true };
}

async function sheetPushWebhook(req, res) {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'missing token' });
    const all = await db.getAll('sheet_integrations');
    const integ = all.find(i => String(i.webhook_token || '') === token);
    if (!integ) return res.status(404).json({ error: 'unknown token' });
    if (Number(integ.is_active) !== 1) return res.json({ ok: false, error: 'integration paused' });
    const body = req.body || {};
    const rows = Array.isArray(body) ? body : (Array.isArray(body.rows) ? body.rows : [body]);
    const results = [];
    for (const r of rows) {
      const obj = Object.assign({}, r);
      const lower = {};
      for (const k of Object.keys(obj)) lower[String(k).trim().toLowerCase()] = obj[k];
      if (!lower.phone && lower.mobile) lower.phone = lower.mobile;
      if (!lower.name && !lower.phone && !lower.email) {
        results.push({ ok: false, error: 'no name/phone/email' });
        continue;
      }
      lower.source = lower.source || integ.default_source || 'Google Sheet';
      if (!lower.assigned_to && integ.default_assignee_id) {
        lower.assigned_to = integ.default_assignee_id;
      }
      try {
        const created = await _internalCreateLead(lower, integ.created_by);
        results.push({ ok: true, lead_id: created.id });
        try {
          const hash = _hashRow(lower);
          await db.insert('sheet_imported_rows', {
            integration_id: integ.id, row_hash: hash,
            imported_at: db.nowIso(), lead_id: created.id || null
          });
        } catch (_) {}
      } catch (e) {
        results.push({ ok: false, error: String(e.message || e) });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    if (okCount) {
      await db.update('sheet_integrations', integ.id, {
        last_synced_at: db.nowIso(),
        last_synced_count: okCount,
        last_error: ''
      });
    }
    return res.json({ ok: true, processed: results.length, created: okCount, results });
  } catch (e) {
    console.error('[sheetPush] error:', e.message);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

async function api_sheetSync_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.removeRow('sheet_integrations', id);
  return { ok: true };
}

async function api_sheetSync_diagnose(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const integration = await db.findOneBy('sheet_integrations', 'id', id);
  if (!integration) throw new Error('Integration not found');
  const out = {
    integration_id: integration.id, name: integration.name,
    sheet_id: integration.sheet_id || '', sheet_gid: integration.sheet_gid || '0',
    mode: integration.sheet_id ? 'pull' : 'push_only',
    is_active: Number(integration.is_active) === 1,
    last_synced_at: integration.last_synced_at || null,
    last_synced_count: Number(integration.last_synced_count || 0),
    last_error: integration.last_error || null,
    poll_interval_min: Number(integration.poll_interval_min || 15),
    column_mapping: _parseMapping(integration),
    webhook_url_push: integration.webhook_token ? ('/hook/sheet/' + integration.webhook_token) : null,
    already_imported_rows: 0,
    csv: null, headers: [], detected_columns: [], preview: [], advice: []
  };
  try {
    const imp = (await db.getAll('sheet_imported_rows')).filter(r => Number(r.integration_id) === Number(id));
    out.already_imported_rows = imp.length;
  } catch (_) {}
  if (out.mode === 'push_only') {
    out.advice.push("✅ This integration uses PUSH mode — your sheet stays fully private. The Apps Script POSTs each new row via the webhook URL below. You do NOT need to make the sheet public.");
    if (out.last_synced_at) out.advice.push("Last lead received via webhook: " + new Date(out.last_synced_at).toLocaleString() + " (" + Number(out.last_synced_count || 0) + " in that batch).");
    else out.advice.push("⚠ No leads received yet. Open your sheet → Extensions → Apps Script → Triggers, confirm pushNewRowsToCRM has a trigger. Then open Executions tab.");
    return out;
  }
  const fetched = await _fetchSheetCsv(integration);
  if (!fetched.ok) { out.csv = { ok: false, error: fetched.error }; out.advice.push("Sheet fetch failed: " + fetched.error); return out; }
  out.csv = { ok: true, sheet_id: fetched.sheet_id, sheet_gid: fetched.sheet_gid, bytes: fetched.csv_text_bytes, total_rows: fetched.total_rows };
  const rows = fetched.raw;
  if (!rows.length) { out.advice.push("Sheet appears empty."); return out; }
  const rawHeaders = rows[0].map(h => String(h || ''));
  const mapping = _parseMapping(integration);
  out.headers = rawHeaders;
  out.detected_columns = rawHeaders.map(h => {
    const norm = _normaliseHeader(h);
    const target = _resolveColumnTarget(h, mapping);
    const explicit = mapping && (Object.prototype.hasOwnProperty.call(mapping, h) || Object.prototype.hasOwnProperty.call(mapping, norm));
    return { raw: h, normalised: norm, mapped_to: target, source: explicit ? 'explicit_mapping' : 'auto_heuristic' };
  });
  const dataRows = rows.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));
  out.preview = dataRows.slice(0, 3).map(r => {
    const obj = {};
    out.detected_columns.forEach((c, i) => {
      const v = String(r[i] || '').trim();
      if (v) obj[c.mapped_to || c.normalised] = v;
    });
    return obj;
  });
  out.total_data_rows = dataRows.length;
  const targets = out.detected_columns.map(c => c.mapped_to);
  if (!targets.includes('name') && !targets.includes('phone') && !targets.includes('mobile') && !targets.includes('whatsapp')) {
    out.advice.push('⚠ None of the sheet columns map to name/phone/mobile/whatsapp. Use Column Mapping to fix.');
  }
  if (out.already_imported_rows >= dataRows.length) out.advice.push('All ' + dataRows.length + ' rows already imported.');
  if (!out.advice.length) out.advice.push('Looks good — click ▶ Sync now to pick up ' + dataRows.length + ' rows.');
  return out;
}

async function api_sheetSync_testReceive(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const integration = await db.findOneBy('sheet_integrations', 'id', id);
  if (!integration) throw new Error('Integration not found');
  if (!integration.webhook_token) throw new Error('No webhook_token on integration — re-save it');
  const testPayload = {
    name: 'TEST · Sheet sync probe', phone: '9999999990',
    email: 'sheetsync-probe@example.com',
    notes: 'Synthetic test row at ' + new Date().toISOString(),
    source: integration.default_source || 'Google Sheet (test)'
  };
  try {
    const fakeReq = { params: { token: integration.webhook_token }, body: testPayload };
    let respBody = null, respStatus = 200;
    const fakeRes = { status(c) { respStatus = c; return this; }, json(o) { respBody = o; return this; } };
    await sheetPushWebhook(fakeReq, fakeRes);
    return { ok: true, mode: 'inproc', status: respStatus, response: respBody, payload: testPayload };
  } catch (e) { return { ok: false, error: e.message, payload: testPayload }; }
}

async function api_sheetSync_recentActivity(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const all = await db.getAll('sheet_imported_rows');
  const rows = all
    .filter(r => Number(r.integration_id) === Number(id))
    .sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at)))
    .slice(0, 20);
  const leadIds = rows.map(r => Number(r.lead_id)).filter(Boolean);
  const leads = (await db.getAll('leads')).filter(l => leadIds.includes(Number(l.id)));
  const byId = {}; leads.forEach(l => { byId[Number(l.id)] = l; });
  return rows.map(r => ({
    imported_at: r.imported_at, lead_id: r.lead_id,
    lead_name: (byId[Number(r.lead_id)] || {}).name || '',
    lead_phone: (byId[Number(r.lead_id)] || {}).phone || '',
    row_hash: r.row_hash
  }));
}

async function api_sheetSync_runNow(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  const i = await db.findOneBy('sheet_integrations', 'id', id);
  if (!i) throw new Error('Integration not found');
  const r = await _runSheetSync(i);
  return r;
}

// ============================================================
// Multi-source lead webhook
// ============================================================

/**
 * Map an inbound payload from a known vendor into the CRM's
 * standard lead shape. Returns an array of lead objects (some
 * vendors batch multiple leads per webhook call, e.g. IndiaMART).
 *
 * Supported sources:
 *   indiamart, magicbricks, justdial, tradeindia, 99acres, housing,
 *   nobroker, exportersindia, sulekha, googleads, wordpress, cf7,
 *   wpforms, gravityforms, googleforms, pabbly, zapier, make,
 *   integromat, n8n, leadsquared, zoho, zohocrm, hubspot,
 *   salesforce, sfdc, generic
 */
function _adaptLeadSourcePayload(source, body) {
  const norm = String(source || '').toLowerCase().trim();
  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
    }
    return '';
  };

  // ââ IndiaMART ââââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'indiamart') {
    const arr = Array.isArray(body.RESPONSE) ? body.RESPONSE
              : Array.isArray(body.response)  ? body.response
              : [body];
    return arr.map(r => ({
      name:       pick(r, ['SENDER_NAME',    'sender_name',    'name',    'NAME']),
      phone:      pick(r, ['SENDER_MOBILE',  'sender_mobile',  'mobile',  'MOBILE', 'phone']),
      email:      pick(r, ['SENDER_EMAIL',   'sender_email',   'email',   'EMAIL']),
      company:    pick(r, ['SENDER_COMPANY', 'sender_company', 'company']),
      city:       pick(r, ['SENDER_CITY',    'sender_city',    'city']),
      state:      pick(r, ['SENDER_STATE',   'sender_state',   'state']),
      address:    pick(r, ['SENDER_ADDRESS', 'sender_address', 'address']),
      notes:      pick(r, ['QUERY_MESSAGE',  'query_message',  'message', 'SUBJECT', 'subject']),
      source:     'IndiaMART',
      source_ref: pick(r, ['UNIQUE_QUERY_ID', 'unique_query_id', 'query_id'])
    }));
  }

  // ââ MagicBricks âââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'magicbricks') {
    const r = body.Lead || body.lead || body;
    return [{
      name:       pick(r, ['contact_person', 'name', 'Name', 'lead_name']),
      phone:      pick(r, ['mobile', 'phone', 'mobile_number', 'contact_no']),
      email:      pick(r, ['email', 'email_id']),
      city:       pick(r, ['city', 'lead_city', 'location']),
      notes:      pick(r, ['message', 'remarks', 'requirement']),
      source:     'MagicBricks',
      source_ref: pick(r, ['lead_id', 'leadId', 'id'])
    }];
  }

  // ââ JustDial ââââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'justdial' || norm === 'jd') {
    const r = body.lead || body;
    const prefix = pick(r, ['prefix', 'salutation']);
    const fname  = pick(r, ['name', 'first_name', 'fname']);
    return [{
      name:       (prefix ? prefix + ' ' : '') + fname,
      phone:      pick(r, ['mobile', 'phone', 'mobile_no', 'mobileno']),
      email:      pick(r, ['email', 'email_id']),
      city:       pick(r, ['city', 'area']),
      notes:      pick(r, ['category', 'service', 'enquiry']),
      source:     'JustDial',
      source_ref: pick(r, ['leadid', 'lead_id', 'id'])
    }];
  }

  // ââ TradeIndia ââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'tradeindia' || norm === 'ti') {
    return [{
      name:       pick(body, ['GLUSR_USR_FNAME', 'glusr_usr_fname', 'first_name', 'name']),
      phone:      pick(body, ['GLUSR_USR_PHONE', 'glusr_usr_phone', 'phone', 'mobile']),
      email:      pich(body, ['GLUSR_USR_EMAIL', 'glusr_usr_email', 'email']),
      company:    pick(body, ['GLUSR_USR_COMPANY', 'glusr_usr_company', 'company']),
      city:       pick(body, ['GLUSR_USR_CITY', 'glusr_usr_city', 'city']),
      notes:      pich(body, ['MESSAGE', 'message', 'enquiry']),
      source:     'TradeIndia',
      source_ref: pick(body, ['QUERY_ID', 'query_id', 'enquiry_id', 'id'])
    }];
  }

  // ââ 99acres âââââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === '99acres' || norm === 'acres') {
    const r = body.lead || body;
    return [{
      name:       pick(r, ['name', 'fullName']),
      phone:      pick(r, ['mobile', 'phone', 'contactNumber']),
      email:      pick(r, ['email', 'emailId']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'requirement', 'propertyName']),
      source:     '99acres',
      source_ref: pick(r, ['leadId', 'lead_id', 'id'])
    }];
  }

  // ââ Housing.com âââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'housing' || norm === 'housing.com') {
    const r = body.lead || body;
    return [{
      name:       pick(r, ['name', 'fullName', 'contactName']),
      phone:      pick(r, ['phone', 'mobile', 'contactNumber']),
      email:      pick(r, ['email']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'requirement']),
      source:     'Housing.com',
      source_ref: pick(r, ['id', 'leadId'])
    }];
  }

  // ââ NoBroker ââââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'nobroker') {
    const r = body.lead || body;
    return [{
      name:       pick(r, ['name', 'contactName', 'customer_name', 'fullName']),
      phone:      pick(r, ['phone', 'mobile', 'contactNumber', 'contact']),
      email:      pick(r, ['email']),
      city:       pick(r, ['city', 'location', 'locality']),
      notes:      pick(r, ['requirement', 'message', 'propertyType', 'property_type']),
      source:     'NoBroker',
      source_ref: pick(r, ['id', 'leadId', 'lead_id'])
    }];
  }

  // ââ ExportersIndia ââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'exportersindia' || norm === 'exporter') {
    return [{
      name:       pick(body, ['SENDER_NAME',    'sender_name',    'name']),
      phone:      pich(body, ['SENDER_MOBILE',  'sender_mobile',  'mobile', 'phone']),
      email:      pich(body, ['SENDER_EMAIL',   'sender_email',   'email']),
      company:    pick(body, ['SENDER_COMPANY', 'sender_company', 'company']),
      city:       pich(body, ['SENDER_CITY',    'sender_city',    'city']),
      notes:      pick(body, ['QUERY_MESSAGE',  'query_message',  'message', 'SUBJECT']),
      source:     'ExportersIndia',
      source_ref: pick(body, ['QUERY_ID', 'query_id', 'id'])
    }];
  }

  // ââ Sulekha âââââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'sulekha') {
    const r = body.lead || body;
    return [{
      name:       pick(r, ['name', 'customer_name', 'customerName', 'fullName']),
      phone:      pick(r, ['mobile', 'phone', 'contact', 'mobile_number']),
      email:      pick(r, ['email', 'email_id']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['service', 'category', 'message', 'requirements']),
      source:     'Sulekha',
      source_ref: pick(r, ['id', 'leadId', 'lead_id'])
    }];
  }

  // ââ Google Ads Lead Form Extensions âââââââââââââââââââââââ
  // Payload: { google_key, campaign_id, adgroup_id, lead_id,
  //            user_column_data: [{column_name, string_value}] }
  if (norm === 'googleads' || norm === 'google_ads' || norm === 'google-ads') {
    const cols = {};
    if (Array.isArray(body.user_column_data)) {
      body.user_column_data.forEach(c => {
        if (c.column_name) {
          cols[String(c.column_name).toLowerCase().replace(/\s+/g, '_')] = c.string_value || '';
        }
      });
    }
    const r = Object.assign({}, body, cols);
    return [{
      name:       pick(r, ['full_name', 'name', 'first_name', 'customer_name']),
      phone:      pick(r, ['phone_number', 'phone', 'mobile', 'contact_number']),
      email:      pick(r, ['email', 'email_address']),
      city:       pick(r, ['city', 'location']),
      notes:      'Google Ads Lead Form' +
                  (body.campaign_id ? ' Â· Campaign: ' + body.campaign_id : '') +
                  (body.adgroup_id  ? ' Â· AdGroup: '  + body.adgroup_id  : ''),
      source:     'Google Ads',
      source_ref: pick(body, ['lead_id', 'adgroup_id', 'campaign_id'])
    }];
  }

  // ââ WordPress Forms (CF7 / WPForms / Gravity Forms) âââââââ
  if (['wordpress', 'cf7', 'wpforms', 'gravityforms', 'gravity_forms'].includes(norm)) {
    const r = body.data || body.fields || body;
    const fname = pick(r, ['your-name', 'name', 'full_name', 'first_name', 'fullName', 'field_1', 'input_1']);
    const lname = pick(r, ['last_name', 'field_2', 'input_2']);
    const fullName = (fname + (lname ? ' ' + lname : '')).trim();
    return [{
      name:       fullName,
      phone:      pick(r, ['your-phone', 'phone', 'mobile', 'phone_number', 'field_3', 'input_3', 'contact']),
      email:      pick(r, ['your-email', 'email', 'email_address', 'field_4', 'input_4']),
      city:       pick(r, ['city', 'your-city', 'field_5', 'input_5']),
      notes:      pick(r, ['your-message', 'message', 'comments', 'field_6', 'input_6']) +
                  (body.page_url ? '\nSource page: ' + body.page_url : ''),
      source:     'WordPress',
      source_ref: pick(body, ['form_id', '_wpcf7', 'id'])
    }];
  }

  // ââ Google Forms (via Apps Script webhook) âââââââââââââââââ
  // Apps Script maps form Q&A into a flat JSON object sent here.
  if (norm === 'googleforms' || norm === 'google_forms' || norm === 'google-forms') {
    const r = body.response || body;
    return [{
      name:       pick(r, ['name', 'full_name', 'your_name', 'Name', 'Full Name']),
      phone:      pick(r, ['phone', 'mobile', 'phone_number', 'Phone', 'Mobile', 'Phone Number']),
      email:      pick(r, ['email', 'Email', 'email_address', 'Email Address']),
      city:       pick(r, ['city', 'City', 'location', 'Location']),
      notes:      pick(r, ['message', 'Message', 'enquiry', 'notes', 'Notes', 'Enquiry']),
      source:     'Google Forms',
      source_ref: pick(body, ['formId', 'form_id', 'responseId'])
    }];
  }

  // ââ Pabbly Connect ââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'pabbly') {
    const r = body.data || body;
    return [{
      name:       pick(r, ['name', 'full_name', 'contact_name']),
      phone:      pick(r, ['phone', 'mobile', 'phone_number', 'contact']),
      email:      pick(r, ['email', 'email_address']),
      company:    pick(r, ['company', 'organization', 'company_name']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'notes', 'enquiry', 'description']),
      source:     pick(r, ['source']) || 'Pabbly Connect',
      source_ref: pick(r, ['source_ref', 'id', 'reference'])
    }];
  }

  // ââ Zapier ââââââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'zapier') {
    const r = body.data || body;
    return [{
      name:       pick(r, ['name', 'full_name', 'contact_name', 'customer_name']),
      phone:      pick(r, ['phone', 'mobile', 'phone_number', 'contact']),
      email:      pick(r, ['email', 'email_address']),
      company:    pick(r, ['company', 'organization', 'company_name']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'notes', 'enquiry', 'description']),
      source:     pick(r, ['source']) || 'Zapier',
      source_ref: pick(r, ['source_ref', 'id', 'reference', 'zap_id'])
    }];
  }

  // ââ Make (Integromat) / n8n âââââââââââââââââââââââââââââââ
  if (norm === 'make' || norm === 'integromat' || norm === 'n8n') {
    const r = body.data || body;
    const src = norm === 'n8n' ? 'n8n' : 'Make';
    return [{
      name:       pick(r, ['name', 'full_name', 'contact_name']),
      phone:      pick(r, ['phone', 'mobile', 'phone_number', 'contact']),
      email:      pick(r, ['email', 'email_address']),
      company:    pick(r, ['company', 'organization']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'notes', 'enquiry']),
      source:     pick(r, ['source']) || src,
      source_ref: pick(r, ['source_ref', 'id', 'reference'])
    }];
  }

  // ââ LeadSquared âââââââââââââââââââââââââââââââââââââââââââ
  // Supports both flat format and { LeadPropertyList: [{Attribute, Value}] }
  if (norm === 'leadsquared' || norm === 'ls') {
    const attrs = {};
    if (Array.isArray(body.LeadPropertyList)) {
      body.LeadPropertyList.forEach(p => { if (p.Attribute) attrs[p.Attribute] = p.Value; });
    }
    const r = Object.assign({}, attrs, body.Lead || body.lead || body);
    const fname = pick(r, ['FirstName', 'first_name', 'name']);
    const lname = pick(r, ['LastName', 'last_name']);
    return [{
      name:       (fname + (lname ? ' ' + lname : '')).trim(),
      phone:      pick(r, ['Phone', 'Mobile', 'phone', 'mobile']),
      email:      pick(r, ['EmailAddress', 'Email', 'email']),
      company:    pick(r, ['Company', 'company']),
      city:       pick(r, ['City', 'city']),
      notes:      pick(r, ['Notes', 'note', 'notes', 'Source']),
      source:     'LeadSquared',
      source_ref: pick(r, ['ProspectID', 'Id', 'id'])
    }];
  }

  // ââ Zoho CRM ââââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'zoho' || norm === 'zohocrm' || norm === 'zoho_crm') {
    const arr = Array.isArray(body.leads) ? body.leads
              : Array.isArray(body.data)  ? body.data
              : [body.lead || body];
    return arr.map(r => {
      const fname = pick(r, ['First_Name', 'first_name']);
      const lname = pick(r, ['Last_Name',  'last_name']);
      return {
        name:       (fname + (lname ? ' ' + lname : '')).trim() || pick(r, ['Full_Name', 'Name', 'name']),
        phone:      pick(r, ['Phone', 'Mobile', 'phone', 'mobile']),
        email:      pick(r, ['Email', 'email']),
        company:    pick(r, ['Company', 'company']),
        city:       pick(r, ['City', 'city']),
        notes:      pick(r, ['Description', 'description', 'Lead_Source']),
        source:     'Zoho CRM',
        source_ref: pick(r, ['id', 'Id', '$id'])
      };
    });
  }

  // ââ HubSpot âââââââââââââââââââââââââââââââââââââââââââââââ
  // Supports event-array format and contact-properties format.
  if (norm === 'hubspot') {
    if (Array.isArray(body)) {
      // Group events by objectId â reconstruct contact
      const map = {};
      body.forEach(ev => {
        const id = String(ev.objectId || '');
        if (!map[id]) map[id] = {};
        if (ev.propertyName) map[id][ev.propertyName] = ev.propertyValue;
      });
      return Object.values(map).map(r => {
        const fname = pick(r, ['firstname']);
        const lname = pick(r, ['lastname']);
        return {
          name:    (fname + (lname ? ' ' + lname : '')).trim() || pick(r, ['name']),
          phone:   pick(r, ['phone', 'mobilephone']),
          email:   pick(r, ['email']),
          company: pick(r, ['company']),
          city:    pick(r, ['city']),
          notes:   pick(r, ['message', 'notes', 'hs_lead_status']),
          source:  'HubSpot',
          source_ref: ''
        };
      });
    }
    const r = body.properties || body;
    const fname = pick(r, ['firstname', 'first_name']);
    const lname = pick(r, ['lastname',  'last_name']);
    return [{
      name:       (fname + (lname ? ' ' + lname : '')).trim() || pick(r, ['name']),
      phone:      pick(r, ['phone', 'mobilephone', 'mobile']),
      email:      pick(r, ['email']),
      company:    pick(r, ['company']),
      city:       pick(r, ['city']),
      notes:      pick(r, ['message', 'notes', 'description', 'hs_lead_status']),
      source:     'HubSpot',
      source_ref: pick(body, ['id', 'vid'])
    }];
  }

  // ââ Salesforce ââââââââââââââââââââââââââââââââââââââââââââ
  if (norm === 'salesforce' || norm === 'sfdc') {
    const r = body.Lead || body.lead || body;
    const fname = pick(r, ['FirstName', 'first_name']);
    const lname = pick(r, ['LastName',  'last_name']);
    return [{
      name:       (fname + (lname ? ' ' + lname : '')).trim() || pick(r, ['Name', 'name']),
      phone:      pick(r, ['Phone', 'MobilePhone', 'phone', 'mobile']),
      email:      pick(r, ['Email', 'email']),
      company:    pick(r, ['Company', 'company']),
      city:       pick(r, ['City', 'city']),
      notes:      pick(r, ['Description', 'description', 'LeadSource']),
      source:     'Salesforce',
      source_ref: pick(r, ['Id', 'id'])
    }];
  }

  // ââ Generic fallback ââââââââââââââââââââââââââââââââââââââ
  const r = body.lead || body;
  return [{
    name:       pick(r, ['name', 'full_name', 'customer_name', 'contact_name']),
    phone:      pick(r, ['phone', 'mobile', 'contact', 'mobile_number', 'contact_number']),
    email:      pick(r, ['email', 'email_id']),
    company:    pick(r, ['company', 'organization']),
    city:       pick(r, ['city', 'location']),
    notes:      pick(r, ['message', 'enquiry', 'requirement', 'notes']),
    source:     pick(r, ['source']) || 'Webhook',
    source_ref: pick(r, ['id', 'lead_id', 'reference'])
  }];
}

/**
 * Express handler: POST /hook/leadsource/:source/:key
 *
 * URL format: https://<host>/hook/leadsource/<platform>/<api-key>
 * Supported platforms: indiamart, 99acres, magicbricks, housing,
 *   nobroker, justdial, tradeindia, exportersindia, sulekha,
 *   googleads, wordpress, cf7, wpforms, gravityforms, googleforms,
 *   pabbly, zapier, make, leadsquared, zoho, hubspot, salesforce
 *
 * The <api-key> must match the WEBSITE_API_KEY set in Admin â Website API.
 */
async function leadSourceWebhook(req, res) {
  try {
    const apiKey  = String(req.params.key || req.headers['x-api-key'] || '').trim();
    const expected = await db.getConfig('WEBSITE_API_KEY', '').catch(() => process.env.WEBSITE_API_KEY || '');
    if (!apiKey || apiKey !== expected) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    const source = String(req.params.source || 'generic').toLowerCase();
    const body   = req.body || {};

    // Log raw hit for admin diagnostics
    try {
      await db.insert('webhook_log', { source, payload: body, processed: 0, error: '' });
    } catch (_) {}

    // Save the raw payload so the admin can see exactly what arrived
    // when configuring field mapping in Settings → Webhook logs → Map fields.
    try { await _sourceMapping.saveLastPayload(source, body); } catch (_) {}
    // If admin has saved a custom field mapping for this source, prepend
    // the mapped object so it takes priority over the default adapter.
    let items = _adaptLeadSourcePayload(source, body);
    try {
      const saved = await _sourceMapping.loadMapping(source);
      const overlay = saved ? _sourceMapping.applyMapping(body, saved) : null;
      if (overlay) {
        items = [Object.assign({ source: source }, overlay)].concat(items || []);
      }
    } catch (_) {}
    const owner = await db.getAll('users').then(us => us.find(u => u.role === 'admin'));
    if (!owner) return res.status(500).json({ error: 'No admin user to own leads' });

    const results = [];
    for (const it of items) {
      if (!it.phone && !it.email && !it.name) continue;
      try {
        const r = await _internalCreateLead(it, owner.id);
        // Update webhook_log row as processed
        results.push({ ok: true, lead_id: r.id, name: it.name });
      } catch (e) {
        results.push({ ok: false, name: it.name, error: e.message });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    // Update the log row to processed
    try {
      const logs = await db.getAll('webhook_log');
      const last = logs.filter(l => l.source === source).sort((a, b) => b.id - a.id)[0];
      if (last) await db.update('webhook_log', last.id, { processed: okCount > 0 ? 1 : 0 });
    } catch (_) {}

    return res.json({ ok: true, source, processed: results.length, created: okCount, results });
  } catch (e) {
    console.error('[leadsource] webhook error:', e.message);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

module.exports = {
  // JSON-RPC API
  api_sheetSync_list,
  api_sheetSync_save,
  api_sheetSync_diagnose,
  api_sheetSync_testReceive,
  api_sheetSync_recentActivity,
  api_sheetSync_delete,
  api_sheetSync_runNow,
  // Express handlers
  leadSourceWebhook,
  sheetPushWebhook,
  // Background poller
  runDueSheetSyncs
};
