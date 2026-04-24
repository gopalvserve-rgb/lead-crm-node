const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_statuses_list(token) {
  await authUser(token);
  return (await db.getAll('statuses')).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
}
async function api_statuses_save(token, s) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!s.name) throw new Error('name required');
  const payload = { name: s.name, color: s.color || '#6b7280', sort_order: Number(s.sort_order) || 10, is_final: Number(s.is_final) || 0 };
  if (s.id) { await db.update('statuses', s.id, payload); return { id: Number(s.id) }; }
  const id = await db.insert('statuses', payload);
  return { id };
}
module.exports = { api_statuses_list, api_statuses_save };
