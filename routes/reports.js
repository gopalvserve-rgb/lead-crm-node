const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// Timezone the user thinks of "today" in. Server runs UTC on Railway but
// our users are in India, so a lead created at 04:00 IST on Apr 26 is stored
// as 22:30 UTC on Apr 25 and was previously bucketed as Apr 25 — which made
// the date+user filter return wrong totals (e.g. "Vaibhav, yesterday" missed
// late-night leads). Convert to the configured timezone before slicing.
const REPORT_TZ = process.env.TIMEZONE || 'Asia/Kolkata';
const _tzFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});
function _tzDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  // en-CA locale formats as "YYYY-MM-DD" — perfect for string compare.
  return _tzFmt.format(d);
}

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
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  rows = await _applyReportFilters(rows, filters, users);

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

/**
 * Apply the same set of filters everywhere — date range, user/role, product,
 * source, tag, custom field. Centralised so the funnel, daily breakdown, and
 * summary always agree on what's "in scope".
 */
async function _applyReportFilters(rows, filters, users) {
  filters = filters || {};
  if (filters.from) rows = rows.filter(l => _tzDate(l.created_at) >= filters.from);
  if (filters.to)   rows = rows.filter(l => _tzDate(l.created_at) <= filters.to);
  if (filters.scope_user_id) rows = rows.filter(l => Number(l.assigned_to) === Number(filters.scope_user_id));
  if (filters.role) {
    const userIds = (users || []).filter(u => u.role === filters.role).map(u => Number(u.id));
    rows = rows.filter(l => userIds.includes(Number(l.assigned_to)));
  }
  if (filters.product_id) rows = rows.filter(l => Number(l.product_id) === Number(filters.product_id));
  if (filters.source)     rows = rows.filter(l => (l.source || '') === filters.source);
  if (filters.tag) {
    const t = String(filters.tag).toLowerCase();
    rows = rows.filter(l => String(l.tags || '').toLowerCase().split(',').map(s => s.trim()).includes(t));
  }
  if (filters.custom_key && filters.custom_value) {
    rows = rows.filter(l => {
      try {
        const extra = typeof l.extra_json === 'string' ? JSON.parse(l.extra_json) : (l.extra_json || {});
        return String(extra[filters.custom_key] || '').toLowerCase() === String(filters.custom_value).toLowerCase();
      } catch (_) { return false; }
    });
  }
  return rows;
}

async function api_reports_funnel(token, filters) {
  const me = await authUser(token);
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  rows = await _applyReportFilters(rows, filters, users);
  const statuses = (await db.getAll('statuses')).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const counts = {}; rows.forEach(l => { const k = Number(l.status_id) || 0; counts[k] = (counts[k] || 0) + 1; });
  return statuses.map(s => ({ id: s.id, name: s.name, color: s.color, count: counts[Number(s.id)] || 0, sort_order: s.sort_order }));
}

/**
 * Per-day breakdown for the selected filters. Returns one row per day in the
 * range (including zero-count days so the chart shows a continuous line).
 *
 * Each row: { date: 'YYYY-MM-DD', total, new_leads, won, lost, open }
 *
 * If from/to aren't provided, defaults to the last 30 days based on the data
 * itself. If there's no data, returns an empty array.
 */
async function api_reports_daily(token, filters) {
  const me = await authUser(token);
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  rows = await _applyReportFilters(rows, filters, users);
  const statuses = await db.getAll('statuses');
  const statusById = {};
  statuses.forEach(s => { statusById[Number(s.id)] = s; });
  const isFinal = (l) => {
    const s = statusById[Number(l.status_id)];
    return s && Number(s.is_final) === 1;
  };
  const isName = (l, name) => {
    const s = statusById[Number(l.status_id)];
    return s && s.name === name;
  };

  // Build the date range. Prefer filters.from/to; otherwise span the data.
  let fromDate = filters && filters.from;
  let toDate   = filters && filters.to;
  if (!fromDate || !toDate) {
    if (rows.length === 0) return [];
    const sorted = rows.map(l => _tzDate(l.created_at)).sort();
    if (!fromDate) fromDate = sorted[0];
    if (!toDate)   toDate   = sorted[sorted.length - 1];
  }

  // Bucket leads by local day (in REPORT_TZ) so a lead created at 02:00 IST
  // is counted on its IST date, not the UTC date.
  const buckets = {};
  rows.forEach(l => {
    const d = _tzDate(l.created_at);
    if (!buckets[d]) buckets[d] = { total: 0, new_leads: 0, won: 0, lost: 0, open: 0 };
    buckets[d].total++;
    if (isName(l, 'New'))  buckets[d].new_leads++;
    if (isName(l, 'Won'))  buckets[d].won++;
    if (isName(l, 'Lost')) buckets[d].lost++;
    if (!isFinal(l))       buckets[d].open++;
  });

  // Walk every day in the range so zero-count days appear as a flat zero
  const out = [];
  const start = new Date(fromDate + 'T00:00:00Z');
  const end   = new Date(toDate   + 'T00:00:00Z');
  if (isNaN(start) || isNaN(end) || start > end) return [];
  // Cap at 366 days to keep the response small even on bad input.
  const maxDays = 366;
  let count = 0;
  for (let d = new Date(start); d <= end && count < maxDays; d.setUTCDate(d.getUTCDate() + 1), count++) {
    const key = d.toISOString().slice(0, 10);
    const b = buckets[key] || { total: 0, new_leads: 0, won: 0, lost: 0, open: 0 };
    out.push(Object.assign({ date: key }, b));
  }
  return out;
}

module.exports = { api_reports_summary, api_reports_funnel, api_reports_daily };
