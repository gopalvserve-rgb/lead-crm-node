// PostgreSQL adapter. Exposes the same API as the previous Sheets adapter
// so route files don't need to change:
//   getAll(table), findById(table, id), findOneBy(table, field, value),
//   findBy(table, field, value), insert(table, row), update(table, id, patch),
//   removeRow(table, id), nowIso()

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[db/pg] WARNING: DATABASE_URL is not set.');
}

const ssl =
  String(process.env.DB_SSL || '').toLowerCase() === '1' ||
  /\b(supabase|neon|render|railway|heroku|aws)\b/i.test(connectionString || '')
    ? { rejectUnauthorized: false }
    : false;

const pool = new Pool({
  connectionString,
  ssl,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', (err) => {
  console.error('[db/pg] Unexpected pool error:', err);
});

// -------------------------------------------------------------------
// Known tables and their columns. Used for safe INSERT/UPDATE builders.
// The `id` column is SERIAL on every table.
// JSONB columns are auto-serialized from JS objects.
// -------------------------------------------------------------------
const SCHEMA = {
  users: {
    columns: ['name', 'email', 'phone', 'role', 'password_hash', 'parent_id',
              'department', 'designation', 'photo_url',
              'monthly_salary', 'joining_date',
              'is_active', 'created_at'],
    json: []
  },
  leads: {
    columns: ['name', 'phone', 'alt_phone', 'whatsapp', 'email', 'source',
              'source_ref', 'product', 'product_id', 'status_id', 'assigned_to',
              'created_by', 'created_at', 'updated_at',
              'last_status_change_at', 'next_followup_at',
              'is_duplicate', 'duplicate_of', 'tags', 'notes',
              'address', 'city', 'state', 'pincode', 'country', 'company',
              'value', 'currency', 'meta_json', 'extra_json'],
    json: ['meta_json', 'extra_json']
  },
  remarks: {
    columns: ['lead_id', 'user_id', 'remark', 'status_id', 'created_at'],
    json: []
  },
  followups: {
    columns: ['lead_id', 'user_id', 'due_at', 'note', 'is_done',
              'created_at', 'done_at'],
    json: []
  },
  statuses: {
    columns: ['name', 'color', 'sort_order', 'is_final'],
    json: []
  },
  sources: {
    columns: ['name', 'is_active'],
    json: []
  },
  products: {
    columns: ['name', 'description', 'price', 'is_active'],
    json: []
  },
  custom_fields: {
    columns: ['key', 'label', 'field_type', 'options', 'is_required',
              'show_in_list', 'sort_order', 'is_active'],
    json: []
  },
  assignment_rules: {
    columns: ['name', 'field', 'operator', 'value', 'assigned_to',
              'priority', 'is_active'],
    json: []
  },
  notifications: {
    columns: ['user_id', 'type', 'title', 'body', 'link', 'is_read',
              'created_at'],
    json: []
  },
  attendance: {
    columns: ['user_id', 'date', 'check_in', 'check_out',
              'check_in_lat', 'check_in_lng', 'check_out_lat', 'check_out_lng',
              'status', 'notes', 'device_info', 'user_agent', 'ip'],
    json: []
  },
  leaves: {
    columns: ['user_id', 'from_date', 'to_date', 'reason', 'status',
              'approved_by', 'created_at'],
    json: []
  },
  tasks: {
    columns: ['title', 'description', 'assigned_to', 'created_by',
              'due_at', 'priority', 'status', 'created_at', 'completed_at'],
    json: []
  },
  salaries: {
    columns: ['user_id', 'month', 'base', 'allowances', 'deductions',
              'net_pay', 'notes', 'created_at'],
    json: []
  },
  bank_details: {
    columns: ['user_id', 'bank_name', 'account_holder', 'account_number',
              'ifsc', 'branch', 'upi_id', 'notes', 'updated_at'],
    json: []
  },
  config: {
    columns: ['key', 'value', 'updated_at'],
    json: []
  },
  webhook_log: {
    columns: ['source', 'payload', 'received_at', 'processed', 'error'],
    json: ['payload']
  },
  whatsapp_messages: {
    columns: ['lead_id', 'direction', 'from_number', 'to_number',
              'body', 'wa_message_id', 'status', 'created_at'],
    json: []
  },
  automations: {
    columns: ['name', 'event', 'condition', 'channel', 'recipient',
              'subject', 'template', 'is_active', 'created_at'],
    json: []
  },
  automation_log: {
    columns: ['automation_id', 'lead_id', 'event', 'channel',
              'recipient', 'status', 'detail', 'created_at'],
    json: []
  },
  role_permissions: {
    columns: ['role', 'permission', 'scope', 'is_granted'],
    json: []
  }
};

function _schema(table) {
  const s = SCHEMA[table];
  if (!s) throw new Error(`Unknown table: ${table}`);
  return s;
}

// Columns that should never accept '' — silently convert to null.
// Covers integer FKs, timestamps, booleans, numerics across the schema.
const NULLABLE_INTS = new Set([
  'parent_id', 'manager_id', 'team_leader_id',
  'status_id', 'assigned_to', 'created_by', 'user_id', 'lead_id',
  'product_id', 'duplicate_of', 'approved_by',
  'is_active', 'is_read', 'is_done', 'is_final', 'is_required',
  'is_duplicate', 'show_in_list', 'sort_order', 'priority',
  'monthly_salary', 'base', 'allowances', 'deductions', 'net_pay', 'value'
]);
const NULLABLE_TS = new Set([
  'created_at', 'updated_at', 'last_status_change_at', 'next_followup_at',
  'check_in', 'check_out', 'due_at', 'completed_at', 'done_at',
  'received_at', 'joining_date', 'from_date', 'to_date'
]);

function _coerce(k, v) {
  if (v === '' && (NULLABLE_INTS.has(k) || NULLABLE_TS.has(k))) return null;
  return v;
}

function _serialize(table, row) {
  const { columns, json } = _schema(table);
  const out = {};
  for (const k of columns) {
    if (row[k] === undefined) continue;
    let v = _coerce(k, row[k]);
    if (json.includes(k)) {
      if (v === '' || v == null) v = null;
      else if (typeof v !== 'string') v = JSON.stringify(v);
    }
    out[k] = v;
  }
  return out;
}

function _deserialize(table, row) {
  if (!row) return row;
  const { json } = _schema(table);
  for (const k of json) {
    if (row[k] && typeof row[k] === 'string') {
      try { row[k] = JSON.parse(row[k]); } catch (_) {}
    }
  }
  return row;
}

async function query(sql, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function getAll(table) {
  _schema(table);
  const { rows } = await query(`SELECT * FROM ${table} ORDER BY id ASC`);
  return rows.map(r => _deserialize(table, r));
}

async function findById(table, id) {
  _schema(table);
  const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ? _deserialize(table, rows[0]) : null;
}

async function findOneBy(table, field, value) {
  _schema(table);
  const { rows } = await query(
    `SELECT * FROM ${table} WHERE ${field} = $1 LIMIT 1`,
    [value]
  );
  return rows[0] ? _deserialize(table, rows[0]) : null;
}

async function findBy(table, field, value) {
  _schema(table);
  const { rows } = await query(
    `SELECT * FROM ${table} WHERE ${field} = $1 ORDER BY id ASC`,
    [value]
  );
  return rows.map(r => _deserialize(table, r));
}

async function insert(table, row) {
  const data = _serialize(table, row);
  const keys = Object.keys(data);
  if (keys.length === 0) throw new Error(`insert: no valid columns for ${table}`);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const cols = keys.join(', ');
  const values = keys.map(k => data[k]);
  const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING id`;
  const { rows } = await query(sql, values);
  return rows[0].id;
}

async function update(table, id, patch) {
  const data = _serialize(table, patch);
  const keys = Object.keys(data);
  if (keys.length === 0) return 0;
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => data[k]);
  values.push(id);
  const sql = `UPDATE ${table} SET ${setClause} WHERE id = $${values.length}`;
  const res = await query(sql, values);
  return res.rowCount;
}

async function removeRow(table, id) {
  _schema(table);
  const res = await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return res.rowCount;
}

function nowIso() {
  return new Date().toISOString();
}

// Simple key/value config helpers (replaces GAS Script Properties)
async function getConfig(key, fallback) {
  const r = await findOneBy('config', 'key', key);
  if (r && r.value != null) return r.value;
  return process.env[key] != null ? process.env[key] : fallback;
}
async function setConfig(key, value) {
  const existing = await findOneBy('config', 'key', key);
  if (existing) {
    await update('config', existing.id, { value: String(value), updated_at: nowIso() });
  } else {
    await insert('config', { key, value: String(value), updated_at: nowIso() });
  }
}

module.exports = {
  pool, query,
  getAll, findById, findOneBy, findBy,
  insert, update, removeRow,
  getConfig, setConfig, nowIso,
  SCHEMA
};
