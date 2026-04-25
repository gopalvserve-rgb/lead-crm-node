const db = require('../db/pg');
const { authUser, hashPassword, getVisibleUserIds } = require('../utils/auth');

async function api_users_list(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const all = await db.getAll('users');
  const byId = {};
  all.forEach(u => { byId[Number(u.id)] = u; });
  return all
    .filter(u => visible.includes(Number(u.id)))
    .map(u => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone,
      role: u.role, parent_id: u.parent_id,
      parent_name: byId[Number(u.parent_id)]?.name || '',
      department: u.department, monthly_salary: u.monthly_salary,
      joining_date: u.joining_date, photo_url: u.photo_url,
      is_active: u.is_active, created_at: u.created_at
    }));
}

async function api_users_create(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const p = payload || {};
  if (!p.name || !p.email || !p.password || !p.role) throw new Error('name, email, password, role required');
  if (await db.findOneBy('users', 'email', String(p.email).toLowerCase().trim())) {
    throw new Error('Email already registered');
  }
  const id = await db.insert('users', {
    name: p.name,
    email: String(p.email).toLowerCase().trim(),
    phone: p.phone || '',
    password_hash: hashPassword(p.password),
    role: p.role,
    parent_id: p.parent_id || me.id,
    department: p.department || '',
    monthly_salary: p.monthly_salary || 0,
    joining_date: p.joining_date || '',
    photo_url: p.photo_url || '',
    is_active: 1
  });
  return { id };
}

async function api_users_update(token, id, patch) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role) && Number(me.id) !== Number(id)) {
    throw new Error('Forbidden');
  }
  const p = patch || {};
  const allowed = {};
  ['name', 'phone', 'department', 'monthly_salary', 'joining_date', 'photo_url', 'is_active'].forEach(k => {
    if (k in p) allowed[k] = p[k];
  });
  if (['admin', 'manager'].includes(me.role)) {
    if ('role' in p) allowed.role = p.role;
    if ('parent_id' in p) allowed.parent_id = p.parent_id;
  }
  if (p.password) allowed.password_hash = hashPassword(p.password);
  await db.update('users', id, allowed);
  return { ok: true };
}

async function api_users_updateSelf(token, patch) {
  const me = await authUser(token);
  const allowed = {};
  ['name', 'phone', 'photo_url'].forEach(k => {
    if (k in patch) allowed[k] = patch[k];
  });
  await db.update('users', me.id, allowed);
  return { ok: true };
}

// Convenience: create if no id, update otherwise
async function api_users_save(token, payload) {
  if (payload && payload.id) {
    const { id, ...patch } = payload;
    return api_users_update(token, id, patch);
  }
  return api_users_create(token, payload);
}

/**
 * Generate a friendly-looking but secure-enough random password.
 * 12 chars, mixed case + digits + a small punctuation set, with at least
 * one of each so it doesn't collide with strict policies on first login.
 */
function _generateTempPassword() {
  const upper  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // omit I, O for readability
  const lower  = 'abcdefghijkmnpqrstuvwxyz';   // omit l, o
  const digits = '23456789';                   // omit 0, 1
  const punct  = '@#$%&*';
  const all = upper + lower + digits + punct;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(punct)];
  while (chars.length < 12) chars.push(pick(all));
  // Shuffle so the guaranteed types aren't always at the start
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Admin / manager: reset any visible user's password.
 *   - Admin can reset anyone (including other admins) except their own active session targets — but they can also reset themselves.
 *   - Manager can reset only users in their hierarchy (per getVisibleUserIds).
 *   - team_leader / sales / employee: forbidden.
 *
 * Pass `newPassword` to set a specific value; pass empty/null to auto-generate.
 * Returns `{ password: '<plaintext>' }` so the admin can copy & share it. The
 * plaintext is never logged or stored — the DB only sees the bcrypt hash.
 */
async function api_users_resetPassword(token, userId, newPassword) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) {
    throw new Error('Only admins or managers can reset passwords');
  }
  const target = await db.findById('users', userId);
  if (!target) throw new Error('User not found');

  // Managers can only reset users below them in the hierarchy.
  if (me.role === 'manager') {
    const visible = await getVisibleUserIds(me);
    if (!visible.includes(Number(target.id))) {
      throw new Error('Forbidden — user is outside your team');
    }
    // Managers must not reset other admins/managers — only people they manage.
    if (['admin', 'manager'].includes(target.role) && Number(target.id) !== Number(me.id)) {
      throw new Error('Forbidden — managers cannot reset other admins/managers');
    }
  }

  // Use the supplied password if it looks usable; otherwise generate a fresh one.
  const trimmed = String(newPassword || '').trim();
  const plain = trimmed.length >= 6 ? trimmed : _generateTempPassword();
  await db.update('users', userId, { password_hash: hashPassword(plain) });
  return { password: plain };
}

module.exports = {
  api_users_list, api_users_create, api_users_update,
  api_users_updateSelf, api_users_save, api_users_resetPassword
};
