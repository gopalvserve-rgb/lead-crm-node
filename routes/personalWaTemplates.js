const db = require('../db/pg');
const { authUser } = require('../utils/auth');

/**
 * Personal WhatsApp templates — reusable messages for the 💬 button.
 *
 * Each user maintains their own library (owner_id). Body can use
 * placeholders like {name}, {first_name}, {phone}, {company}, {value},
 * {my_name}, {calendly} — the frontend substitutes them when opening
 * wa.me, the rep just hits Send in WhatsApp.
 *
 * Truly silent / programmatic sending from a personal number is not
 * possible (WhatsApp ToS). For automated business sending see the
 * existing Cloud API templates (🟢 button).
 */
async function api_personalWa_list(token) {
  const me = await authUser(token);
  const rows = await db.getAll('personal_wa_templates');
  return rows
    .filter(r => Number(r.owner_id) === Number(me.id) && Number(r.is_active) === 1)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(r => ({ id: r.id, name: r.name, body: r.body }));
}

async function api_personalWa_save(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.name) throw new Error('Template name is required');
  if (!p.body) throw new Error('Template body is required');
  const data = {
    name: String(p.name).trim().slice(0, 80),
    body: String(p.body).slice(0, 4000),
    is_active: 1
  };
  if (p.id) {
    // Verify ownership
    const existing = await db.findOneBy('personal_wa_templates', 'id', p.id);
    if (!existing || Number(existing.owner_id) !== Number(me.id)) throw new Error('Not yours');
    await db.update('personal_wa_templates', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  data.owner_id = me.id;
  data.created_at = db.nowIso();
  const id = await db.insert('personal_wa_templates', data);
  return { id, ok: true };
}

async function api_personalWa_delete(token, id) {
  const me = await authUser(token);
  const existing = await db.findOneBy('personal_wa_templates', 'id', id);
  if (!existing || Number(existing.owner_id) !== Number(me.id)) throw new Error('Not yours');
  await db.update('personal_wa_templates', id, { is_active: 0 });
  return { ok: true };
}

module.exports = {
  api_personalWa_list,
  api_personalWa_save,
  api_personalWa_delete
};
