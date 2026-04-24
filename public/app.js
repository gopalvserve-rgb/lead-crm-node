/**
 * Lead CRM — v4 frontend
 * Full-featured SPA over POST /api.
 */

const CRM = {
  token: localStorage.getItem('crm_token') || null,
  user: null,
  config: { company_name: 'Lead CRM', company_logo_url: '', base_url: location.origin },
  cache: {},
  prefs: {
    columns: JSON.parse(localStorage.getItem('crm_cols') || '["name","phone","source","status","assigned","followup","last_change","remark","created"]'),
    filters: JSON.parse(localStorage.getItem('crm_filters') || '{}'),
    showHeader: localStorage.getItem('crm_show_header') !== '0'
  }
};

/* ---------------- API helper ---------------- */
async function api(fn, ...args) {
  const res = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args: [CRM.token, ...args] })
  });
  const j = await res.json();
  if (!res.ok || j.error) {
    if (j.error && /token|User inactive/i.test(j.error)) logout();
    throw new Error(j.error || 'API error');
  }
  return j.result;
}
async function apiRaw(fn, ...args) {
  const res = await fetch('/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args })
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error || 'API error');
  return j.result;
}

/* ---------------- Boot ---------------- */
(async () => {
  try {
    const r = await fetch('/config.json');
    if (r.ok) CRM.config = Object.assign(CRM.config, await r.json());
  } catch (_) {}
  document.title = CRM.config.company_name || 'Lead CRM';

  if (CRM.token) {
    try {
      CRM.user = await api('api_me');
      renderShell();
      await warmCache();
      navigateTo(parseHashView() || 'dashboard');
      startFollowupPolling();
      refreshNotifs();
    } catch (_) { logout(); }
  } else {
    renderLogin();
  }

  window.addEventListener('hashchange', () => {
    if (!CRM.user) return;
    navigateTo(parseHashView() || 'dashboard');
  });
})();

function parseHashView() {
  const m = String(location.hash).match(/^#\/([a-z_-]+)/i);
  return m ? m[1] : null;
}

async function warmCache() {
  const [statuses, sources, products, users, customFields] = await Promise.all([
    api('api_statuses_list'),
    api('api_sources_list'),
    api('api_products_list'),
    api('api_users_list'),
    api('api_customFields_list').catch(() => [])
  ]);
  CRM.cache = { statuses, sources, products, users, customFields };
}

/* ---------------- utility ---------------- */
const $ = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v === false || v == null) {}
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(s, opts) {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (opts === 'short') return d.toLocaleDateString();
    if (opts === 'time') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (opts === 'relative') {
      const diff = Date.now() - d.getTime();
      const abs = Math.abs(diff);
      const min = Math.round(abs / 60000);
      const rel = diff >= 0 ? ago => ago + ' ago' : ago => 'in ' + ago;
      if (min < 1) return 'just now';
      if (min < 60) return rel(min + 'm');
      const hr = Math.round(min / 60);
      if (hr < 24) return rel(hr + 'h');
      return rel(Math.round(hr / 24) + 'd');
    }
    return d.toLocaleString();
  } catch (_) { return String(s); }
}
function toast(msg, type = 'ok') {
  const t = h('div', { class: `toast toast-${type}` }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
function confirmDialog(msg) {
  return new Promise(resolve => {
    const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) { modal.remove(); resolve(false); } } },
      h('div', { class: 'modal modal-sm' },
        h('p', {}, msg),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => { modal.remove(); resolve(false); } }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => { modal.remove(); resolve(true); } }, 'OK')
        )
      )
    );
    document.body.appendChild(modal);
  });
}

function logout() {
  localStorage.removeItem('crm_token');
  CRM.token = null; CRM.user = null;
  location.hash = '';
  location.reload();
}

/* ---------------- Login ---------------- */
function renderLogin() {
  const app = $('#app');
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand">
          ${CRM.config.company_logo_url ? `<img src="${esc(CRM.config.company_logo_url)}" class="login-logo" alt="" />` : '<div class="login-logo-dot">🎯</div>'}
          <h1>${esc(CRM.config.company_name || 'Lead CRM')}</h1>
          <p class="muted">Sign in to continue</p>
        </div>
        <form id="login-form">
          <label>Email</label>
          <input type="email" name="email" autocomplete="username" required autofocus />
          <label>Password</label>
          <input type="password" name="password" autocomplete="current-password" required />
          <button type="submit" class="btn primary block">Sign in</button>
          <p id="login-err" class="error"></p>
        </form>
      </div>
    </div>`;
  $('#login-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    $('#login-err').textContent = '';
    try {
      const r = await apiRaw('api_login', f.email.value, f.password.value);
      CRM.token = r.token; CRM.user = r.user;
      localStorage.setItem('crm_token', r.token);
      location.reload();
    } catch (e) { $('#login-err').textContent = e.message; }
  });
}

/* ---------------- Shell ---------------- */
const NAV = [
  { id: 'dashboard',  label: 'Dashboard',    icon: '📊' },
  { id: 'leads',      label: 'Leads',        icon: '🎯' },
  { id: 'pipeline',   label: 'Pipeline',     icon: '📈' },
  { id: 'kanban',     label: 'Kanban',       icon: '🗂️' },
  { id: 'followups',  label: 'Follow-ups',   icon: '🔔' },
  { id: 'reports',    label: 'Reports',      icon: '📉', roles: ['admin', 'manager', 'team_leader'] },
  { id: 'tasks',      label: 'Tasks',        icon: '✅' },
  { id: 'attendance', label: 'Attendance',   icon: '🕒' },
  { id: 'leaves',     label: 'Leaves',       icon: '🏖️' },
  { id: 'salary',     label: 'Salary',       icon: '💰' },
  { id: 'bank',       label: 'Bank',         icon: '🏦' },
  { id: 'users',      label: 'Users',        icon: '👥', roles: ['admin', 'manager'] },
  { id: 'admin',      label: 'Settings',     icon: '⚙️', roles: ['admin'] }
];

function renderShell() {
  const initials = (CRM.user.name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          ${CRM.config.company_logo_url ? `<img src="${esc(CRM.config.company_logo_url)}" class="sidebar-logo" alt="" />` : '<span class="brand-dot">🎯</span>'}
          <span class="brand-name">${esc(CRM.config.company_name)}</span>
        </div>
        <nav id="nav"></nav>
        <div class="sidebar-footer">
          <div class="me">
            <span class="avatar">${esc(initials)}</span>
            <div class="me-meta">
              <div class="name">${esc(CRM.user.name)}</div>
              <div class="role">${esc(CRM.user.role)}</div>
            </div>
          </div>
          <button class="btn ghost block" id="btn-logout">Logout</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <h2 id="page-title">Dashboard</h2>
          <div class="topbar-right">
            <button class="btn ghost" id="btn-notif" title="Notifications">🔔<span class="badge" id="notif-count" hidden>0</span></button>
          </div>
        </header>
        <section id="view"></section>
      </main>
    </div>`;
  const nav = $('#nav');
  NAV.forEach(item => {
    if (item.roles && !item.roles.includes(CRM.user.role)) return;
    const a = h('a', { href: '#/' + item.id, 'data-view': item.id }, h('span', { class: 'nav-icon' }, item.icon), h('span', {}, item.label));
    nav.appendChild(a);
  });
  $('#btn-logout').onclick = logout;
  $('#btn-notif').onclick = showNotifs;
}

function navigateTo(id) {
  const item = NAV.find(n => n.id === id) || NAV[0];
  $$('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.view === item.id));
  $('#page-title').textContent = item.label;
  const view = $('#view');
  view.innerHTML = '<div class="loading">Loading…</div>';
  if (parseHashView() !== item.id) location.hash = '#/' + item.id;
  const fn = VIEWS[item.id];
  Promise.resolve(fn ? fn(view) : null).catch(e => {
    view.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  });
}

const VIEWS = {};

/* ---------------- Dashboard ---------------- */
VIEWS.dashboard = async (view) => {
  await ensureChartJs();
  const [summary, due] = await Promise.all([
    api('api_reports_summary', {}),
    api('api_notifications_mine')
  ]);
  view.innerHTML = '';

  // 4 clean KPI cards
  view.append(
    h('div', { class: 'cards' },
      card('Total Leads',  summary.totals.total,      'accent', '🎯'),
      card('Won',          summary.totals.won,        'ok',     '🏆'),
      card('Due today',    due.counts.due_today,      'warn',   '📅'),
      card('Overdue',      due.counts.overdue,        'err',    '⚠️')
    )
  );

  // Two-column: upcoming follow-ups + pie chart
  const grid = h('div', { class: 'dash-grid' });
  view.appendChild(grid);

  // Upcoming follow-ups card
  const allDue = [...(due.overdue || []), ...(due.due_today || []), ...(due.upcoming || [])].slice(0, 8);
  const fuCard = h('div', { class: 'card' },
    h('h3', {}, '⏰ Upcoming follow-ups'),
    allDue.length === 0
      ? h('p', { class: 'muted' }, 'No follow-ups scheduled.')
      : h('ul', { class: 'fu-dash-list' }, ...allDue.map(f => h('li', {},
          h('div', { class: 'fu-name', onclick: () => openLeadModal(f.lead_id) }, f.lead_name || '—'),
          h('div', { class: 'fu-phone muted' }, f.lead_phone || ''),
          h('div', { class: 'fu-due ' + (new Date(f.due_at) < new Date() ? 'overdue' : '') }, fmtDate(f.due_at, 'relative'))
        )))
  );
  grid.appendChild(fuCard);

  // Pie chart — leads by status
  const pieCard = h('div', { class: 'card' },
    h('h3', {}, '🎯 Leads by status'),
    h('div', { class: 'chart-wrap' }, h('canvas', { id: 'dash-pie' }))
  );
  grid.appendChild(pieCard);

  // By source bar chart
  const srcCard = h('div', { class: 'card card-wide' },
    h('h3', {}, 'Leads by source'),
    h('div', { class: 'chart-wrap' }, h('canvas', { id: 'dash-src' }))
  );
  grid.appendChild(srcCard);

  setTimeout(() => {
    const statusData = (summary.by_status || []).filter(x => x.c > 0);
    makeChart('dash-pie', 'pie', statusData.map(x => x.status), statusData.map(x => x.c), statusData.map(x => x.color));
    const srcData = summary.by_source || [];
    makeChart('dash-src', 'bar', srcData.map(x => x.source), srcData.map(x => x.c));
  }, 50);

  function card(label, val, klass, icon) {
    return h('div', { class: `card stat ${klass}` },
      h('div', { class: 'stat-icon' }, icon || ''),
      h('div', { class: 'stat-body' },
        h('div', { class: 'stat-label' }, label),
        h('div', { class: 'stat-value' }, val ?? 0)
      )
    );
  }
};

/* ---------------- Leads ---------------- */
const LEAD_COLUMNS = [
  { key: 'name',        label: 'Name',          default: true },
  { key: 'phone',       label: 'Phone',         default: true },
  { key: 'email',       label: 'Email',         default: false },
  { key: 'whatsapp',    label: 'WhatsApp',      default: false },
  { key: 'source',      label: 'Source',        default: true },
  { key: 'product',     label: 'Product',       default: false },
  { key: 'status',      label: 'Status',        default: true },
  { key: 'assigned',    label: 'Assigned',      default: true },
  { key: 'tags',        label: 'Tags',          default: false },
  { key: 'followup',    label: 'Follow-up',     default: true },
  { key: 'last_change', label: 'Last change',   default: true },
  { key: 'remark',      label: 'Recent remark', default: true },
  { key: 'city',        label: 'City',          default: false },
  { key: 'created',     label: 'Created',       default: true }
];

VIEWS.leads = async (view) => {
  if (!CRM.cache.statuses) await warmCache();
  const { statuses, sources, users } = CRM.cache;

  view.innerHTML = '';

  if (CRM.prefs.showHeader !== false) {
    const header = h('div', { class: 'leads-header' },
      h('div', { class: 'leads-status-chips', id: 'status-chips' }),
      h('div', { class: 'header-actions' },
        h('button', { class: 'btn sm ghost', title: 'Hide header', onclick: () => toggleHeader(false) }, '− Hide')
      )
    );
    view.appendChild(header);
  } else {
    view.appendChild(h('div', { class: 'header-hidden-toggle' },
      h('button', { class: 'btn sm ghost', onclick: () => toggleHeader(true) }, '▾ Show header')
    ));
  }

  const toolbar = h('div', { class: 'toolbar' },
    h('input', { id: 'f-q', placeholder: 'Search name / phone / email…', class: 'flex', value: CRM.prefs.filters.q || '',
      onkeydown: ev => { if (ev.key === 'Enter') loadLeads(); } }),
    selectOpts('f-status', [{ id: '', name: 'Any status' }, ...statuses], CRM.prefs.filters.status_id),
    selectOpts('f-source', [{ id: '', name: 'Any source' }, ...sources.map(s => ({ id: s.name, name: s.name }))], CRM.prefs.filters.source),
    selectOpts('f-assigned', [{ id: '', name: 'Any assignee' }, ...users], CRM.prefs.filters.assigned_to),
    selectOpts('f-followup', [{ id: '', name: 'All follow-ups' }, { id: 'today', name: 'Due today' }, { id: 'overdue', name: 'Overdue' }], CRM.prefs.filters.followup),
    h('button', { class: 'btn', onclick: loadLeads }, '🔎'),
    h('button', { class: 'btn ghost', onclick: clearFilters, title: 'Reset' }, '✕'),
    h('button', { class: 'btn ghost', onclick: openColumnChooser, title: 'Columns' }, '☰'),
    h('button', { class: 'btn ghost', onclick: openBulkUpload, title: 'Upload CSV' }, '⬆️'),
    h('button', { class: 'btn ghost', onclick: exportCSV, title: 'Export CSV' }, '⬇️'),
    h('button', { class: 'btn primary', onclick: () => openLeadModal() }, '+ New Lead')
  );
  view.appendChild(toolbar);

  view.appendChild(h('div', { class: 'bulk-bar', id: 'bulk-bar', hidden: true },
    h('span', { id: 'bulk-count', class: 'bulk-count' }, '0 selected'),
    h('button', { class: 'btn sm', onclick: bulkAssignPrompt }, '👤 Assign'),
    h('button', { class: 'btn sm', onclick: bulkStatusPrompt }, '🏷️ Status'),
    h('button', { class: 'btn sm', onclick: bulkAddTagPrompt }, '🏁 Add tag'),
    h('button', { class: 'btn sm danger', onclick: bulkDelete }, '🗑️ Delete'),
    h('button', { class: 'btn sm ghost', onclick: () => clearSelection() }, 'Clear')
  ));

  view.appendChild(h('div', { class: 'table-wrap' }, h('table', { id: 'leads-table', class: 'leads-table' })));

  await loadLeads();
};

function toggleHeader(show) {
  CRM.prefs.showHeader = show;
  localStorage.setItem('crm_show_header', show ? '1' : '0');
  navigateTo('leads');
}
function clearFilters() {
  CRM.prefs.filters = {};
  localStorage.setItem('crm_filters', '{}');
  navigateTo('leads');
}

async function loadLeads() {
  const filters = {
    q:           $('#f-q')?.value || undefined,
    status_id:   $('#f-status')?.value || undefined,
    source:      $('#f-source')?.value || undefined,
    assigned_to: $('#f-assigned')?.value || undefined,
    followup:    $('#f-followup')?.value || undefined
  };
  CRM.prefs.filters = filters;
  localStorage.setItem('crm_filters', JSON.stringify(filters));

  try {
    const res = await api('api_leads_list', filters);
    CRM.cache.lastLeads = res.leads;
    CRM.cache.lastStatusCounts = res.status_count;
    renderLeadsTable(res.leads);
    renderStatusChips(res.status_count);
  } catch (e) {
    $('#leads-table').innerHTML = `<tbody><tr><td colspan="99" class="error-box">${esc(e.message)}</td></tr></tbody>`;
  }
}

function renderStatusChips(statusCount) {
  const el = $('#status-chips');
  if (!el) return;
  const { statuses } = CRM.cache;
  el.innerHTML = '';
  statuses.forEach(s => {
    const c = statusCount?.[String(s.id)] || statusCount?.[s.id] || 0;
    el.appendChild(h('span', { class: 'status-chip' },
      h('span', { class: 'chip-dot', style: { background: s.color } }),
      h('span', { class: 'chip-label' }, s.name),
      h('span', { class: 'chip-count' }, c)
    ));
  });
}

function getActiveColumns() {
  const saved = CRM.prefs.columns && CRM.prefs.columns.length ? CRM.prefs.columns : null;
  return saved || LEAD_COLUMNS.filter(c => c.default).map(c => c.key);
}

function renderLeadsTable(rows) {
  const tbl = $('#leads-table');
  if (!tbl) return;
  const { statuses, customFields } = CRM.cache;
  const activeCols = getActiveColumns();
  const extraCols = (customFields || []).filter(f => f.show_in_list);

  const thead = h('thead', {},
    h('tr', {},
      h('th', { class: 'th-check' }, h('input', { type: 'checkbox', id: 'sel-all', onclick: ev => selectAll(ev.target.checked) })),
      ...activeCols.map(key => h('th', {}, (LEAD_COLUMNS.find(c => c.key === key) || {}).label || key)),
      ...extraCols.map(f => h('th', {}, f.label)),
      h('th', {})
    )
  );
  const tbody = h('tbody', {});
  if (!rows.length) {
    tbody.appendChild(h('tr', {}, h('td', { colspan: activeCols.length + extraCols.length + 2, class: 'empty' }, 'No leads match your filters.')));
  } else {
    rows.forEach(l => tbody.appendChild(h('tr', { class: l.is_duplicate ? 'row-duplicate' : '' },
      h('td', { class: 'td-check' }, h('input', { type: 'checkbox', class: 'row-check', 'data-id': l.id, onclick: onRowCheck })),
      ...activeCols.map(col => renderCell(col, l, statuses)),
      ...extraCols.map(f => h('td', {}, (l.extra && l.extra[f.key]) || '')),
      h('td', { class: 'td-actions' },
        h('button', { class: 'btn sm ghost', onclick: () => openLeadModal(l.id) }, '✎')
      )
    )));
  }
  tbl.innerHTML = '';
  tbl.append(thead, tbody);

  $$('select[data-lead-status]', tbl).forEach(sel =>
    sel.addEventListener('change', async () => {
      try {
        await api('api_leads_update', Number(sel.dataset.leadStatus), { status_id: Number(sel.value) });
        toast('Status updated');
        const opt = CRM.cache.statuses.find(s => Number(s.id) === Number(sel.value));
        if (opt) sel.style.background = opt.color;
        loadLeads();
      } catch (e) { toast(e.message, 'err'); }
    })
  );
}

function renderCell(col, l, statuses) {
  switch (col) {
    case 'name': {
      return h('td', { class: 'cell-name' },
        h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(l.id); } }, l.name || '—'),
        l.is_duplicate ? h('span', { class: 'dup-pill', title: 'Duplicate — click to see past leads', onclick: ev => { ev.stopPropagation(); ev.preventDefault(); openDuplicateHistory(l.id); } }, 'DUP') : null
      );
    }
    case 'phone': {
      const digits = String(l.phone || '').replace(/\D/g, '');
      return h('td', { class: 'cell-phone' },
        l.phone || '',
        l.phone ? h('button', { class: 'btn icon', title: 'Copy', onclick: ev => { ev.stopPropagation(); navigator.clipboard.writeText(l.phone); toast('Copied'); } }, '📋') : null,
        digits ? h('a', { class: 'btn icon', href: `https://wa.me/${digits}`, target: '_blank', title: 'WhatsApp', onclick: ev => ev.stopPropagation() }, '💬') : null
      );
    }
    case 'email':    return h('td', {}, l.email || '');
    case 'whatsapp': return h('td', {}, l.whatsapp || '');
    case 'source':   return h('td', {}, l.source || '');
    case 'product':  return h('td', {}, l.product_name || l.product || '');
    case 'status': {
      const sel = h('select', {
        class: 'status-pill',
        'data-lead-status': l.id,
        style: { background: l.status_color || '#6b7280' },
        onclick: ev => ev.stopPropagation()
      });
      statuses.forEach(s => sel.appendChild(h('option', {
        value: s.id, selected: Number(s.id) === Number(l.status_id) ? 'selected' : null
      }, s.name)));
      return h('td', {}, sel);
    }
    case 'assigned': return h('td', {}, l.assigned_name || '—');
    case 'tags': {
      const tags = String(l.tags || '').split(',').map(s => s.trim()).filter(Boolean);
      return h('td', {}, ...tags.map(t => h('span', { class: 'tag' }, t)));
    }
    case 'followup': {
      const due = l.next_followup_at ? new Date(l.next_followup_at) : null;
      const overdue = due && due < new Date();
      return h('td', { class: overdue ? 'overdue' : '' }, due ? fmtDate(l.next_followup_at, 'relative') : '');
    }
    case 'last_change': return h('td', { class: 'muted' }, l.last_status_change_at ? fmtDate(l.last_status_change_at, 'relative') : '');
    case 'remark': return h('td', { class: 'cell-remark' },
      h('span', { class: 'remark-text', title: l.recent_remark || '' }, (l.recent_remark || '').slice(0, 60)),
      h('button', { class: 'btn icon', title: 'Add remark', onclick: ev => { ev.stopPropagation(); openRemarkInline(l.id); } }, '💬+')
    );
    case 'city':    return h('td', {}, l.city || '');
    case 'created': return h('td', { class: 'muted' }, fmtDate(l.created_at, 'short'));
    default:        return h('td', {}, '');
  }
}

/* --- selection & bulk --- */
function onRowCheck() {
  const n = $$('.row-check:checked').length;
  const bar = $('#bulk-bar');
  if (!bar) return;
  bar.hidden = n === 0;
  $('#bulk-count').textContent = `${n} selected`;
}
function selectAll(on) {
  $$('.row-check').forEach(c => { c.checked = on; });
  onRowCheck();
}
function clearSelection() {
  const sa = $('#sel-all'); if (sa) sa.checked = false;
  selectAll(false);
}
function selectedIds() {
  return $$('.row-check:checked').map(c => Number(c.dataset.id));
}

async function bulkAssignPrompt() {
  const ids = selectedIds(); if (!ids.length) return;
  const users = CRM.cache.users || [];
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, `Assign ${ids.length} leads`),
    h('label', {}, 'Pick user'),
    h('select', { id: 'bulk-asgn' }, ...users.map(u => h('option', { value: u.id }, `${u.name} — ${u.role}`))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('api_leads_bulkUpdate', ids, { assigned_to: Number($('#bulk-asgn').value) }); toast('Assigned'); modal.remove(); clearSelection(); loadLeads(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Assign')
    )
  ));
  document.body.appendChild(modal);
}
async function bulkStatusPrompt() {
  const ids = selectedIds(); if (!ids.length) return;
  const statuses = CRM.cache.statuses;
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, `Change status of ${ids.length} leads`),
    h('label', {}, 'New status'),
    h('select', { id: 'bulk-st' }, ...statuses.map(s => h('option', { value: s.id }, s.name))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('api_leads_bulkUpdate', ids, { status_id: Number($('#bulk-st').value) }); toast('Updated'); modal.remove(); clearSelection(); loadLeads(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Update')
    )
  ));
  document.body.appendChild(modal);
}
async function bulkAddTagPrompt() {
  const ids = selectedIds(); if (!ids.length) return;
  const tag = prompt('Tag to add to ' + ids.length + ' leads:');
  if (!tag) return;
  const leads = (CRM.cache.lastLeads || []).filter(l => ids.includes(Number(l.id)));
  for (const l of leads) {
    const existing = String(l.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!existing.includes(tag)) existing.push(tag);
    try { await api('api_leads_update', l.id, { tags: existing.join(', ') }); } catch (_) {}
  }
  toast('Tag added'); clearSelection(); loadLeads();
}
async function bulkDelete() {
  const ids = selectedIds(); if (!ids.length) return;
  if (!await confirmDialog(`Delete ${ids.length} leads? This cannot be undone.`)) return;
  try { await api('api_leads_bulkDelete', ids); toast('Deleted'); clearSelection(); loadLeads(); }
  catch (e) { toast(e.message, 'err'); }
}

/* --- CSV export / upload --- */
function exportCSV() {
  const rows = CRM.cache.lastLeads || [];
  if (!rows.length) return toast('No leads to export', 'warn');
  const headers = ['id', 'name', 'phone', 'email', 'whatsapp', 'source', 'product_name', 'status_name', 'assigned_name', 'tags', 'city', 'next_followup_at', 'last_status_change_at', 'notes', 'created_at'];
  const csv = [headers.join(',')].concat(rows.map(r => headers.map(k => {
    const v = r[k] == null ? '' : String(r[k]).replace(/"/g, '""');
    return /[",\n]/.test(v) ? `"${v}"` : v;
  }).join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function openBulkUpload() {
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, 'Bulk upload leads'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('p', { class: 'muted' }, 'CSV format — first row = headers. Columns supported: name, phone, email, whatsapp, source, product, notes, city, tags, next_followup_at, plus any custom field keys.'),
      h('input', { type: 'file', accept: '.csv,text/csv', id: 'csv-file' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const f = $('#csv-file').files[0];
          if (!f) return toast('Choose a file', 'warn');
          try {
            const text = await f.text();
            const rows = parseCSV(text);
            const r = await api('api_leads_bulkCreate', rows);
            toast(`Imported ${r.inserted || rows.length} leads`);
            modal.remove(); loadLeads();
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Import')
      )
    )
  );
  document.body.appendChild(modal);
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const o = {};
    headers.forEach((h, i) => { o[h] = (vals[i] || '').trim(); });
    return o;
  });
}
function splitCSVLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur);
  return out;
}

/* --- Column chooser --- */
function openColumnChooser() {
  const active = new Set(getActiveColumns());
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, 'Columns'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('p', { class: 'muted' }, 'Pick which columns to show. Saved as your default view.'),
      h('div', { class: 'col-picker' },
        ...LEAD_COLUMNS.map(c => h('label', { class: 'col-opt' },
          h('input', { type: 'checkbox', value: c.key, checked: active.has(c.key) ? 'checked' : null }),
          h('span', {}, c.label)
        ))
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          const keys = $$('.col-picker input:checked', modal).map(i => i.value);
          CRM.prefs.columns = keys;
          localStorage.setItem('crm_cols', JSON.stringify(keys));
          modal.remove();
          loadLeads();
        } }, 'Save default view')
      )
    )
  );
  document.body.appendChild(modal);
}

/* --- Lead modal --- */
async function openLeadModal(id) {
  const { statuses, sources, products, users, customFields } = CRM.cache;
  let lead = { name: '', phone: '', email: '', whatsapp: '', source: '', status_id: statuses[0]?.id, assigned_to: CRM.user.id, notes: '', tags: '', next_followup_at: '' };
  let remarks = [];
  if (id) {
    const r = await api('api_leads_get', id);
    lead = Object.assign(lead, r.lead || r);
    remarks = r.remarks || [];
  }
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  modal.appendChild(body);
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, id ? 'Edit Lead' : 'New Lead'),
    lead.is_duplicate ? h('span', { class: 'dup-pill', onclick: () => openDuplicateHistory(id) }, 'DUPLICATE of #' + (lead.duplicate_of || '?')) : null,
    h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
  ));
  const form = h('form', { id: 'lead-form', class: 'form-grid' });
  form.append(
    field('name', 'Name *', lead.name, { required: true }),
    field('phone', 'Phone', lead.phone),
    field('whatsapp', 'WhatsApp', lead.whatsapp || lead.phone),
    field('email', 'Email', lead.email, { type: 'email' }),
    selectField('source', 'Source', lead.source, sources.map(s => s.name)),
    selectField('product_id', 'Product', lead.product_id, [{ value: '', label: '—' }, ...products.map(p => ({ value: p.id, label: p.name }))]),
    selectField('status_id', 'Status', lead.status_id, statuses.map(s => ({ value: s.id, label: s.name }))),
    selectField('assigned_to', 'Assigned To', lead.assigned_to, users.map(u => ({ value: u.id, label: u.name }))),
    field('tags', 'Tags (comma separated)', lead.tags),
    field('next_followup_at', 'Next follow-up', lead.next_followup_at ? String(lead.next_followup_at).slice(0, 16) : '', { type: 'datetime-local' }),
    field('city', 'City', lead.city),
    field('notes', 'Notes', lead.notes, { type: 'textarea', full: true })
  );

  (customFields || []).forEach(cf => {
    const extra = lead.extra || {};
    form.appendChild(customFieldInput(cf, extra[cf.key]));
  });

  body.appendChild(form);
  if (id) body.appendChild(remarksBlock(remarks, id));
  body.appendChild(h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
    h('button', { type: 'submit', form: 'lead-form', class: 'btn primary' }, id ? 'Save changes' : 'Create lead')
  ));
  document.body.appendChild(modal);

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const extra = {};
    (customFields || []).forEach(cf => {
      const key = 'cf_' + cf.key;
      if (cf.field_type === 'multiselect') extra[cf.key] = fd.getAll(key).join(',');
      else extra[cf.key] = fd.get(key) || '';
    });
    const payload = {
      name: fd.get('name'), phone: fd.get('phone'), email: fd.get('email'),
      whatsapp: fd.get('whatsapp'), source: fd.get('source'),
      product_id: Number(fd.get('product_id')) || null,
      status_id: Number(fd.get('status_id')) || null,
      assigned_to: Number(fd.get('assigned_to')) || null,
      tags: fd.get('tags'), next_followup_at: fd.get('next_followup_at') || null,
      city: fd.get('city'), notes: fd.get('notes'),
      extra
    };
    try {
      if (id) await api('api_leads_update', id, payload);
      else    await api('api_leads_create', payload);
      toast(id ? 'Saved' : 'Created');
      modal.remove();
      loadLeads();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function field(name, label, value, opts = {}) {
  const tag = opts.type === 'textarea' ? 'textarea' : 'input';
  const el = h(tag, Object.assign({ name, value: value ?? '' }, opts.type && opts.type !== 'textarea' ? { type: opts.type } : {}, opts.required ? { required: true } : {}));
  if (opts.type === 'textarea') el.textContent = value ?? '';
  return h('div', { class: opts.full ? 'f-row full' : 'f-row' }, h('label', {}, label), el);
}
function selectField(name, label, value, options, opts = {}) {
  const sel = h('select', { name },
    ...options.map(o => {
      const v = typeof o === 'object' ? o.value : o;
      const t = typeof o === 'object' ? o.label : o;
      return h('option', { value: v, selected: String(value) === String(v) ? 'selected' : null }, t);
    })
  );
  return h('div', { class: opts.full ? 'f-row full' : 'f-row' }, h('label', {}, label), sel);
}
function selectOpts(id, items, value) {
  return h('select', { id },
    ...items.map(i => h('option', { value: i.id, selected: String(value) === String(i.id) ? 'selected' : null }, i.name))
  );
}
function customFieldInput(cf, val) {
  const name = 'cf_' + cf.key;
  const opts = String(cf.options || '').split('|').filter(Boolean);
  let input;
  if (cf.field_type === 'textarea') input = h('textarea', { name }, val || '');
  else if (cf.field_type === 'select') input = h('select', { name },
    h('option', { value: '' }, '—'),
    ...opts.map(o => h('option', { value: o, selected: val === o ? 'selected' : null }, o)));
  else if (cf.field_type === 'multiselect') input = h('select', { name, multiple: true },
    ...opts.map(o => h('option', { value: o, selected: String(val || '').split(',').includes(o) ? 'selected' : null }, o)));
  else if (cf.field_type === 'checkbox') input = h('input', { type: 'checkbox', name, checked: val ? 'checked' : null, value: '1' });
  else input = h('input', { name, value: val || '', type: cf.field_type === 'number' ? 'number' : cf.field_type === 'date' ? 'date' : 'text' });
  return h('div', { class: 'f-row' }, h('label', {}, cf.label + (cf.is_required ? ' *' : '')), input);
}

function remarksBlock(rs, leadId) {
  const list = h('ul', { class: 'remarks-list' });
  (rs || []).forEach(r => list.appendChild(h('li', {},
    h('b', {}, r.user_name || '—'), ' · ', fmtDate(r.created_at, 'relative'),
    h('br'), r.remark || ''
  )));
  const textarea = h('textarea', { placeholder: 'Add a remark…', rows: 2 });
  const btn = h('button', { type: 'button', class: 'btn sm', onclick: async () => {
    if (!textarea.value.trim()) return;
    try {
      await api('api_leads_addRemark', leadId, { remark: textarea.value });
      const r = await api('api_leads_get', leadId);
      list.innerHTML = '';
      (r.remarks || []).forEach(x => list.appendChild(h('li', {},
        h('b', {}, x.user_name || '—'), ' · ', fmtDate(x.created_at, 'relative'), h('br'), x.remark || ''
      )));
      textarea.value = '';
      toast('Remark added');
    } catch (e) { toast(e.message, 'err'); }
  } }, 'Add remark');
  return h('div', { class: 'remarks-block' },
    h('h4', {}, 'Remarks'), list, textarea, btn
  );
}

async function openRemarkInline(leadId) {
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, 'Add remark'),
    h('textarea', { id: 'inline-rmk', rows: 3, placeholder: 'Write remark…' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const text = $('#inline-rmk').value.trim();
        if (!text) return;
        try { await api('api_leads_addRemark', leadId, { remark: text }); toast('Added'); modal.remove(); loadLeads(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Save')
    )
  ));
  document.body.appendChild(modal);
  setTimeout(() => $('#inline-rmk').focus(), 50);
}

async function openDuplicateHistory(leadId) {
  try {
    const history = await api('api_leads_duplicateHistory', leadId);
    const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } },
      h('div', { class: 'modal modal-lg' },
        h('div', { class: 'modal-head' }, h('h3', {}, 'Duplicate history'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
        (!history || history.length === 0)
          ? h('p', { class: 'muted' }, 'No matching past leads found.')
          : h('div', {},
              ...history.map(l => h('div', { class: 'dup-item' },
                h('div', {}, h('b', {}, l.name || '—'), ' · ', l.phone || l.email || '', ' · ', fmtDate(l.created_at, 'relative')),
                h('div', { class: 'muted' }, 'Status: ' + (l.status_name || '—') + ' · Assigned: ' + (l.assigned_name || '—')),
                ...(l.remarks || []).map(r => h('div', { class: 'dup-remark' }, '💬 ', r.remark, ' — ', fmtDate(r.created_at, 'short')))
              ))
            )
      )
    );
    document.body.appendChild(modal);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- Pipeline ---------------- */
VIEWS.pipeline = async (view) => {
  const [funnel, summary] = await Promise.all([
    api('api_reports_funnel', {}),
    api('api_reports_summary', {})
  ]);
  const total = summary.totals.total || 1;
  view.innerHTML = '';
  view.append(
    h('div', { class: 'card' },
      h('h3', {}, 'Sales funnel'),
      h('div', { class: 'funnel' },
        ...funnel.map((s, i) => {
          const pct = Math.round((s.count / total) * 100);
          const width = Math.max(20, pct);
          const prev = i > 0 ? funnel[i - 1].count : total;
          const conv = prev > 0 ? Math.round((s.count / prev) * 100) : 0;
          return h('div', { class: 'funnel-row' },
            h('div', { class: 'funnel-label' }, s.name),
            h('div', { class: 'funnel-bar-wrap' },
              h('div', { class: 'funnel-bar', style: { width: width + '%', background: s.color } },
                h('span', { class: 'funnel-count' }, s.count),
                h('span', { class: 'funnel-pct' }, pct + '%')
              )
            ),
            h('div', { class: 'funnel-conv' }, i === 0 ? '—' : conv + '% conv')
          );
        })
      )
    )
  );
};

/* ---------------- Kanban ---------------- */
VIEWS.kanban = async (view) => {
  if (!CRM.cache.statuses) await warmCache();
  const statuses = CRM.cache.statuses;
  const kanban = await api('api_leads_pipeline');
  view.innerHTML = '';
  const wrap = h('div', { class: 'kanban' });
  statuses.forEach(s => {
    const col = h('div', { class: 'kanban-col', 'data-status': s.id,
      ondragover: ev => { ev.preventDefault(); col.classList.add('drop-hover'); },
      ondragleave: () => col.classList.remove('drop-hover'),
      ondrop: async ev => {
        ev.preventDefault();
        col.classList.remove('drop-hover');
        const leadId = Number(ev.dataTransfer.getData('text/plain'));
        if (!leadId) return;
        try { await api('api_leads_update', leadId, { status_id: Number(s.id) }); toast('Moved'); navigateTo('kanban'); }
        catch (e) { toast(e.message, 'err'); }
      }
    });
    col.appendChild(h('h4', { class: 'kanban-head', style: { borderTopColor: s.color } },
      h('span', {}, s.name),
      h('span', { class: 'kanban-count' }, (kanban.find(k => Number(k.id) === Number(s.id))?.leads || []).length)
    ));
    (kanban.find(k => Number(k.id) === Number(s.id))?.leads || []).forEach(l => {
      col.appendChild(h('div', {
        class: 'kanban-card', draggable: true,
        ondragstart: ev => ev.dataTransfer.setData('text/plain', String(l.id)),
        onclick: () => openLeadModal(l.id)
      },
        h('div', { class: 'kc-name' }, l.name || '—'),
        h('div', { class: 'kc-meta' }, (l.phone || ''), l.source ? ' · ' + l.source : ''),
        l.next_followup_at ? h('div', { class: 'kc-fu' }, '⏰ ' + fmtDate(l.next_followup_at, 'relative')) : null
      ));
    });
    wrap.appendChild(col);
  });
  view.appendChild(wrap);
};

/* ---------------- Follow-ups ---------------- */
VIEWS.followups = async (view) => {
  const data = await api('api_notifications_mine');
  view.innerHTML = '';
  const section = (title, rows, klass) => {
    const wrap = h('div', { class: 'card' },
      h('h3', {}, title, ' ', h('span', { class: 'chip-count ' + (klass || '') }, rows.length))
    );
    if (!rows.length) { wrap.appendChild(h('p', { class: 'muted' }, 'Nothing here.')); view.appendChild(wrap); return; }
    const tbl = h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Lead'), h('th', {}, 'Phone'), h('th', {}, 'Due'), h('th', {}, 'Note'), h('th', {}))),
      h('tbody', {}, ...rows.map(r => h('tr', {},
        h('td', {}, r.lead_name || ''),
        h('td', {}, r.lead_phone || ''),
        h('td', { class: klass === 'err' ? 'overdue' : '' }, fmtDate(r.due_at)),
        h('td', {}, r.note || ''),
        h('td', {}, h('button', { class: 'btn sm', onclick: async () => { await api('api_followup_done', r.id); toast('Done'); navigateTo('followups'); } }, '✓ Done'))
      )))
    ));
    wrap.appendChild(tbl);
    view.appendChild(wrap);
  };
  section('⚠️ Overdue', data.overdue, 'err');
  section('📅 Due today', data.due_today, 'warn');
  section('⏰ Upcoming', data.upcoming);
};

/* ---------------- Reports with charts ---------------- */
async function ensureChartJs() {
  if (window.Chart) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
VIEWS.reports = async (view) => {
  await ensureChartJs();
  view.innerHTML = '';
  const { users = [], products = [], sources = [] } = CRM.cache;
  const filterBar = h('div', { class: 'toolbar' },
    h('input', { type: 'date', id: 'rep-from' }),
    h('span', {}, 'to'),
    h('input', { type: 'date', id: 'rep-to' }),
    selectOpts('rep-user', [{ id: '', name: 'All users' }, ...users]),
    h('select', { id: 'rep-role' },
      h('option', { value: '' }, 'Any role'),
      h('option', { value: 'admin' }, 'Admin'),
      h('option', { value: 'manager' }, 'Manager'),
      h('option', { value: 'team_leader' }, 'Team leader'),
      h('option', { value: 'sales' }, 'Tele-caller / Sales')
    ),
    h('select', { id: 'rep-product' },
      h('option', { value: '' }, 'Any product'),
      ...products.map(p => h('option', { value: p.id }, p.name))
    ),
    selectOpts('rep-source', [{ id: '', name: 'Any source' }, ...sources.map(s => ({ id: s.name, name: s.name }))]),
    h('input', { id: 'rep-tag', placeholder: 'Tag (e.g. vip)', style: { maxWidth: '130px' } }),
    h('button', { class: 'btn primary', onclick: loadReports }, '🔎 Apply')
  );
  view.appendChild(filterBar);
  view.appendChild(h('div', { id: 'rep-cards', class: 'cards' }));
  view.appendChild(h('div', { class: 'chart-grid' },
    h('div', { class: 'card' }, h('h3', {}, 'By status'), h('div', { class: 'chart-wrap' }, h('canvas', { id: 'chart-status' }))),
    h('div', { class: 'card' }, h('h3', {}, 'By source'), h('div', { class: 'chart-wrap' }, h('canvas', { id: 'chart-source' }))),
    h('div', { class: 'card card-wide' }, h('h3', {}, 'Lead funnel'), h('div', { class: 'chart-wrap' }, h('canvas', { id: 'chart-funnel' }))),
    h('div', { class: 'card card-wide' }, h('h3', {}, 'By user'), h('div', { id: 'rep-by-user' }))
  ));
  await loadReports();
};

async function loadReports() {
  const from = $('#rep-from')?.value || undefined;
  const to   = $('#rep-to')?.value || undefined;
  const user = $('#rep-user')?.value || undefined;
  const role = $('#rep-role')?.value || undefined;
  const product_id = $('#rep-product')?.value || undefined;
  const source = $('#rep-source')?.value || undefined;
  const tag = $('#rep-tag')?.value || undefined;
  const summary = await api('api_reports_summary', { from, to, scope_user_id: user, role, product_id, source, tag });
  const funnel  = await api('api_reports_funnel',  { from, to });

  $('#rep-cards').innerHTML = '';
  [['Total', summary.totals.total, 'accent'], ['New', summary.totals.new_leads, ''], ['Won', summary.totals.won, 'ok'], ['Lost', summary.totals.lost, 'err']].forEach(([label, val, klass]) => {
    $('#rep-cards').appendChild(h('div', { class: `card stat ${klass}` },
      h('div', { class: 'stat-body' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, val || 0))
    ));
  });

  makeChart('chart-status', 'doughnut',
    (summary.by_status || []).map(x => x.status),
    (summary.by_status || []).map(x => x.c),
    (summary.by_status || []).map(x => x.color));
  makeChart('chart-source', 'bar',
    (summary.by_source || []).map(x => x.source),
    (summary.by_source || []).map(x => x.c));
  makeChart('chart-funnel', 'bar',
    funnel.map(f => f.name), funnel.map(f => f.count),
    funnel.map(f => f.color), { indexAxis: 'y' });

  const byUserEl = $('#rep-by-user');
  byUserEl.innerHTML = '';
  if (!summary.by_user.length) { byUserEl.innerHTML = '<p class="muted">No user activity in this period.</p>'; return; }
  byUserEl.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Role'), h('th', {}, 'Total'), h('th', {}, 'New'), h('th', {}, 'Open'), h('th', {}, 'Won'), h('th', {}, 'Lost'))),
    h('tbody', {}, ...summary.by_user.map(u => h('tr', {},
      h('td', {}, u.name), h('td', {}, u.role),
      h('td', {}, u.total), h('td', {}, u.new_leads), h('td', {}, u.open_leads),
      h('td', { class: 'cell-ok' }, u.won), h('td', { class: 'cell-err' }, u.lost)
    )))
  )));
}

function makeChart(canvasId, type, labels, data, colors, extra) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (ctx._chart) ctx._chart.destroy();
  const palette = colors && colors.some(Boolean) ? colors : ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'];
  ctx._chart = new Chart(ctx, {
    type, data: {
      labels, datasets: [{ data, backgroundColor: labels.map((_, i) => palette[i % palette.length]), borderWidth: 0 }]
    },
    options: Object.assign({
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: type === 'doughnut' ? 'bottom' : 'top' } },
      scales: type === 'doughnut' ? {} : { x: { grid: { display: false } }, y: { grid: { color: '#f3f4f6' }, beginAtZero: true } }
    }, extra || {})
  });
}

/* ---------------- Admin ---------------- */
VIEWS.admin = async (view) => {
  view.innerHTML = '';
  const tabs = [
    { id: 'company',      label: 'Company' },
    { id: 'api',          label: 'Website API' },
    { id: 'automations',  label: 'Automations' },
    { id: 'fb',           label: 'Facebook' },
    { id: 'whatsapp',     label: 'WhatsApp' },
    { id: 'sources',      label: 'Sources' },
    { id: 'statuses',     label: 'Statuses' },
    { id: 'customfields', label: 'Custom Fields' },
    { id: 'rules',        label: 'Auto-assign Rules' },
    { id: 'duplicates',   label: 'Duplicates' },
    { id: 'smtp',         label: 'SMTP' }
  ];
  const nav = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab', 'data-tab': t.id, onclick: () => showAdminTab(t.id) }, t.label))
  );
  view.appendChild(nav);
  view.appendChild(h('div', { id: 'admin-body' }));
  showAdminTab('company');
};

async function showAdminTab(id) {
  $$('.subtab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  const body = $('#admin-body');
  body.innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (id === 'company')     body.replaceChildren(await adminCompany());
    if (id === 'api')         body.replaceChildren(await adminApi());
    if (id === 'automations') body.replaceChildren(await adminAutomations());
    if (id === 'fb')          body.replaceChildren(await adminFb());
    if (id === 'whatsapp') body.replaceChildren(await adminWhatsapp());
    if (id === 'sources')  body.replaceChildren(await adminSources());
    if (id === 'statuses') body.replaceChildren(await adminStatuses());
    if (id === 'customfields') body.replaceChildren(await adminCustomFields());
    if (id === 'rules')    body.replaceChildren(await adminRules());
    if (id === 'duplicates') body.replaceChildren(await adminDuplicates());
    if (id === 'smtp')     body.replaceChildren(await adminSmtp());
  } catch (e) { body.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}

async function adminCompany() {
  const cfg = await api('api_admin_getConfig');
  return configForm(cfg, ['COMPANY_NAME', 'COMPANY_LOGO_URL']);
}

/* ---- Website API / sample CSV ---- */
async function adminApi() {
  const cfg = await api('api_admin_getConfig');
  const origin = location.origin;
  const apiKey = cfg.WEBSITE_API_KEY || '(not set — set below)';
  const curl = `curl -X POST '${origin}/hook/website' \\\n  -H 'x-api-key: ${apiKey}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name":"John Doe","phone":"+911234567890","email":"john@example.com","source":"Website","notes":"Demo request"}'`;
  const card = h('div', {});
  card.appendChild(h('div', { class: 'card' },
    h('h4', {}, '🌐 Website lead API'),
    h('p', { class: 'muted' }, 'Send leads from your website, landing page or any external system by POSTing to this endpoint. Leads go straight into the CRM and trigger your auto-assign rules + automations.'),
    h('div', { class: 'api-endpoint' },
      h('code', {}, origin + '/hook/website'),
      h('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(origin + '/hook/website'); toast('URL copied'); } }, 'Copy URL')
    ),
    h('h5', {}, 'API key'),
    h('div', { class: 'api-endpoint' },
      h('code', {}, apiKey),
      h('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(apiKey); toast('Key copied'); } }, 'Copy key')
    ),
    h('p', { class: 'muted' }, 'Keep this key secret. Change it any time in SMTP/Duplicates tab or here:'),
    configForm(cfg, ['WEBSITE_API_KEY']),
    h('h5', {}, 'Try it — cURL'),
    h('pre', { class: 'code-block' }, curl),
    h('h5', {}, 'Sample CSV for bulk upload'),
    h('p', { class: 'muted' }, 'Download the template, fill in your leads, then use Leads → ⬆️ Upload to import.'),
    h('a', { class: 'btn primary', href: '/api/sample.csv', download: 'lead-crm-sample.csv' }, '⬇️ Download sample CSV')
  ));
  return card;
}

/* ---- Automations ---- */
async function adminAutomations() {
  const [automations, log] = await Promise.all([
    api('api_automations_list'),
    api('api_automations_log', 20).catch(() => [])
  ]);
  const card = h('div', {});
  card.appendChild(h('div', { class: 'card' },
    h('h4', {}, '⚡ Automations'),
    h('p', { class: 'muted' }, 'Send emails or WhatsApp messages automatically when events happen (lead created, status changed, etc). Use {{lead.name}}, {{lead.phone}}, {{user.name}}, {{new_status.name}} in your templates.')
  ));
  const tblCard = h('div', { class: 'card' });
  tblCard.appendChild(h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Event'), h('th', {}, 'Channel'),
      h('th', {}, 'Recipient'), h('th', {}, 'Active'), h('th', {})
    )),
    h('tbody', {}, ...automations.map(a => h('tr', {},
      h('td', {}, a.name),
      h('td', {}, a.event),
      h('td', {}, a.channel),
      h('td', {}, a.recipient),
      h('td', {},
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: Number(a.is_active) ? 'checked' : null,
            onclick: async ev => { try { await api('api_automations_toggle', a.id, ev.target.checked); toast('Toggled'); } catch (e) { toast(e.message, 'err'); } } }),
          h('span', { class: 'slider' })
        )
      ),
      h('td', {},
        h('button', { class: 'btn sm', onclick: () => openAutomationModal(a) }, '✎'),
        h('button', { class: 'btn sm', onclick: async () => { try { const r = await api('api_automations_test', a.id); toast(r.note || 'Test fired'); setTimeout(() => showAdminTab('automations'), 2000); } catch (e) { toast(e.message, 'err'); } } }, '▶ Test'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog('Delete automation?')) return; await api('api_automations_delete', a.id); toast('Deleted'); showAdminTab('automations'); } }, '🗑')
      )
    )))
  ));
  tblCard.appendChild(h('div', { class: 'actions', style: { marginTop: '.75rem' } },
    h('button', { class: 'btn primary', onclick: () => openAutomationModal() }, '+ New automation')
  ));
  card.appendChild(tblCard);

  if (log && log.length) {
    const logCard = h('div', { class: 'card' }, h('h4', {}, '📋 Recent log'));
    logCard.appendChild(h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Automation'), h('th', {}, 'Event'), h('th', {}, 'Channel'), h('th', {}, 'Status'), h('th', {}, 'Detail'))),
      h('tbody', {}, ...log.map(r => h('tr', {},
        h('td', {}, fmtDate(r.created_at, 'relative')),
        h('td', {}, r.automation_name || '—'),
        h('td', {}, r.event),
        h('td', {}, r.channel),
        h('td', { class: r.status === 'sent' ? 'cell-ok' : r.status === 'failed' ? 'cell-err' : 'muted' }, r.status),
        h('td', {}, (r.detail || '').slice(0, 60))
      )))
    ));
    card.appendChild(logCard);
  }
  return card;
}

function openAutomationModal(existing) {
  const a = existing || { name: '', event: 'lead_created', channel: 'email', recipient: 'lead', condition: '', subject: '', template: '', is_active: 1 };
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, a.id ? 'Edit automation' : 'New automation'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('form', { id: 'auto-form', class: 'form-grid' },
        field('name', 'Name *', a.name, { required: true }),
        selectField('event', 'When (event) *', a.event, [
          { value: 'lead_created',   label: 'Lead created' },
          { value: 'status_changed', label: 'Status changed' },
          { value: 'lead_assigned',  label: 'Lead assigned' },
          { value: 'followup_due',   label: 'Follow-up due' }
        ]),
        selectField('channel', 'Channel *', a.channel, [
          { value: 'email',    label: 'Email (SMTP)' },
          { value: 'whatsapp', label: 'WhatsApp' },
          { value: 'webhook',  label: 'Webhook (POST URL)' }
        ]),
        selectField('recipient', 'Send to', a.recipient, [
          { value: 'lead',     label: 'The lead' },
          { value: 'assignee', label: 'Assigned user' },
          { value: 'admin',    label: 'Admin' }
        ]),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Condition (optional)'),
          h('input', { name: 'condition', value: a.condition || '', placeholder: 'e.g. status=Qualified   or   source=Website   or   tag:vip' })
        ),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Email subject (email only)'),
          h('input', { name: 'subject', value: a.subject || '', placeholder: 'New lead: {{lead.name}}' })
        ),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Template (supports {{lead.name}}, {{lead.phone}}, {{lead.status_name}}, {{user.name}}, {{new_status.name}}, {{date}})'),
          h('textarea', { name: 'template', rows: 5, placeholder: 'Hi {{lead.name}}, your status is now {{new_status.name}}. We\'ll get back to you shortly.' }, a.template || '')
        )
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const f = $('#auto-form');
          const payload = { id: a.id,
            name: f.name.value, event: f.event.value, channel: f.channel.value,
            recipient: f.recipient.value, condition: f.condition.value,
            subject: f.subject.value, template: f.template.value, is_active: 1 };
          try { await api('api_automations_save', payload); toast('Saved'); modal.remove(); showAdminTab('automations'); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(modal);
}
async function adminFb() {
  const [cfg, status] = await Promise.all([api('api_admin_getConfig'), api('api_fb_status').catch(() => ({ connected: false }))]);
  const card = h('div', {});
  card.appendChild(configForm(cfg, ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN']));
  card.appendChild(h('div', { class: 'card' },
    h('h4', {}, '🔗 Connection'),
    h('p', { class: 'muted' }, status.connected ? `Connected to page: ${status.page_name || status.page_id}` : 'Not connected.'),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: connectFacebook }, '🔗 Connect with Facebook'),
      status.connected ? h('button', { class: 'btn', onclick: async () => { await api('api_fb_disconnect'); toast('Disconnected'); showAdminTab('fb'); } }, 'Disconnect') : null,
      h('button', { class: 'btn ghost', onclick: async () => { const r = await api('api_admin_testMeta'); toast(r.ok ? 'Page: ' + r.page.name : (r.error || 'Failed'), r.ok ? 'ok' : 'err'); } }, 'Test'),
      h('button', { class: 'btn ghost', onclick: async () => { const r = await api('api_admin_subscribeMetaLeadgen'); toast(r.ok ? 'Subscribed' : r.error, r.ok ? 'ok' : 'err'); } }, 'Subscribe leadgen')
    ),
    h('p', { class: 'muted' }, 'Webhook URL to paste in Meta app → Webhooks: ',
      h('code', {}, location.origin + '/hook/meta'))
  ));
  return card;
}
async function adminWhatsapp() {
  const cfg = await api('api_admin_getConfig');
  const card = h('div', {});
  card.appendChild(configForm(cfg, ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN']));
  card.appendChild(h('div', { class: 'card' },
    h('h4', {}, 'Test'),
    h('button', { class: 'btn', onclick: async () => { const r = await api('api_admin_testWhatsApp'); toast(r.ok ? 'Verified: ' + r.phone.verified_name : (r.error || 'Failed'), r.ok ? 'ok' : 'err'); } }, 'Test WhatsApp'),
    h('p', { class: 'muted' }, 'Webhook URL: ', h('code', {}, location.origin + '/hook/whatsapp'))
  ));
  return card;
}
async function adminSources() {
  const sources = await api('api_sources_list');
  const card = h('div', { class: 'card' }, h('h4', {}, 'Lead sources'));
  card.appendChild(h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Active'), h('th', {}))),
    h('tbody', {}, ...sources.map(s => h('tr', {},
      h('td', {}, s.name),
      h('td', {}, Number(s.is_active) ? '✓' : '—'),
      h('td', {}, h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog(`Delete source "${s.name}"?`)) return; await api('api_sources_delete', s.id); toast('Deleted'); showAdminTab('sources'); } }, 'Delete'))
    )))
  ));
  card.appendChild(h('form', { class: 'inline-form', onsubmit: async ev => {
    ev.preventDefault();
    try { await api('api_sources_save', { name: ev.target.n.value }); toast('Added'); showAdminTab('sources'); }
    catch (e) { toast(e.message, 'err'); }
  }},
    h('input', { name: 'n', placeholder: 'New source name', required: true }),
    h('button', { type: 'submit', class: 'btn primary' }, '+ Add')
  ));
  return card;
}
async function adminStatuses() {
  const statuses = await api('api_statuses_list');
  const card = h('div', { class: 'card' }, h('h4', {}, 'Lead statuses'));
  const tbl = h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Color'), h('th', {}, 'Order'), h('th', {}, 'Final'), h('th', {}))),
    h('tbody', {}, ...statuses.map(s => h('tr', {},
      h('td', {}, h('input', { value: s.name, 'data-id': s.id, 'data-field': 'name' })),
      h('td', {}, h('input', { type: 'color', value: s.color, 'data-id': s.id, 'data-field': 'color' })),
      h('td', {}, h('input', { type: 'number', value: s.sort_order, style: { width: '70px' }, 'data-id': s.id, 'data-field': 'sort_order' })),
      h('td', {}, h('input', { type: 'checkbox', checked: Number(s.is_final) ? 'checked' : null, 'data-id': s.id, 'data-field': 'is_final' })),
      h('td', {},
        h('button', { class: 'btn sm', onclick: async () => {
          const patch = { id: s.id };
          $$(`[data-id="${s.id}"]`, tbl).forEach(inp => {
            const f = inp.dataset.field;
            patch[f] = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : inp.value;
          });
          try { await api('api_statuses_save', patch); toast('Saved'); } catch (e) { toast(e.message, 'err'); }
        } }, '💾'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!await confirmDialog(`Delete status "${s.name}"?`)) return;
          try { await api('api_statuses_delete', s.id); toast('Deleted'); showAdminTab('statuses'); } catch (e) { toast(e.message, 'err'); }
        } }, 'Delete')
      )
    )))
  );
  card.appendChild(tbl);
  card.appendChild(h('form', { class: 'inline-form', onsubmit: async ev => {
    ev.preventDefault();
    const f = ev.target;
    try { await api('api_statuses_save', { name: f.n.value, color: f.c.value, sort_order: Number(f.o.value) || 10, is_final: f.fi.checked ? 1 : 0 }); toast('Added'); showAdminTab('statuses'); }
    catch (e) { toast(e.message, 'err'); }
  }},
    h('input', { name: 'n', placeholder: 'Status name', required: true }),
    h('input', { name: 'c', type: 'color', value: '#6366f1' }),
    h('input', { name: 'o', type: 'number', placeholder: 'Order', value: 100, style: { width: '70px' } }),
    h('label', { class: 'cb' }, h('input', { name: 'fi', type: 'checkbox' }), ' Final'),
    h('button', { type: 'submit', class: 'btn primary' }, '+ Add status')
  ));
  return card;
}
async function adminCustomFields() {
  const fields = await api('api_customFields_list');
  const card = h('div', { class: 'card' }, h('h4', {}, 'Custom lead fields'));
  card.appendChild(h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Label'), h('th', {}, 'Type'), h('th', {}, 'In list'), h('th', {}, 'Required'), h('th', {}))),
    h('tbody', {}, ...fields.map(f => h('tr', {},
      h('td', {}, f.key), h('td', {}, f.label), h('td', {}, f.field_type),
      h('td', {}, f.show_in_list ? '✓' : '—'),
      h('td', {}, f.is_required ? '✓' : '—'),
      h('td', {}, h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog(`Delete field "${f.label}"?`)) return; await api('api_customFields_delete', f.id); toast('Deleted'); showAdminTab('customfields'); } }, 'Delete'))
    )))
  ));
  card.appendChild(h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('api_customFields_save', {
        key: f.key.value, label: f.label.value,
        field_type: f.field_type.value, options: f.options.value,
        show_in_list: f.show_in_list.checked ? 1 : 0,
        is_required: f.is_required.checked ? 1 : 0,
        sort_order: Number(f.sort_order.value) || 10
      });
      toast('Added'); await warmCache(); showAdminTab('customfields');
    } catch (e) { toast(e.message, 'err'); }
  }},
    field('key', 'Key *', '', { required: true }),
    field('label', 'Label *', '', { required: true }),
    selectField('field_type', 'Type', 'text', ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox']),
    field('options', 'Options (pipe-separated)', ''),
    field('sort_order', 'Sort order', '10', { type: 'number' }),
    h('div', { class: 'f-row' }, h('label', { class: 'cb' }, h('input', { name: 'show_in_list', type: 'checkbox' }), ' Show in list')),
    h('div', { class: 'f-row' }, h('label', { class: 'cb' }, h('input', { name: 'is_required', type: 'checkbox' }), ' Required')),
    h('div', { class: 'f-row full' }, h('button', { type: 'submit', class: 'btn primary' }, '+ Add field'))
  ));
  return card;
}
async function adminRules() {
  const rules = await api('api_rules_list');
  const card = h('div', { class: 'card' }, h('h4', {}, 'Auto-assign rules'));
  card.appendChild(h('p', { class: 'muted' }, 'First matching rule (by lowest priority number) wins. Assigning multiple users enables round-robin.'));
  card.appendChild(h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Priority'), h('th', {}, 'Name'), h('th', {}, 'When'), h('th', {}, 'Assign to'), h('th', {}, 'Active'), h('th', {}))),
    h('tbody', {}, ...rules.map(r => h('tr', {},
      h('td', {}, r.priority),
      h('td', {}, r.name),
      h('td', {}, `${r.field} ${r.operator} "${r.value}"`),
      h('td', {}, r.assigned_names || r.assigned_to),
      h('td', {},
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: Number(r.is_active) ? 'checked' : null,
            onclick: async ev => { try { await api('api_rules_toggle', r.id, ev.target.checked); toast('Toggled'); } catch (e) { toast(e.message, 'err'); } } }),
          h('span', { class: 'slider' })
        )
      ),
      h('td', {},
        h('button', { class: 'btn sm', onclick: () => openRuleModal(r) }, '✎'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog('Delete rule?')) return; await api('api_rules_delete', r.id); toast('Deleted'); showAdminTab('rules'); } }, '🗑')
      )
    )))
  ));
  card.appendChild(h('div', { class: 'actions', style: { marginTop: '1rem' } },
    h('button', { class: 'btn primary', onclick: () => openRuleModal() }, '+ New rule')
  ));
  return card;
}
function openRuleModal(existing) {
  const { users } = CRM.cache;
  const r = existing || { name: '', field: 'source', operator: 'equals', value: '', assigned_to: '', priority: 100, is_active: 1 };
  const assignedIds = String(r.assigned_to || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, r.id ? 'Edit rule' : 'New auto-assign rule'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('form', { class: 'form-grid', id: 'rule-form' },
        field('name', 'Rule name *', r.name, { required: true }),
        selectField('field', 'Field', r.field, ['source', 'product', 'name', 'phone', 'email', 'city', 'notes', 'source_ref']),
        selectField('operator', 'Operator', r.operator, ['equals', 'contains', 'starts_with', 'ends_with']),
        field('value', 'Value *', r.value, { required: true }),
        field('priority', 'Priority (lower = first)', r.priority || 100, { type: 'number' }),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Assign to (hold Ctrl/Cmd to pick multiple → round-robin)'),
          h('select', { name: 'assigned_to', multiple: true, size: Math.min(8, users.length || 4) },
            ...users.map(u => h('option', { value: u.id, selected: assignedIds.includes(Number(u.id)) ? 'selected' : null }, `${u.name} (${u.role})`))
          )
        )
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const f = $('#rule-form');
          const assigned = $$('[name="assigned_to"] option:checked', f).map(o => o.value);
          if (!assigned.length) return toast('Pick at least one assignee', 'err');
          const payload = {
            id: r.id,
            name: f.name.value, field: f.field.value, operator: f.operator.value,
            value: f.value.value, priority: Number(f.priority.value) || 100,
            assigned_to: assigned, is_active: 1
          };
          try { await api('api_rules_save', payload); toast('Saved'); modal.remove(); showAdminTab('rules'); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(modal);
}
async function adminDuplicates() {
  const cfg = await api('api_admin_getConfig');
  return configForm(cfg, ['DUPLICATE_POLICY', 'DUPLICATE_WINDOW_HOURS', 'DUPLICATE_MATCH_FIELDS'], {
    DUPLICATE_POLICY: { type: 'select', options: ['allow', 'assign_same_user', 'skip_assignment', 'reject'],
      hint: 'allow=always create · assign_same_user=give to original assignee · skip_assignment=leave unassigned · reject=drop incoming dup' },
    DUPLICATE_WINDOW_HOURS: { hint: 'Only check dupes within this window (hours)' },
    DUPLICATE_MATCH_FIELDS: { hint: 'Comma-separated: phone, email' }
  });
}
async function adminSmtp() {
  const cfg = await api('api_admin_getConfig');
  return configForm(cfg, ['EMAIL_NOTIFY_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_NOTIFY_FROM', 'EMAIL_NOTIFY_SUBJECT_PREFIX', 'FOLLOWUP_REMIND_MIN'], {
    EMAIL_NOTIFY_ENABLED: { type: 'select', options: ['0', '1'], hint: '0 = off, 1 = send reminder emails' },
    SMTP_SECURE: { type: 'select', options: ['false', 'true'], hint: 'true for port 465, false for 587/STARTTLS' },
    FOLLOWUP_REMIND_MIN: { hint: 'Remind this many minutes before due_at' }
  });
}

function configForm(cfg, keys, meta) {
  meta = meta || {};
  const form = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const patch = {};
    keys.forEach(k => { patch[k] = fd.get(k); });
    try { await api('api_admin_setConfig', patch); toast('Saved'); }
    catch (e) { toast(e.message, 'err'); }
  }});
  keys.forEach(k => {
    const m = meta[k] || {};
    let input;
    if (m.type === 'select') {
      input = h('select', { name: k }, ...(m.options || []).map(o => h('option', { value: o, selected: String(cfg[k]) === String(o) ? 'selected' : null }, o)));
    } else if (/password/i.test(k) || /secret/i.test(k)) {
      input = h('input', { name: k, type: 'password', value: cfg[k] || '' });
    } else {
      input = h('input', { name: k, value: cfg[k] || '' });
    }
    form.appendChild(h('div', { class: 'f-row' }, h('label', {}, k), input, m.hint ? h('small', { class: 'muted' }, m.hint) : null));
  });
  form.appendChild(h('div', { class: 'f-row full' }, h('button', { type: 'submit', class: 'btn primary' }, '💾 Save')));
  return form;
}

/* ---------------- Users ---------------- */
VIEWS.users = async (view) => {
  const users = await api('api_users_list');
  view.innerHTML = '';
  view.append(
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => openUserModal() }, '+ New User')
    ),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Reports To'), h('th', {}, 'Department'), h('th', {}))),
      h('tbody', {}, ...users.map(u => h('tr', {},
        h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.role),
        h('td', {}, u.parent_name || '—'), h('td', {}, u.department || ''),
        h('td', {}, h('button', { class: 'btn sm', onclick: () => openUserModal(u) }, '✎'))
      )))
    ))
  );
};
async function openUserModal(u) {
  u = u || { role: 'sales', is_active: 1 };
  const parents = CRM.cache.users || await api('api_users_list');
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, u.id ? 'Edit user' : 'New user'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('form', { id: 'u-form', class: 'form-grid' },
        field('name', 'Name *', u.name, { required: true }),
        field('email', 'Email *', u.email, { required: true, type: 'email' }),
        field('phone', 'Phone', u.phone),
        selectField('role', 'Role', u.role, ['admin', 'manager', 'team_leader', 'sales']),
        selectField('parent_id', 'Reports To', u.parent_id || '', [{ value: '', label: '— None —' }, ...parents.filter(p => p.id !== u.id).map(p => ({ value: p.id, label: p.name }))]),
        field('department', 'Department', u.department),
        field('designation', 'Designation', u.designation),
        !u.id ? field('password', 'Password *', '', { type: 'password', required: true }) : null
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const f = $('#u-form');
          const payload = {
            id: u.id,
            name: f.name.value, email: f.email.value, phone: f.phone.value,
            role: f.role.value, parent_id: f.parent_id.value || null,
            department: f.department.value, designation: f.designation.value
          };
          if (!u.id) payload.password = f.password.value;
          try { await api('api_users_save', payload); toast('Saved'); modal.remove(); await warmCache(); navigateTo('users'); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(modal);
}

/* ---------------- HR views ---------------- */
VIEWS.tasks = async (view) => {
  const rows = await api('api_tasks_list', {});
  view.innerHTML = '';
  view.append(
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openTaskModal() }, '+ New task')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Assigned'), h('th', {}, 'Due'), h('th', {}, 'Status'), h('th', {}))),
      h('tbody', {}, ...rows.map(t => h('tr', {},
        h('td', {}, t.title), h('td', {}, t.assigned_name || ''),
        h('td', {}, fmtDate(t.due_at)), h('td', {}, t.status),
        h('td', {}, t.status !== 'done' ? h('button', { class: 'btn sm', onclick: async () => { await api('api_tasks_complete', t.id); navigateTo('tasks'); } }, '✓') : null)
      )))
    ))
  );
};
async function openTaskModal() {
  const users = CRM.cache.users || await api('api_users_list');
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, 'New task'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
    h('form', { id: 't-form', class: 'form-grid' },
      field('title', 'Title *', '', { required: true }),
      field('description', 'Description', '', { type: 'textarea', full: true }),
      selectField('assigned_to', 'Assign to', CRM.user.id, users.map(u => ({ value: u.id, label: u.name }))),
      field('due_at', 'Due', '', { type: 'datetime-local' })
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const f = $('#t-form');
        try { await api('api_tasks_save', { title: f.title.value, description: f.description.value, assigned_to: Number(f.assigned_to.value), due_at: f.due_at.value }); toast('Created'); modal.remove(); navigateTo('tasks'); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Create')
    )
  ));
  document.body.appendChild(modal);
}

VIEWS.attendance = async (view) => {
  const rows = await api('api_attendance_mine');
  view.innerHTML = '';
  view.append(
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => checkInOut('checkIn') }, '🕘 Check in'),
      h('button', { class: 'btn', onclick: () => checkInOut('checkOut') }, '🕔 Check out')
    ),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'In'), h('th', {}, 'Out'), h('th', {}, 'Status'))),
      h('tbody', {}, ...rows.map(r => h('tr', {},
        h('td', {}, r.date), h('td', {}, fmtDate(r.check_in, 'time')),
        h('td', {}, fmtDate(r.check_out, 'time')), h('td', {}, r.status || '')
      )))
    ))
  );
};
async function checkInOut(which) {
  const call = async (lat, lng) => {
    try { await api('api_attendance_' + which, lat, lng); toast(which === 'checkIn' ? 'Checked in' : 'Checked out'); navigateTo('attendance'); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (!navigator.geolocation) return call(null, null);
  navigator.geolocation.getCurrentPosition(
    p => call(p.coords.latitude, p.coords.longitude),
    () => call(null, null)
  );
}

VIEWS.leaves = async (view) => {
  const rows = await api('api_leaves_mine');
  view.innerHTML = '';
  view.append(
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: openLeaveModal }, '+ Apply')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'From'), h('th', {}, 'To'), h('th', {}, 'Reason'), h('th', {}, 'Status'))),
      h('tbody', {}, ...rows.map(l => h('tr', {}, h('td', {}, l.from_date), h('td', {}, l.to_date), h('td', {}, l.reason || ''), h('td', {}, l.status))))
    ))
  );
};
function openLeaveModal() {
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, 'Apply leave'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
    h('form', { id: 'l-form', class: 'form-grid' },
      field('from_date', 'From *', '', { type: 'date', required: true }),
      field('to_date', 'To *', '', { type: 'date', required: true }),
      field('reason', 'Reason', '', { type: 'textarea', full: true })
    ),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const f = $('#l-form');
        try { await api('api_leaves_apply', { from_date: f.from_date.value, to_date: f.to_date.value, reason: f.reason.value }); toast('Applied'); modal.remove(); navigateTo('leaves'); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Apply'))
  ));
  document.body.appendChild(modal);
}

VIEWS.salary = async (view) => {
  const rows = await api('api_salary_mine');
  view.innerHTML = '';
  view.append(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Base'), h('th', {}, 'Allowances'), h('th', {}, 'Deductions'), h('th', {}, 'Net'))),
    h('tbody', {}, ...rows.map(s => h('tr', {}, h('td', {}, s.month),
      h('td', {}, Number(s.base).toFixed(2)),
      h('td', {}, Number(s.allowances).toFixed(2)),
      h('td', {}, Number(s.deductions).toFixed(2)),
      h('td', {}, Number(s.net_pay).toFixed(2)))))
  )));
};

VIEWS.bank = async (view) => {
  const info = (await api('api_bank_mine')) || {};
  view.innerHTML = '';
  const form = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try { await api('api_bank_save', Object.fromEntries(fd)); toast('Saved'); }
    catch (e) { toast(e.message, 'err'); }
  }},
    field('bank_name', 'Bank name', info.bank_name),
    field('account_holder', 'Account holder', info.account_holder),
    field('account_number', 'Account number', info.account_number),
    field('ifsc', 'IFSC', info.ifsc),
    field('branch', 'Branch', info.branch),
    field('upi_id', 'UPI ID', info.upi_id),
    field('notes', 'Notes', info.notes, { type: 'textarea', full: true }),
    h('div', { class: 'f-row full' }, h('button', { type: 'submit', class: 'btn primary' }, '💾 Save'))
  );
  view.appendChild(form);
};

/* ---------------- FB connect ---------------- */
function connectFacebook() {
  const doLogin = () => FB.login(async resp => {
    if (!resp.authResponse) return toast('Cancelled', 'warn');
    try { const r = await api('api_fb_connect', resp.authResponse.accessToken); toast('Connected: ' + (r.page_name || r.page_id)); showAdminTab('fb'); }
    catch (e) { toast(e.message, 'err'); }
  }, { scope: 'pages_show_list,pages_manage_metadata,leads_retrieval,pages_read_engagement' });

  if (window.FB) return doLogin();
  api('api_fb_status').then(({ app_id }) => {
    if (!app_id) return toast('Set META_APP_ID in Admin → Facebook first', 'err');
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.onload = () => { FB.init({ appId: app_id, cookie: true, xfbml: false, version: 'v19.0' }); doLogin(); };
    document.body.appendChild(s);
  }).catch(e => toast(e.message, 'err'));
}

/* ---------------- Notifications + follow-up popup ---------------- */
let followupPollTimer = null;
function startFollowupPolling() {
  if (followupPollTimer) clearInterval(followupPollTimer);
  followupPollTimer = setInterval(refreshNotifs, 60_000);
}
async function refreshNotifs() {
  try {
    const d = await api('api_notifications_mine');
    const n = (d.counts.overdue || 0) + (d.counts.due_today || 0) + (d.counts.unread || 0);
    const badge = $('#notif-count');
    if (badge) { badge.textContent = n; badge.hidden = n === 0; }
    if ((d.counts.due_today || 0) + (d.counts.overdue || 0) > 0) popupFollowupDue(d);
  } catch (_) {}
}
let _popupShown = false;
function popupFollowupDue(d) {
  if (_popupShown) return;
  const urgent = [...(d.overdue || []), ...(d.due_today || [])].slice(0, 5);
  if (!urgent.length) return;
  _popupShown = true;
  const close = () => { modal.remove(); _popupShown = false; };
  const modal = h('div', { class: 'modal-backdrop popup-followup' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, '⏰ Follow-ups due'), h('button', { class: 'btn icon', onclick: close }, '✕')),
      h('ul', { class: 'followup-list' }, ...urgent.map(f => h('li', {},
        h('b', {}, f.lead_name || '—'), ' — ', f.lead_phone || '',
        h('div', { class: 'muted' }, 'Due: ', fmtDate(f.due_at)),
        f.note ? h('div', {}, f.note) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm', onclick: async () => { await api('api_followup_done', f.id); toast('Marked done'); refreshNotifs(); } }, '✓ Done'),
          h('button', { class: 'btn sm ghost', onclick: () => { close(); navigateTo('leads'); setTimeout(() => openLeadModal(f.lead_id), 300); } }, 'Open lead')
        )
      ))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, 'Later'),
        h('button', { class: 'btn primary', onclick: () => { close(); navigateTo('followups'); } }, 'See all')
      )
    )
  );
  document.body.appendChild(modal);
}
async function showNotifs() {
  const d = await api('api_notifications_mine');
  const list = (d.unread_notifications || []);
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, 'Notifications'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      list.length
        ? h('ul', { class: 'notif-list' }, ...list.map(n => h('li', {}, h('b', {}, n.title || ''), h('br'), n.body || '')))
        : h('p', { class: 'muted' }, 'All clear. ✨'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => { try { await api('api_notifications_read_all'); refreshNotifs(); modal.remove(); } catch (e) { toast(e.message, 'err'); } } }, 'Mark all read')
      )
    )
  );
  document.body.appendChild(modal);
}
