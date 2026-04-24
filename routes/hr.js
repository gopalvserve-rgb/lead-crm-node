/**
 * routes/hr.js — Attendance, Leaves, Tasks, Salary, Bank Details
 * Mirrors the Apps Script HR module. Same API shape.
 */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

function todayIso() { return new Date().toISOString().slice(0, 10); }

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = x => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- Attendance -----------------------------------------------------

async function api_attendance_checkIn(token, lat, lng) {
  const me = await authUser(token);
  const date = todayIso();

  if (String(process.env.ENFORCE_GPS || '0') === '1') {
    const olat = Number(process.env.OFFICE_LAT);
    const olng = Number(process.env.OFFICE_LNG);
    const rad  = Number(process.env.OFFICE_RADIUS_M || 300);
    if (olat && olng && lat && lng) {
      const dist = haversine(olat, olng, Number(lat), Number(lng));
      if (dist > rad) throw new Error(`Too far from office (${Math.round(dist)}m > ${rad}m)`);
    }
  }

  const existing = (await db.getAll('attendance'))
    .find(a => Number(a.user_id) === Number(me.id) &&
               String(a.date).slice(0, 10) === date);
  if (existing && existing.check_in) throw new Error('Already checked in today');

  const now = db.nowIso();
  if (existing) {
    await db.update('attendance', existing.id, {
      check_in: now,
      check_in_lat: lat || null,
      check_in_lng: lng || null,
      status: 'present'
    });
    return { id: existing.id, check_in: now };
  }
  const id = await db.insert('attendance', {
    user_id: me.id, date, check_in: now,
    check_in_lat: lat || null, check_in_lng: lng || null,
    status: 'present'
  });
  return { id, check_in: now };
}

async function api_attendance_checkOut(token, lat, lng) {
  const me = await authUser(token);
  const date = todayIso();
  const row = (await db.getAll('attendance'))
    .find(a => Number(a.user_id) === Number(me.id) &&
               String(a.date).slice(0, 10) === date);
  if (!row) throw new Error('No check-in found for today');
  if (row.check_out) throw new Error('Already checked out');
  const now = db.nowIso();
  await db.update('attendance', row.id, {
    check_out: now,
    check_out_lat: lat || null,
    check_out_lng: lng || null
  });
  return { id: row.id, check_out: now };
}

async function api_attendance_mine(token, from, to) {
  const me = await authUser(token);
  let rows = (await db.getAll('attendance'))
    .filter(a => Number(a.user_id) === Number(me.id));
  if (from) rows = rows.filter(a => String(a.date).slice(0, 10) >= from);
  if (to)   rows = rows.filter(a => String(a.date).slice(0, 10) <= to);
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return rows;
}

async function api_attendance_team(token, from, to, userId) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  let rows = await db.getAll('attendance');
  if (me.role !== 'admin') rows = rows.filter(a => visible.includes(Number(a.user_id)));
  if (userId) rows = rows.filter(a => Number(a.user_id) === Number(userId));
  if (from)   rows = rows.filter(a => String(a.date).slice(0, 10) >= from);
  if (to)     rows = rows.filter(a => String(a.date).slice(0, 10) <= to);
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  rows = rows.map(r => Object.assign({}, r, { user_name: byId[Number(r.user_id)]?.name || '' }));
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return rows;
}

// ---- Leaves ---------------------------------------------------------

async function api_leaves_mine(token) {
  const me = await authUser(token);
  const rows = (await db.getAll('leaves'))
    .filter(l => Number(l.user_id) === Number(me.id))
    .sort((a, b) => String(b.from_date).localeCompare(String(a.from_date)));
  return rows;
}

async function api_leaves_apply(token, leave) {
  const me = await authUser(token);
  if (!leave.from_date || !leave.to_date) throw new Error('Dates required');
  const id = await db.insert('leaves', {
    user_id: me.id,
    from_date: leave.from_date,
    to_date: leave.to_date,
    reason: leave.reason || '',
    status: 'pending',
    created_at: db.nowIso()
  });
  return { id };
}

async function api_leaves_pending(token) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Forbidden');
  const visible = await getVisibleUserIds(me);
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  return (await db.getAll('leaves'))
    .filter(l => l.status === 'pending' &&
                 (me.role === 'admin' || visible.includes(Number(l.user_id))))
    .map(l => Object.assign({}, l, { user_name: byId[Number(l.user_id)]?.name || '' }))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function api_leaves_decide(token, id, decision) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Forbidden');
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Bad decision');
  await db.update('leaves', id, { status: decision, approved_by: me.id });
  return { ok: true };
}

// ---- Tasks (HR-style daily tasks) ----------------------------------

async function api_tasks_list(token, filters) {
  const me = await authUser(token);
  filters = filters || {};
  let rows = await db.getAll('tasks');
  const visible = await getVisibleUserIds(me);
  if (me.role !== 'admin') {
    rows = rows.filter(t =>
      Number(t.assigned_to) === Number(me.id) ||
      Number(t.created_by) === Number(me.id) ||
      visible.includes(Number(t.assigned_to))
    );
  }
  if (filters.status)       rows = rows.filter(t => t.status === filters.status);
  if (filters.assigned_to)  rows = rows.filter(t => Number(t.assigned_to) === Number(filters.assigned_to));
  if (filters.from)         rows = rows.filter(t => String(t.due_at || '').slice(0, 10) >= filters.from);
  if (filters.to)           rows = rows.filter(t => String(t.due_at || '').slice(0, 10) <= filters.to);

  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  rows = rows.map(t => Object.assign({}, t, {
    assigned_name: byId[Number(t.assigned_to)]?.name || '',
    creator_name:  byId[Number(t.created_by)]?.name  || ''
  }));
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rows;
}

async function api_tasks_save(token, task) {
  const me = await authUser(token);
  const t = task || {};
  if (!t.title) throw new Error('Title required');
  const payload = {
    title: t.title,
    description: t.description || '',
    assigned_to: t.assigned_to || me.id,
    due_at: t.due_at || null,
    priority: t.priority || 'normal',
    status: t.status || 'open'
  };
  if (t.id) { await db.update('tasks', t.id, payload); return { id: Number(t.id) }; }
  payload.created_by = me.id;
  payload.created_at = db.nowIso();
  const id = await db.insert('tasks', payload);
  return { id };
}

async function api_tasks_complete(token, id) {
  const me = await authUser(token);
  const t = await db.findById('tasks', id);
  if (!t) throw new Error('Task not found');
  if (Number(t.assigned_to) !== Number(me.id) && me.role !== 'admin') {
    throw new Error('Not your task');
  }
  await db.update('tasks', id, { status: 'done', completed_at: db.nowIso() });
  return { ok: true };
}

// ---- Salary ---------------------------------------------------------

async function api_salary_mine(token) {
  const me = await authUser(token);
  return (await db.getAll('salaries'))
    .filter(s => Number(s.user_id) === Number(me.id))
    .sort((a, b) => String(b.month).localeCompare(String(a.month)));
}

async function api_salary_list(token, userId) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const visible = await getVisibleUserIds(me);
  let rows = await db.getAll('salaries');
  if (me.role !== 'admin') rows = rows.filter(s => visible.includes(Number(s.user_id)));
  if (userId) rows = rows.filter(s => Number(s.user_id) === Number(userId));
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  return rows.map(s => Object.assign({}, s, { user_name: byId[Number(s.user_id)]?.name || '' }))
             .sort((a, b) => String(b.month).localeCompare(String(a.month)));
}

async function api_salary_save(token, sal) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!sal.user_id || !sal.month) throw new Error('user_id and month required');
  const base = Number(sal.base) || 0;
  const allowances = Number(sal.allowances) || 0;
  const deductions = Number(sal.deductions) || 0;
  const payload = {
    user_id: sal.user_id, month: sal.month,
    base, allowances, deductions,
    net_pay: base + allowances - deductions,
    notes: sal.notes || ''
  };
  if (sal.id) { await db.update('salaries', sal.id, payload); return { id: Number(sal.id) }; }
  payload.created_at = db.nowIso();
  const id = await db.insert('salaries', payload);
  return { id };
}

// ---- Bank Details ---------------------------------------------------

async function api_bank_mine(token) {
  const me = await authUser(token);
  return await db.findOneBy('bank_details', 'user_id', me.id);
}

async function api_bank_save(token, info) {
  const me = await authUser(token);
  const payload = {
    bank_name: info.bank_name || '',
    account_holder: info.account_holder || '',
    account_number: info.account_number || '',
    ifsc: info.ifsc || '',
    branch: info.branch || '',
    upi_id: info.upi_id || '',
    notes: info.notes || '',
    updated_at: db.nowIso()
  };
  const existing = await db.findOneBy('bank_details', 'user_id', me.id);
  if (existing) {
    await db.update('bank_details', existing.id, payload);
    return { id: existing.id };
  }
  payload.user_id = me.id;
  const id = await db.insert('bank_details', payload);
  return { id };
}

async function api_bank_list(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  return (await db.getAll('bank_details'))
    .map(b => Object.assign({}, b, {
      user_name: byId[Number(b.user_id)]?.name || '',
      account_number: b.account_number
        ? '****' + String(b.account_number).slice(-4)
        : ''
    }));
}

module.exports = {
  api_attendance_checkIn, api_attendance_checkOut,
  api_attendance_mine, api_attendance_team,
  api_leaves_mine, api_leaves_apply, api_leaves_pending, api_leaves_decide,
  api_tasks_list, api_tasks_save, api_tasks_complete,
  api_salary_mine, api_salary_list, api_salary_save,
  api_bank_mine, api_bank_save, api_bank_list
};
