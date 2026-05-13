/**
 * utils/sourceMapping.js — per-source field-mapping config.
 *
 * Lets admins remap any incoming JSON key from external integrations
 * (IndiaMART, MagicBricks, /hook/website, Make.com, Zapier etc.) to
 * any CRM lead field, including custom fields. Useful when a vendor
 * sends a field your default mapper doesn't recognise.
 *
 * Storage: lead_source_mapping (source TEXT PK, mapping JSONB,
 * last_payload JSONB, last_seen_at TIMESTAMPTZ, updated_at).
 *
 * Auth: admin/manager only. The map is keyed by source name
 * (lowercased) — same identifier we use in /hook/leadsource/:source
 * and /hook/website's `source` field.
 */

'use strict';

const db = require('../db/pg');
const { authUser } = require('./auth');

const KNOWN_KEYS_BY_SOURCE = {
  indiamart:     ['SENDER_NAME', 'SENDER_MOBILE', 'SENDER_EMAIL', 'SENDER_COMPANY', 'SENDER_CITY', 'SENDER_STATE', 'SENDER_ADDRESS', 'QUERY_MESSAGE', 'QUERY_PRODUCT_NAME', 'UNIQUE_QUERY_ID', 'SUBJECT'],
  magicbricks:   ['contact_person', 'mobile', 'email', 'city', 'message', 'remarks', 'requirement', 'lead_id', 'projectName', 'budget'],
  justdial:      ['prefix', 'name', 'mobile', 'email', 'city', 'category', 'service', 'enquiry', 'leadid', 'area'],
  tradeindia:    ['GLUSR_USR_FNAME', 'GLUSR_USR_PHONE', 'GLUSR_USR_EMAIL', 'GLUSR_USR_COMPANY', 'GLUSR_USR_CITY', 'MESSAGE', 'QUERY_ID', 'GLUSR_USR_INTRESTED_PRODUCTS'],
  '99acres':     ['name', 'mobile', 'email', 'city', 'message', 'lead_id', 'projectName', 'budget'],
  housing:       ['name', 'phone', 'email', 'city', 'message', 'project', 'budget', 'lead_id'],
  website:       ['name', 'phone', 'email', 'company', 'city', 'state', 'address', 'message', 'source', 'source_ref', 'product', 'value', 'tags', 'campaign_name_new', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gad_campaignid'],
  pabbly:        ['name', 'phone', 'email', 'company', 'city', 'message', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'gclid'],
  zapier:        ['name', 'phone', 'email', 'company', 'city', 'message', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'gclid'],
  make:          ['name', 'full_name', 'contact_name', 'phone', 'mobile', 'email', 'company', 'organization', 'city', 'message', 'enquiry', 'source', 'source_ref', 'utm_source', 'utm_medium', 'utm_campaign', 'gclid'],
  generic:       ['name', 'phone', 'email', 'company', 'city', 'state', 'address', 'message', 'source', 'source_ref', 'product', 'value', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gad_campaignid']
};

const CRM_FIELDS = ['name', 'phone', 'email', 'company', 'city', 'state', 'address', 'source', 'source_ref', 'notes', 'product', 'value', 'tags', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gad_campaignid'];

async function _ensureTable() {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS lead_source_mapping (
      source        TEXT PRIMARY KEY,
      mapping       JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_payload  JSONB,
      last_seen_at  TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  } catch (_) {}
}

async function loadMapping(source) {
  try {
    const r = await db.query(`SELECT mapping FROM lead_source_mapping WHERE source = $1`, [String(source).toLowerCase()]);
    if (r.rows[0] && r.rows[0].mapping) {
      const m = typeof r.rows[0].mapping === 'string' ? JSON.parse(r.rows[0].mapping) : r.rows[0].mapping;
      return m || null;
    }
  } catch (_) {}
  return null;
}

async function saveLastPayload(source, payload) {
  try {
    await _ensureTable();
    await db.query(
      `INSERT INTO lead_source_mapping (source, last_payload, last_seen_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (source) DO UPDATE SET last_payload = EXCLUDED.last_payload, last_seen_at = NOW()`,
      [String(source).toLowerCase(), JSON.stringify(payload).slice(0, 60000)]
    );
  } catch (_) {}
}

function _flattenPayload(p) {
  if (Array.isArray(p) && p.length) return _flattenPayload(p[0]);
  if (!p || typeof p !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      Object.assign(out, _flattenPayload(v[0]));
    } else if (typeof v === 'object') {
      Object.assign(out, _flattenPayload(v));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function applyMapping(payload, mapping) {
  if (!mapping || typeof mapping !== 'object') return null;
  const flat = _flattenPayload(payload);
  const out = {};
  let used = 0;
  for (const [srcKey, crmField] of Object.entries(mapping)) {
    if (!crmField) continue;
    const v = flat[srcKey];
    if (v != null && String(v).trim() !== '') {
      out[crmField] = String(v).trim();
      used++;
    }
  }
  return used > 0 ? out : null;
}

async function api_admin_sourceMapping_get(token, source) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureTable();
  const norm = String(source || '').toLowerCase().trim();
  let row = null;
  try {
    const r = await db.query(`SELECT mapping, last_payload, last_seen_at FROM lead_source_mapping WHERE source = $1`, [norm]);
    row = r.rows[0] || null;
  } catch (_) {}
  let cfs = [];
  try {
    cfs = (await db.getAll('custom_fields'))
      .filter(f => Number(f.is_active) !== 0)
      .map(f => ({ key: 'cf_' + f.key, label: f.label }));
  } catch (_) {}
  return {
    source: norm,
    mapping: row ? (typeof row.mapping === 'string' ? JSON.parse(row.mapping) : row.mapping) : {},
    last_payload: row ? row.last_payload : null,
    last_seen_at: row ? row.last_seen_at : null,
    known_keys: KNOWN_KEYS_BY_SOURCE[norm] || KNOWN_KEYS_BY_SOURCE.generic,
    crm_fields: CRM_FIELDS,
    custom_fields: cfs
  };
}

async function api_admin_sourceMapping_save(token, source, mapping) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureTable();
  const norm = String(source || '').toLowerCase().trim();
  if (!norm) throw new Error('source required');
  const map = (mapping && typeof mapping === 'object') ? mapping : {};
  const clean = {};
  Object.keys(map).forEach(k => {
    if (k && map[k]) clean[String(k)] = String(map[k]);
  });
  await db.query(
    `INSERT INTO lead_source_mapping (source, mapping, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (source) DO UPDATE SET mapping = EXCLUDED.mapping, updated_at = NOW()`,
    [norm, JSON.stringify(clean)]
  );
  return { ok: true, source: norm, mapping: clean };
}

module.exports = {
  loadMapping,
  saveLastPayload,
  applyMapping,
  api_admin_sourceMapping_get,
  api_admin_sourceMapping_save
};
