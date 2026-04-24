const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

async function _visibleLeads(me) {
  const visible = await getVisibleUserIds(me);
  return (await db.getAll('leads')).filter(l => {
    if (me.role === 'admin') return true;
    if (!l.assigned_to) return false;
    return visible.includes(Number(l.assigned_to));
  });
}

async function api_reports_summary(token, filters) {
  const me = await authUser(token);
  filters = filters || {};
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  if (filters.from) rows = rows.filter(l => String(l.created_at).slice(0, 10) >= filters.from);
  if (filters.to)   rows = rows.filter(l => String(l.created_at).slice(0, 10) <= filters.to);
  if (filters.scope_user_id) rows = rows.filter(l => Number(l.assigned_to) === Number(filters.scope_user_id));
  if (filters.role) {
    const userIds = users.filter(u => u.role === filters.role).map(u => Number(u.id));
    rows = rows.filter(l => userIds.includes(Number(l.assigned_to)));
  }
  if (filters.product_id) rows = rows.filter(l => Number(l.product_id) === Number(filters.product_id));
  if (filters.source)     rows = rows.filter(l => (l.source || '') === filters.source);
  if (filters.tag)        rows = rows.filter(l => String(l.tags || '').toLowerCase().split(',').map(s => s.trim()).includes(String(filters.tag).toLowerCase()));
  if (filters.custom_key && filters.custom_value) {
    rows = rows.filter(l => {
      try {
        const extra = typeof l.extra_json === 'string' ? JSON.parse(l.extra_json) : (l.extra_json || {});
        return String(extra[filters.custom_key] || '').toLowerCase() === String(filters.custom_value).toLowerCase();
      } catch (_) { return false; }
    });
  }

  const statuses = await db.getAll('statuses');
  const byStatus = statuses.map(s => ({
    status: s.name, color: s.color,
    c: rows.filter(l => Number(l.status_id) === Number(s.id)).length
  }));
  const bySource = {};
  rows.forEach(l => { bySource[l.source || '—'] = (bySource[l.source || '—'] || 0) + 1; });
  const bySourceArr = Object.keys(bySource).map(k => ({ source: k, c: bySource[k] }));

  const won = rows.filter(l => {
    const s = statuses.find(x => Number(x.id) === Number(l.status_id));
    return s && s.name === 'Won';
  }).length;
  const lost = rows.filter(l => {
    const s = statuses.find(x => Number(x.id) === Number(l.status_id));
    return s && s.name === 'Lost';
  }).length;
  const newCount = rows.filter(l => {
    const s = statuses.find(x => Number(x.id) === Number(l.status_id));
    return s && s.name === 'New';
  }).length;

  const byUser = users
    .filter(u => users.find(uu => Number(uu.id) === Number(u.id)))
    .map(u => {
      const mine = rows.filter(l => Number(l.assigned_to) === Number(u.id));
      return {
        id: u.id, name: u.name, role: u.role,
        total: mine.length,
        new_leads: mine.filter(l => statuses.find(s => Number(s.id) === Number(l.status_id) && s.name === 'New')).length,
        open_leads: mine.filter(l => !statuses.find(s => Number(s.id) === Number(l.status_id) && Number(s.is_final) === 1)).length,
        won: mine.filter(l => statuses.find(s => Number(s.id) === Number(l.status_id) && s.name === 'Won')).length,
        lost: mine.filter(l => statuses.find(s => Number(s.id) === Number(l.status_id) && s.name === 'Lost')).length
      };
    }).filter(x => x.total > 0);

  const byManager = users.filter(u => u.role === 'manager').map(u => ({ name: u.name, total: 0, won: 0, lost: 0 }));
  const byTeamLeader = users.filter(u => u.role === 'team_leader').map(u => ({ name: u.name, total: 0, won: 0, lost: 0 }));

  // Scope options (non-admin users)
  const scope_options = users.filter(u => Number(u.is_active) === 1)
    .map(u => ({ id: u.id, name: u.name, role: u.role }));

  return {
    totals: { total: rows.length, new_leads: newCount, won, lost },
    by_status: byStatus, by_source: bySourceArr, by_user: byUser,
    by_manager: byManager, by_team_leader: byTeamLeader,
    scope_options
  };
}

async function api_reports_funnel(token, filters) {
  const me = await authUser(token);
  filters = filters || {};
  let rows = await _visibleLeads(me);
  if (filters.from) rows = rows.filter(l => String(l.created_at).slice(0, 10) >= filters.from);
  if (filters.to)   rows = rows.filter(l => String(l.created_at).slice(0, 10) <= filters.to);
  const statuses = (await db.getAll('statuses')).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const counts = {}; rows.forEach(l => { const k = Number(l.status_id) || 0; counts[k] = (counts[k] || 0) + 1; });
  return statuses.map(s => ({ id: s.id, name: s.name, color: s.color, count: counts[Number(s.id)] || 0, sort_order: s.sort_order }));
}

module.exports = { api_reports_summary, api_reports_funnel };
