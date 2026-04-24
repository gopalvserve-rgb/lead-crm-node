const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

async function api_notifications_mine(token) {
  const me = await authUser(token);
  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const allFollowups = await db.getAll('followups');
  const leadsById = {};
  (await db.getAll('leads')).forEach(l => { leadsById[Number(l.id)] = l; });
  const mine = allFollowups.filter(f => Number(f.user_id) === Number(me.id) && Number(f.is_done) === 0);

  const overdue = [], due_today = [], upcoming = [];
  mine.forEach(f => {
    const row = Object.assign({}, f, {
      lead_name: leadsById[Number(f.lead_id)]?.name || '',
      lead_phone: leadsById[Number(f.lead_id)]?.phone || ''
    });
    if (!f.due_at) return;
    if (String(f.due_at) < now && String(f.due_at).slice(0, 10) !== todayStr) overdue.push(row);
    else if (String(f.due_at).slice(0, 10) === todayStr) due_today.push(row);
    else if (String(f.due_at) > now) upcoming.push(row);
  });
  overdue.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  due_today.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  upcoming.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));

  const notifications = (await db.getAll('notifications'))
    .filter(n => Number(n.user_id) === Number(me.id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const unread_notifications = notifications.filter(n => Number(n.is_read) === 0);

  return {
    overdue, due_today, upcoming, unread_notifications,
    counts: { overdue: overdue.length, due_today: due_today.length, unread: unread_notifications.length, upcoming: upcoming.length }
  };
}

async function api_notifications_read(token, id) {
  await authUser(token);
  await db.update('notifications', id, { is_read: 1 });
  return { ok: true };
}
async function api_notifications_read_all(token) {
  const me = await authUser(token);
  const mine = (await db.getAll('notifications')).filter(n => Number(n.user_id) === Number(me.id) && Number(n.is_read) === 0);
  for (const n of mine) await db.update('notifications', n.id, { is_read: 1 });
  return { ok: true, count: mine.length };
}
module.exports = { api_notifications_mine, api_notifications_read, api_notifications_read_all };
