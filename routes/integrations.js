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

async function _runSheetSync(integration) {
  if (!String(integration.sheet_id || '').trim()) {
    if (integration.last_error) {
      try { await db.update('sheet_integrations', integration.id, { last_error: '' }); } catch (_) {}
    }
    return { imported: 0, skipped: 0, total: 0, mode: 'push' };
  }
  const url = `https://docs.google.com/spreadsheets/d/${integration.sheet_id}/export?format=csv&gid=${integration.sheet_gid || '0'}`;
  const res = await fetch(url, { redirect: 'follow', timeout: 20000 });
  if (!res.ok) throw new Error('Sheet fetch failed: HTTP ' + res.status + ' (is the sheet shared as "Anyone with link â Viewer"?)');
  const text = await res.text();
  const rows = _csvParse(text);
  if (rows.length < 2) return { imported: 0, skipped: 0, total: 0 };
  const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
  const data = rows.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));
  const seen = new Set((await db.getAll('sheet_imported_rows'))
    .filter(r => Number(r.integration_id) === Number(integration.id))
    .map(r => r.row_hash));
  let imported = 0, skipped = 0;
  for (const r of data) {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = String(r[i] || '').trim(); });
    const hash = _hashRow(obj);
    if (seen.has(hash)) { skipped++; continue; }
    if (!obj.name && !obj.phone && !obj.mobile) { skipped++; continue; }
    obj.source = obj.source || integration.default_source || 'Google Sheet';
    if (!obj.assigned_to && integration.default_assignee_id) {
      obj.assigned_to = integration.default_assignee_id;
    }
    try {
      const created = await _internalCreateLead(obj, integration.created_by);
      await db.insert('sheet_imported_rows', {
        integration_id: integration.id, row_hash: hash, imported_at: db.nowIso(),
        lead_id: created.id || null
      });
      imported++;
    } catch (e) {
      await db.insert('sheet_imported_rows', {
        integration_id: integration.id, row_hash: hash, imported_at: db.nowIso(),
        lead_id: null
      });
      skipped++;
    }
  }
  await db.update('sheet_integrations', integration.id, {
    last_synced_at: db.nowIso(),
    last_synced_count: imported,
    last_error: ''
  });
  return { imported, skipped, total: data.length };
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
  const data = {
    name: String(p.name).trim(),
    sheet_id, sheet_gid,
    default_source: p.default_source || 'Google Sheet',
    default_assignee_id: p.default_assignee_id ? Number(p.default_assignee_id) : null,
    poll_interval_min: Math.max(5, Number(p.poll_interval_min) || 15),
    is_active: p.is_active === 0 ? 0 : 1
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
  api_sheetSync_delete,
  api_sheetSync_runNow,
  // Express handlers
  leadSourceWebhook,
  sheetPushWebhook,
  // Background poller
  runDueSheetSyncs
};
