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
// Global "in-flight" counter — drives the top loading bar.
let _apiInFlight = 0;
function _bumpApiLoader(delta) {
  _apiInFlight = Math.max(0, _apiInFlight + delta);
  let bar = document.getElementById('global-loader');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'global-loader';
    bar.innerHTML = '<div class="gl-fill"></div>';
    document.body.appendChild(bar);
  }
  bar.classList.toggle('active', _apiInFlight > 0);
}

// Endpoints we DON'T want to show the top loader for (background pollers):
const _SILENT_FNS = new Set([
  'api_notifications_mine', 'api_call_logEvent', 'api_company_info'
]);

async function api(fn, ...args) {
  const silent = _SILENT_FNS.has(fn);
  if (!silent) _bumpApiLoader(+1);
  try {
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
  } finally {
    if (!silent) _bumpApiLoader(-1);
  }
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
      // Register Web Push so the user's phone gets SMS-style banners even
      // when the CRM tab / installed PWA is closed. Runs after a short delay
      // so it doesn't block initial render. Silently skips on browsers that
      // don't support push or where the user declines permission.
      setTimeout(() => registerWebPush().catch(() => {}), 2000);
      // Native push (Capacitor APK only) — talks to Firebase Cloud Messaging.
      // No-ops in regular browsers / installed PWAs (those use Web Push above).
      setTimeout(() => registerCapacitorPush().catch(() => {}), 2500);
      // Resume any pending call (WebView may have been killed during the call).
      // Runs after warmCache so the lead's status options etc are loaded.
      setTimeout(() => _resumePendingCall('boot'), 1500);
      // Silent background sweep: pick up any missed recordings.
      setTimeout(() => silentBackgroundSync(), 4000);
    } catch (_) { logout(); }
  } else {
    renderLogin();
  }

  // When the service worker fires a notificationclick, it posts a 'navigate'
  // message back to the page — route to the URL the push payload pointed at.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', ev => {
      const m = ev && ev.data;
      if (m && m.type === 'navigate' && m.url) {
        try { location.assign(m.url); } catch (_) { location.href = m.url; }
      }
    });
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

/**
 * Convert any datetime stored in the DB (ISO UTC, or naive Postgres timestamp)
 * to a "YYYY-MM-DDTHH:mm" string in the user's LOCAL timezone, suitable for
 * a datetime-local input. Without this, a UTC value like 2026-04-25T15:10:00Z
 * shows in the form as 15:10 instead of the local 20:40.
 */
function isoToLocalDtInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 16);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Inverse of isoToLocalDtInput. Converts a "YYYY-MM-DDTHH:mm" datetime-local
 * value (interpreted as the user's local time) into a UTC ISO string the
 * server can store and round-trip safely. JavaScript's Date constructor parses
 * datetime-local strings as local time — toISOString() then emits proper UTC.
 */
function localDtInputToIso(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString();
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
  { id: 'dialer',     label: 'Dialer',       icon: '📞' },
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
          <button class="btn icon topbar-mobile-menu" id="btn-more" title="Menu">☰</button>
          <h2 id="page-title">Dashboard</h2>
          <div class="topbar-right">
            <button class="btn ghost" id="btn-getapp" title="Install / Download the app"><span>📱</span><span class="topbar-getapp-text">Get app</span></button>
            <button class="btn ghost" id="btn-notif" title="Notifications">🔔<span class="badge" id="notif-count" hidden>0</span></button>
          </div>
        </header>
        <section id="view"></section>
      </main>
      <nav class="bottom-nav" id="bottom-nav"></nav>
    </div>`;
  const nav = $('#nav');
  const mobileNav = $('#bottom-nav');
  // Mobile bottom bar: 4 main + More
  const mobilePrimary = ['dashboard', 'leads', 'dialer', 'followups'];
  NAV.forEach(item => {
    if (item.roles && !item.roles.includes(CRM.user.role)) return;
    const a = h('a', { href: '#/' + item.id, 'data-view': item.id }, h('span', { class: 'nav-icon' }, item.icon), h('span', {}, item.label));
    nav.appendChild(a);
    if (mobilePrimary.includes(item.id)) {
      const ma = h('a', { href: '#/' + item.id, 'data-view': item.id },
        h('span', { class: 'bn-ico' }, item.icon),
        h('span', {}, item.label));
      mobileNav.appendChild(ma);
    }
  });
  // "More" button opens the full menu as a bottom sheet
  mobileNav.appendChild(h('a', { href: '#', onclick: ev => { ev.preventDefault(); showMobileMore(); } },
    h('span', { class: 'bn-ico' }, '⋯'), h('span', {}, 'More')));

  $('#btn-logout').onclick = logout;
  $('#btn-notif').onclick = showNotifs;
  $('#btn-more').onclick = showMobileMore;
  const _ga = $('#btn-getapp'); if (_ga) _ga.onclick = showGetApp;
}

/**
 * Get App modal — shows the user how to install the CRM as a PWA on their
 * phone (Chrome → Add to Home Screen) and offers a direct download link
 * for the Android APK if one is hosted in /public/.
 */
function showGetApp() {
  const apkHref = '/LeadCRM.apk';
  const ua = navigator.userAgent || '';
  const isAndroid = /android/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const url = location.origin + '/';
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '📱 Get the CRM on your phone'),
        h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
      ),
      h('div', { class: 'modal-body' },
        h('p', { class: 'muted', style: { marginTop: 0 } },
          'Install the CRM on your phone so you get push notifications even when the browser is closed.'),
        h('div', { class: 'cards', style: { gap: '.75rem' } },
          h('div', { class: 'card' },
            h('h4', { style: { margin: '0 0 .5rem' } }, '📱 Install as PWA (recommended)'),
            h('ol', { style: { paddingLeft: '1.2rem', margin: 0 } },
              h('li', {}, 'Open this site in Chrome on your phone: ', h('code', {}, url)),
              h('li', {}, isIOS
                ? 'Tap the Share button (square + arrow) → "Add to Home Screen".'
                : 'Tap the ⋮ menu in Chrome → "Install app" or "Add to Home screen".'),
              h('li', {}, 'Open the new icon and allow notifications when prompted.')
            )
          ),
          isAndroid || !isIOS ? h('div', { class: 'card' },
            h('h4', { style: { margin: '0 0 .5rem' } }, '⬇️ Direct APK (Android)'),
            h('p', { class: 'muted', style: { marginTop: 0 } },
              'For Android only. You may have to allow "Install from unknown sources".'),
            h('a', { class: 'btn primary', href: apkHref, download: '' }, 'Download LeadCRM.apk')
          ) : null
        )
      )
    )
  );
  document.body.appendChild(m);
}

function showMobileMore() {
  const sheet = h('div', { class: 'modal-backdrop bottom-nav-more-modal', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) sheet.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, esc(CRM.config.company_name || 'Menu')),
        h('button', { class: 'btn icon', onclick: () => sheet.remove() }, '✕')
      ),
      h('div', { class: 'me', style: { padding: '.5rem 0' } },
        h('span', { class: 'avatar' }, (CRM.user.name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()),
        h('div', { class: 'me-meta' },
          h('div', { class: 'name' }, CRM.user.name),
          h('div', { class: 'role muted' }, CRM.user.role + ' · ' + CRM.user.email)
        )
      ),
      h('div', { class: 'mobile-menu-grid' },
        ...NAV.filter(item => !item.roles || item.roles.includes(CRM.user.role)).map(item =>
          h('a', { href: '#/' + item.id, class: 'menu-tile', onclick: () => sheet.remove() },
            h('span', { class: 'menu-tile-icon' }, item.icon),
            h('span', {}, item.label))
        )
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn block', onclick: () => { sheet.remove(); logout(); } }, 'Logout')
      )
    )
  );
  document.body.appendChild(sheet);
}

function navigateTo(id) {
  const item = NAV.find(n => n.id === id) || NAV[0];
  $$('.sidebar nav a, #bottom-nav a').forEach(a => a.classList.toggle('active', a.dataset.view === item.id));
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

  // Follow-ups card — three tabs in one box: Upcoming / Overdue / Due today.
  // Renders the same row markup for each list so the user has a consistent
  // glance at upcoming work no matter which tab they're on.
  const fuCard = h('div', { class: 'card fu-tabs-card' });
  const tabs = [
    { key: 'upcoming',  label: 'Upcoming',  rows: due.upcoming || [] },
    { key: 'overdue',   label: 'Overdue',   rows: due.overdue  || [] },
    { key: 'due_today', label: 'Due today', rows: due.due_today || [] }
  ];
  const tabBar = h('div', { class: 'fu-tabbar' });
  const tabBody = h('div', { class: 'fu-tabbody' });
  function renderFuTab(activeKey) {
    [...tabBar.children].forEach(btn => btn.classList.toggle('active', btn.dataset.key === activeKey));
    const tab = tabs.find(t => t.key === activeKey);
    tabBody.innerHTML = '';
    if (!tab.rows.length) {
      tabBody.appendChild(h('p', { class: 'muted', style: { padding: '.5rem' } },
        activeKey === 'overdue' ? 'No overdue follow-ups. 🎉' :
        activeKey === 'due_today' ? 'Nothing due today.' :
        'No upcoming follow-ups.'));
      return;
    }
    tabBody.appendChild(h('ul', { class: 'fu-dash-list' },
      ...tab.rows.slice(0, 8).map(f => h('li', {},
        h('div', { class: 'fu-name', onclick: () => openLeadModal(f.lead_id) }, f.lead_name || '—'),
        h('div', { class: 'fu-phone muted' }, f.lead_phone || ''),
        h('div', { class: 'fu-due ' + (new Date(f.due_at) < new Date() ? 'overdue' : '') }, fmtDate(f.due_at, 'relative'))
      ))
    ));
    if (tab.rows.length > 8) {
      tabBody.appendChild(h('div', { class: 'muted', style: { fontSize: '.8rem', textAlign: 'center', padding: '.4rem' } },
        '+ ' + (tab.rows.length - 8) + ' more — see Follow-ups'));
    }
  }
  tabs.forEach(t => tabBar.appendChild(
    h('button', { class: 'fu-tab' + (t.key === 'upcoming' ? ' active' : ''), 'data-key': t.key,
      onclick: () => renderFuTab(t.key) },
      t.label, t.rows.length ? h('span', { class: 'fu-tab-count' }, t.rows.length) : null
    )
  ));
  fuCard.appendChild(h('div', { class: 'fu-tabs-head' },
    h('h3', { style: { margin: 0 } }, '⏰ Follow-ups'),
    h('a', { href: '#/followups', class: 'btn sm ghost' }, 'See all →')
  ));
  fuCard.appendChild(tabBar);
  fuCard.appendChild(tabBody);
  renderFuTab('upcoming');
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
    // User asked for the dashboard "Leads by status" to be a bar chart with
    // visible numbers (not a pie). Bar chart with status colors and datalabels.
    makeChart('dash-pie', 'bar', statusData.map(x => x.status), statusData.map(x => x.c), statusData.map(x => x.color));
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
      onkeydown: ev => { if (ev.key === 'Enter') { CRM._leadsPage = 1; loadLeads({ page: 1 }); } } }),
    selectOpts('f-status', [{ id: '', name: 'Any status' }, ...statuses], CRM.prefs.filters.status_id),
    selectOpts('f-source', [{ id: '', name: 'Any source' }, ...sources.map(s => ({ id: s.name, name: s.name }))], CRM.prefs.filters.source),
    selectOpts('f-assigned', [{ id: '', name: 'Any assignee' }, ...users], CRM.prefs.filters.assigned_to),
    selectOpts('f-followup', [{ id: '', name: 'All follow-ups' }, { id: 'today', name: 'Due today' }, { id: 'overdue', name: 'Overdue' }], CRM.prefs.filters.followup),
    selectOpts('f-duplicate', [
      { id: '', name: 'All leads' },
      { id: 'only', name: '⚠️ Duplicates only' },
      { id: 'unique', name: 'No duplicates' }
    ], CRM.prefs.filters.duplicate),
    h('button', { class: 'btn', onclick: () => { CRM._leadsPage = 1; loadLeads({ page: 1 }); } }, '🔎'),
    h('button', { class: 'btn ghost', onclick: clearFilters, title: 'Reset filters' }, '✕'),
    h('button', { class: 'btn ghost', id: 'btn-refresh-leads', onclick: refreshLeads, title: 'Refresh leads list' }, '🔄'),
    h('button', { class: 'btn ghost', onclick: openColumnChooser, title: 'Columns' }, '☰'),
    h('button', { class: 'btn ghost', onclick: openBulkUpload, title: 'Upload CSV' }, '⬆️'),
    h('button', { class: 'btn ghost', onclick: exportCSV, title: 'Export CSV' }, '⬇️'),
    (CRM.user && (CRM.user.role === 'admin' || CRM.user.role === 'manager'))
      ? h('button', { class: 'btn ghost danger', onclick: deleteAllDuplicates, title: 'Delete every lead marked DUP' }, '🗑️ Dedupe')
      : null,
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
  // Mobile card container (only visible on ≤ 780px via CSS)
  view.appendChild(h('div', { class: 'leads-mobile', id: 'leads-mobile' }));
  // Pagination footer placeholder (loadLeads populates it)
  view.appendChild(h('div', { id: 'leads-pagination', class: 'pagination-bar' }));
  // Mobile FAB
  view.appendChild(h('button', { class: 'fab', onclick: () => openLeadModal(), title: 'New lead' }, '+'));

  CRM._leadsPage = 1;
  await loadLeads({ page: 1 });
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

async function loadLeads(opts) {
  opts = opts || {};
  const pageSize = Number(localStorage.getItem('crm_page_size') || 25);
  const page = Number(opts.page || CRM._leadsPage || 1);
  CRM._leadsPage = page;
  const filters = {
    q:           $('#f-q')?.value || undefined,
    status_id:   $('#f-status')?.value || undefined,
    source:      $('#f-source')?.value || undefined,
    assigned_to: $('#f-assigned')?.value || undefined,
    followup:    $('#f-followup')?.value || undefined,
    duplicate:   $('#f-duplicate')?.value || undefined,
    page,
    page_size:   pageSize
  };
  // Save user-visible filters only (not page/page_size — those are session state)
  const savedFilters = Object.assign({}, filters);
  delete savedFilters.page; delete savedFilters.page_size;
  CRM.prefs.filters = savedFilters;
  localStorage.setItem('crm_filters', JSON.stringify(savedFilters));

  try {
    const res = await api('api_leads_list', filters);
    CRM.cache.lastLeads = res.leads;
    CRM.cache.lastStatusCounts = res.status_count;
    CRM.cache.lastTotal = res.total || (res.leads || []).length;
    renderLeadsTable(res.leads);
    renderStatusChips(res.status_count);
    renderLeadsPagination({
      total: res.total || res.leads.length,
      page: res.page || 1,
      pageSize: res.page_size || pageSize
    });
  } catch (e) {
    $('#leads-table').innerHTML = `<tbody><tr><td colspan="99" class="error-box">${esc(e.message)}</td></tr></tbody>`;
  }
}

/** Pagination footer with page-size selector + Prev/Next + page numbers. */
function renderLeadsPagination({ total, page, pageSize }) {
  let bar = $('#leads-pagination');
  if (!bar) {
    bar = h('div', { id: 'leads-pagination', class: 'pagination-bar' });
    const tableWrap = $('#leads-table')?.closest('.table-wrap');
    if (tableWrap && tableWrap.parentNode) {
      tableWrap.parentNode.insertBefore(bar, tableWrap.nextSibling);
    } else {
      $('#view').appendChild(bar);
    }
  }
  bar.innerHTML = '';
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);

  // Page-size selector
  const sizeSel = h('select', { id: 'page-size-sel', class: 'page-size-sel',
    onchange: ev => {
      localStorage.setItem('crm_page_size', String(Number(ev.target.value) || 25));
      CRM._leadsPage = 1;
      loadLeads({ page: 1 });
    }
  });
  [10, 20, 25, 50, 100, 200, 500].forEach(n => {
    sizeSel.appendChild(h('option', { value: n, selected: n === pageSize ? 'selected' : null }, `${n} per page`));
  });
  bar.appendChild(h('div', { class: 'pagination-left' }, sizeSel));

  // Range info
  bar.appendChild(h('div', { class: 'pagination-info muted' },
    total === 0 ? 'No leads' : `${from}–${to} of ${total}`
  ));

  // Page navigation
  const nav = h('div', { class: 'pagination-nav' });
  const goto = (p) => { CRM._leadsPage = p; loadLeads({ page: p }); };
  nav.appendChild(h('button', {
    class: 'btn sm', disabled: safePage === 1 ? 'disabled' : null,
    onclick: () => goto(1)
  }, '« First'));
  nav.appendChild(h('button', {
    class: 'btn sm', disabled: safePage === 1 ? 'disabled' : null,
    onclick: () => goto(safePage - 1)
  }, '‹ Prev'));

  // Numeric page buttons (windowed: show up to 5 around current)
  const start = Math.max(1, safePage - 2);
  const end = Math.min(pages, start + 4);
  for (let p = start; p <= end; p++) {
    nav.appendChild(h('button', {
      class: 'btn sm' + (p === safePage ? ' primary' : ''),
      onclick: () => goto(p)
    }, String(p)));
  }
  nav.appendChild(h('button', {
    class: 'btn sm', disabled: safePage >= pages ? 'disabled' : null,
    onclick: () => goto(safePage + 1)
  }, 'Next ›'));
  nav.appendChild(h('button', {
    class: 'btn sm', disabled: safePage >= pages ? 'disabled' : null,
    onclick: () => goto(pages)
  }, 'Last »'));
  bar.appendChild(nav);
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

  // Mobile card view
  renderLeadsMobile(rows);
}

function renderLeadsMobile(rows) {
  const m = $('#leads-mobile');
  if (!m) return;
  m.innerHTML = '';
  if (!rows.length) {
    m.appendChild(h('div', { class: 'empty' }, 'No leads match your filters.'));
    return;
  }
  const { statuses } = CRM.cache;
  rows.forEach(l => {
    const digits = String(l.phone || '').replace(/\D/g, '');
    const statusColor = l.status_color || '#6b7280';
    const due = l.next_followup_at ? new Date(l.next_followup_at) : null;
    const overdue = due && due < new Date();
    const card = h('div', { class: 'lead-card' + (l.is_duplicate ? ' row-duplicate' : '') },
      h('div', { class: 'lc-head' },
        h('a', { href: '#', class: 'lc-name', onclick: ev => { ev.preventDefault(); openLeadModal(l.id); } }, l.name || '—'),
        h('span', { class: 'lc-status', style: { background: statusColor } }, l.status_name || '')
      ),
      h('div', { class: 'lc-meta' },
        l.phone ? h('span', {}, '📞 ', l.phone) : null,
        l.source ? h('span', {}, '• ', l.source) : null,
        l.assigned_name ? h('span', {}, '👤 ', l.assigned_name) : null
      ),
      l.is_duplicate ? h('div', { class: 'dup-pill', onclick: () => openDuplicateHistory(l.id) }, '⚠ DUP — see past') : null,
      due ? h('div', { class: 'lc-fu' + (overdue ? ' overdue' : '') }, '⏰ ' + fmtDate(l.next_followup_at, 'relative')) : null,
      l.recent_remark ? h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.3rem' } }, '💬 ' + (l.recent_remark || '').slice(0, 80)) : null,
      h('div', { class: 'lc-actions' },
        digits ? h('button', { class: 'btn sm btn-call', onclick: () => callLead(l) }, '📞 Call') : null,
        digits ? h('a', { class: 'btn sm', href: `https://wa.me/${digits}`, target: '_blank' }, '💬 WA') : null,
        h('button', { class: 'btn sm', onclick: () => openRemarkInline(l.id) }, '📝 Note'),
        h('button', { class: 'btn sm ghost', onclick: () => openLeadModal(l.id) }, '✎ Edit')
      )
    );
    m.appendChild(card);
  });
}

/** Click-to-call with after-call modal + targeted recording sync.
 *  IMPORTANT: persist the call context to localStorage so it survives
 *  Android killing the WebView during the call (common on Xiaomi/OnePlus/
 *  Samsung phones with aggressive battery management). When the WebView
 *  reloads after the call, _resumePendingCall() picks up where we left off. */
function callLead(lead) {
  const raw = String(lead.phone || '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return toast('No phone number', 'warn');
  const startedAt = Date.now();
  CRM.pendingCall = { lead, startedAt, dialedPhone: digits };

  // Stash everything we need to reopen the modal even if the WebView dies.
  try {
    localStorage.setItem('crm_pending_call', JSON.stringify({
      leadId: lead.id || null,
      leadName: lead.name || '',
      leadPhone: lead.phone || '',
      startedAt,
      dialedPhone: digits
    }));
  } catch (e) { console.warn(e); }

  if (window.LeadCRMNative && typeof LeadCRMNative.registerOutgoingCall === 'function') {
    try {
      LeadCRMNative.registerOutgoingCall(
        digits, lead.id ? String(lead.id) : '', startedAt
      );
    } catch (e) { console.warn('[leadcrm] registerOutgoingCall:', e); }
  }

  const hasPlus = raw.trim().startsWith('+');
  const telTarget = (hasPlus ? '+' : '') + digits;
  const a = document.createElement('a');
  a.href = 'tel:' + telTarget;
  a.click();
}

/**
 * Called on every app launch + every visibility change. If we find a recent
 * (within 10 minutes) pending call in localStorage that hasn't been resolved,
 * open the modal + start the recording sync. This is the bulletproof path
 * that works even when Android kills the WebView during the call.
 */
async function _resumePendingCall(reason) {
  // Skip if a modal is already open (don't double-open)
  if (document.querySelector('.after-call-modal')) return;

  let raw;
  try { raw = localStorage.getItem('crm_pending_call'); } catch (e) { return; }
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    localStorage.removeItem('crm_pending_call');
    return;
  }
  if (!data || !data.startedAt) {
    localStorage.removeItem('crm_pending_call');
    return;
  }
  const elapsed = Date.now() - data.startedAt;
  // Skip immediate triggers (<2s = accidental tap)
  if (elapsed < 2000) return;
  // Skip stale entries (>10 min old = abandoned)
  if (elapsed > 10 * 60 * 1000) {
    localStorage.removeItem('crm_pending_call');
    return;
  }

  console.log('[leadcrm] resuming pending call:', reason, 'elapsed=' + Math.round(elapsed/1000) + 's');

  // Clear the stash so we don't re-trigger
  localStorage.removeItem('crm_pending_call');
  CRM.pendingCall = null;

  // Get a full lead record (so the modal has status_id, etc.)
  let lead = null;
  if (data.leadId) {
    try {
      const r = await api('api_leads_get', data.leadId);
      lead = (r && (r.lead || r));
    } catch (e) {
      lead = { id: data.leadId, name: data.leadName, phone: data.leadPhone };
    }
  } else if (data.leadName || data.leadPhone) {
    lead = { name: data.leadName, phone: data.leadPhone };
  }
  if (!lead) return;

  // Slight delay so the rest of the UI has settled
  setTimeout(() => {
    openAfterCallModalWithRecording(lead, {
      lead,
      startedAt: data.startedAt,
      dialedPhone: data.dialedPhone || ''
    });
  }, 600);
}

// Fire after-call modal whenever the user returns to the app after tapping
// Call. Three triggers cover every case — WebView still alive (in-memory
// pendingCall) AND WebView killed and recreated (localStorage stash).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _resumePendingCall('visibilitychange');
});
window.addEventListener('focus', () => _resumePendingCall('focus'));
window.addEventListener('pageshow', () => _resumePendingCall('pageshow'));

async function openAfterCallModal(lead) {
  const { statuses } = CRM.cache;
  const modal = h('div', { class: 'modal-backdrop after-call-modal' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '📞 Call with ' + (lead.name || 'lead')),
        h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
      ),
      h('p', { class: 'muted' }, 'How did the call go? Update the status and add a remark.'),
      h('label', {}, 'Status'),
      h('select', { id: 'ac-status' },
        ...statuses.map(s => h('option', { value: s.id, selected: Number(s.id) === Number(lead.status_id) ? 'selected' : null }, s.name))
      ),
      h('label', {}, 'Remark'),
      h('textarea', { id: 'ac-remark', rows: 4, placeholder: 'What was discussed? Next step?' }),
      h('label', {}, 'Next follow-up (optional)'),
      h('input', { type: 'datetime-local', id: 'ac-followup' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Skip'),
        h('button', { class: 'btn primary', onclick: async () => {
          const statusId = Number($('#ac-status').value);
          const remark = $('#ac-remark').value.trim();
          const fu = $('#ac-followup').value;
          const patch = {};
          if (statusId && statusId !== Number(lead.status_id)) patch.status_id = statusId;
          if (fu) patch.next_followup_at = localDtInputToIso(fu);
          try {
            if (Object.keys(patch).length) await api('api_leads_update', lead.id, patch);
            if (remark) await api('api_leads_addRemark', lead.id, { remark });
            toast('Updated');
            modal.remove();
            if (typeof loadLeads === 'function') loadLeads();
          } catch (e) { toast(e.message, 'err'); }
        } }, '✓ Save update')
      )
    )
  );
  document.body.appendChild(modal);
  setTimeout(() => $('#ac-remark')?.focus(), 100);
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
        digits ? h('button', { class: 'btn icon', title: 'Call', onclick: ev => { ev.stopPropagation(); callLead(l); } }, '📞') : null,
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

/**
 * Delete every lead currently flagged is_duplicate=1, server-side.
 * Admin/manager only. Confirmation prompt with the count first.
 */
async function deleteAllDuplicates() {
  // Surface the duplicates view first so the admin can see what's about
  // to be removed, with the accurate total.
  const sel = document.getElementById('f-duplicate');
  if (sel) sel.value = 'only';
  await loadLeads({ page: 1 });
  const fullCount = Number(CRM.cache.lastTotal) || (CRM.cache.lastLeads || []).length;
  if (!fullCount) {
    toast('No duplicates found. ✨');
    if (sel) sel.value = '';
    await loadLeads({ page: 1 });
    return;
  }
  const msg = `Delete ALL ${fullCount} duplicate lead${fullCount === 1 ? '' : 's'}?\n\n` +
              `This will permanently remove them from the database. ` +
              `Their remarks and follow-ups will also be deleted.\n\n` +
              `This cannot be undone.`;
  if (!await confirmDialog(msg)) return;
  try {
    const r = await api('api_leads_deleteAllDuplicates');
    toast(`✅ Removed ${r.count} duplicate lead${r.count === 1 ? '' : 's'}`);
    if (sel) sel.value = '';
    await loadLeads({ page: 1 });
  } catch (e) { toast(e.message, 'err'); }
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
  // Include admin too, since admin may want to assign to themselves
  const users = (CRM.cache.users || []).filter(u => Number(u.is_active ?? 1) === 1);
  const noUsers = users.length === 0;

  let parsedRows = [];
  let assignMode = 'csv';

  // -------- Modal layout --------
  const fileInput = h('input', {
    type: 'file',
    accept: '.csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    id: 'csv-file',
    style: { width: '100%' }
  });
  const fileInfo = h('div', { class: 'muted', id: 'csv-file-info', style: { fontSize: '.85rem', marginTop: '.4rem' } }, 'No file selected. Accepts .csv, .xlsx and .xls.');
  const filePreview = h('div', { class: 'csv-preview', id: 'csv-preview', hidden: true });

  // Mode picker as 4 button cards — no radios, no labels, no flex weirdness.
  const modeCard = (id, icon, title, desc) => h('button', {
    type: 'button',
    class: 'assign-mode-card',
    'data-mode': id,
    onclick: () => { assignMode = id; updateMode(); }
  },
    h('span', { class: 'amc-icon' }, icon),
    h('span', { class: 'amc-content' },
      h('span', { class: 'amc-title' }, title),
      h('span', { class: 'amc-desc' }, desc)
    )
  );
  const modePicker = h('div', { class: 'assign-mode-grid' },
    modeCard('single',      '👤', 'One employee',         'Assign every lead to one person.'),
    modeCard('round_robin', '🔁', 'Round-robin',           'Divide equally between selected employees.'),
    modeCard('percent',     '📊', 'Percentage split',      'Custom share — e.g. 60% / 30% / 10%.'),
    modeCard('csv',         '📄', 'Use CSV value',         'Per-row assigned_to or your assignment rules.')
  );

  // Mode-specific bodies
  const singleSel = h('select', { id: 'assign-single-user', class: 'assign-single-input' },
    h('option', { value: '' }, '— pick employee —'),
    ...users.map(u => h('option', { value: u.id }, `${u.name} (${u.role})`))
  );
  const singleBody = h('div', { class: 'assign-mode-body', 'data-for': 'single', hidden: true, style: { display: 'none' } },
    h('label', {}, 'Assign all leads to:'), singleSel
  );

  const rrChecks = users.map(u => h('label', { class: 'assign-rr-check' },
    h('input', { type: 'checkbox', name: 'rr-user', value: u.id }),
    h('span', {}, ` ${u.name}`),
    h('span', { class: 'muted', style: { fontSize: '.78rem', marginLeft: '.35rem' } }, u.role)
  ));
  const rrBody = h('div', { class: 'assign-mode-body', 'data-for': 'round_robin', hidden: true, style: { display: 'none' } },
    h('label', {}, 'Pick the employees to share these leads:'),
    h('div', { class: 'assign-rr-grid' }, ...rrChecks),
    h('div', { class: 'actions', style: { marginTop: '.5rem' } },
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { rrChecks.forEach(c => c.querySelector('input').checked = true); previewAssignment(); } }, 'Select all'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { rrChecks.forEach(c => c.querySelector('input').checked = false); previewAssignment(); } }, 'Clear')
    )
  );
  rrBody.querySelectorAll('input').forEach(i => i.addEventListener('change', previewAssignment));

  const percentRows = users.map(u => h('div', { class: 'assign-pct-row' },
    h('label', { class: 'assign-pct-name' }, u.name + ' '),
    h('input', { type: 'number', min: 0, max: 100, step: 1, value: 0, 'data-uid': u.id, class: 'assign-pct-input', oninput: previewAssignment }),
    h('span', { class: 'muted' }, '%')
  ));
  const pctTotalEl = h('div', { class: 'assign-pct-total muted', id: 'pct-total' }, 'Total: 0%');
  const percentBody = h('div', { class: 'assign-mode-body', 'data-for': 'percent', hidden: true, style: { display: 'none' } },
    h('label', {}, 'Assign by percentage (must add up to 100%):'),
    h('div', { class: 'assign-pct-grid' }, ...percentRows),
    pctTotalEl
  );

  const csvBody = h('div', { class: 'assign-mode-body', 'data-for': 'csv' },
    h('p', { class: 'muted', style: { fontSize: '.85rem' } },
      'Each row keeps its own ',
      h('code', {}, 'assigned_to'),
      ' value (or stays empty for your assignment rules / round-robin defaults to apply).'
    )
  );

  const previewEl = h('div', { class: 'assign-preview' });
  const importBtn = h('button', { class: 'btn primary', disabled: 'disabled', onclick: doImport }, 'Import');

  function updateMode() {
    [...modePicker.children].forEach(c => c.classList.toggle('active', c.dataset.mode === assignMode));
    modePicker.querySelectorAll('input[type=radio]').forEach(r => r.checked = r.value === assignMode);
    [singleBody, rrBody, percentBody, csvBody].forEach(b => {
      const visible = b.dataset.for === assignMode;
      b.hidden = !visible;
      b.style.display = visible ? '' : 'none';
    });
    previewAssignment();
  }
  singleSel.addEventListener('change', previewAssignment);

  function readPercentSplit() {
    const split = {};
    let total = 0;
    percentRows.forEach(r => {
      const inp = r.querySelector('input');
      const v = Number(inp.value) || 0;
      const uid = Number(inp.dataset.uid);
      if (v > 0 && uid) { split[uid] = v; total += v; }
    });
    return { split, total };
  }

  function previewAssignment() {
    previewEl.innerHTML = '';
    if (!parsedRows.length) {
      importBtn.disabled = 'disabled';
      return;
    }
    const userById = Object.fromEntries(users.map(u => [Number(u.id), u]));
    let plan = [];
    let valid = false;

    if (assignMode === 'csv') {
      valid = true;
      previewEl.appendChild(h('div', { class: 'muted' }, `${parsedRows.length} rows — assignment per row's CSV value or your rules.`));

    } else if (assignMode === 'single') {
      const uid = Number(singleSel.value);
      if (!uid) {
        previewEl.appendChild(h('div', { class: 'muted warn' }, 'Pick an employee to continue.'));
      } else {
        valid = true;
        const u = userById[uid];
        previewEl.appendChild(h('div', {}, `All ${parsedRows.length} leads → `, h('b', {}, u.name)));
      }

    } else if (assignMode === 'round_robin') {
      const ids = [...rrBody.querySelectorAll('input[name=rr-user]:checked')].map(i => Number(i.value));
      if (!ids.length) {
        previewEl.appendChild(h('div', { class: 'muted warn' }, 'Pick at least one employee.'));
      } else {
        valid = true;
        const counts = {};
        for (let i = 0; i < parsedRows.length; i++) {
          const uid = ids[i % ids.length];
          counts[uid] = (counts[uid] || 0) + 1;
        }
        const lines = Object.entries(counts).map(([uid, n]) =>
          h('div', {}, `${userById[Number(uid)]?.name || ('User ' + uid)}: `, h('b', {}, n + ' leads'))
        );
        previewEl.appendChild(h('div', { class: 'preview-grid' }, ...lines));
      }

    } else if (assignMode === 'percent') {
      const { split, total } = readPercentSplit();
      pctTotalEl.textContent = 'Total: ' + total + '%';
      pctTotalEl.classList.toggle('warn', total !== 100);
      pctTotalEl.classList.toggle('ok', total === 100);
      if (total === 100) {
        valid = true;
        const lines = Object.entries(split).map(([uid, pct]) => {
          const n = Math.round((pct / 100) * parsedRows.length);
          return h('div', {}, `${userById[Number(uid)]?.name || ('User ' + uid)}: `, h('b', {}, `${n} leads (${pct}%)`));
        });
        previewEl.appendChild(h('div', { class: 'preview-grid' }, ...lines));
      } else {
        previewEl.appendChild(h('div', { class: 'muted warn' }, 'Percentages must add up to exactly 100%.'));
      }
    }
    importBtn.disabled = (parsedRows.length && valid) ? null : 'disabled';
  }

  fileInput.addEventListener('change', async (e) => {
    parsedRows = [];
    filePreview.hidden = true;
    filePreview.innerHTML = '';
    const f = e.target.files[0];
    if (!f) { fileInfo.textContent = 'No file selected.'; previewAssignment(); return; }
    fileInfo.textContent = '⏳ Parsing ' + f.name + '…';
    try {
      parsedRows = await parseSpreadsheet(f);
      const cols = parsedRows.length ? Object.keys(parsedRows[0]) : [];
      const sample = parsedRows.slice(0, 3);
      fileInfo.textContent = `✅ ${f.name} — ${parsedRows.length} rows · ${cols.length} columns`;

      // -------- Sanity warnings --------
      const warnings = [];
      // 1. Phone fields that came in as scientific notation -> Excel data loss
      const phoneFields = cols.filter(c => /^(phone|mobile|whatsapp|alt_phone|alternate)$/i.test(c));
      let sciPhoneCount = 0;
      const allPhonesSeen = [];
      parsedRows.forEach(r => {
        phoneFields.forEach(f => {
          const v = String(r[f] || '');
          allPhonesSeen.push(v);
          // Detect a phone that ends with a long run of zeros (Excel signature
          // of a sci-notation conversion that lost trailing digits)
          if (/^\d{10,}0{4,}$/.test(v) || /[eE]/.test(v)) sciPhoneCount++;
        });
      });
      if (sciPhoneCount > 0) {
        warnings.push({
          icon: '⚠️',
          msg: `${sciPhoneCount} phone number${sciPhoneCount === 1 ? ' is' : 's are'} in scientific notation — Excel has truncated trailing digits and these numbers are now corrupted. To fix: open your spreadsheet, right-click the Phone column → Format cells → Text, re-enter the numbers, then re-export.`
        });
      }
      // 2. Detect employee column under common alias names
      const userCols = cols.filter(c => /^(user|owner|assignee|sales_rep|salesperson|agent|assigned_user|rep|assigned_to)$/i.test(c));
      if (userCols.length) {
        warnings.push({
          icon: '👤',
          msg: `Detected employee column "${userCols[0]}" — leads will be auto-mapped to employees by name/email match.`,
          ok: true
        });
      }
      // 3. Notice if 'tags' column has status-like values (Duplicate, Lost, etc)
      if (cols.includes('tags')) {
        const dupCount = parsedRows.filter(r => /\b(duplicate|dup)\b/i.test(String(r.tags || ''))).length;
        if (dupCount > 0) {
          warnings.push({
            icon: 'ℹ️',
            msg: `${dupCount} row${dupCount === 1 ? '' : 's'} tagged as "Duplicate" will be flagged is_duplicate=1 (visible under Leads → ⚠️ Duplicates only filter).`,
            ok: true
          });
        }
      }
      if (warnings.length) {
        const wrap = h('div', { class: 'csv-warn-list' }, ...warnings.map(w =>
          h('div', { class: 'csv-warn ' + (w.ok ? 'ok' : 'warn') },
            h('span', { class: 'csv-warn-ico' }, w.icon),
            h('span', {}, w.msg)
          )
        ));
        filePreview.appendChild(wrap);
      }

      if (sample.length) {
        const tbl = h('table', { class: 'mini-table csv-preview-table' });
        const thead = h('thead', {}, h('tr', {}, ...cols.map(c => h('th', {}, c))));
        const tbody = h('tbody', {}, ...sample.map(r => h('tr', {}, ...cols.map(c => h('td', {}, String(r[c] || ''))))));
        tbl.append(thead, tbody);
        filePreview.appendChild(h('div', { class: 'muted', style: { fontSize: '.78rem', margin: '.5rem 0 .35rem' } }, 'Preview — first 3 rows:'));
        filePreview.appendChild(tbl);
        filePreview.hidden = false;
      }
      previewAssignment();
    } catch (err) {
      fileInfo.textContent = '⚠️ Could not parse file: ' + err.message;
    }
  });

  async function doImport() {
    if (!parsedRows.length) return toast('Choose a file first', 'warn');
    let assign;
    if (assignMode === 'csv') {
      assign = { mode: 'csv' };
    } else if (assignMode === 'single') {
      const uid = Number(singleSel.value);
      if (!uid) return toast('Pick an employee', 'warn');
      assign = { mode: 'single', user_id: uid };
    } else if (assignMode === 'round_robin') {
      const ids = [...rrBody.querySelectorAll('input[name=rr-user]:checked')].map(i => Number(i.value));
      if (!ids.length) return toast('Pick at least one employee', 'warn');
      assign = { mode: 'round_robin', user_ids: ids };
    } else if (assignMode === 'percent') {
      const { split, total } = readPercentSplit();
      if (total !== 100) return toast('Percentages must sum to 100%', 'warn');
      assign = { mode: 'percent', split };
    }
    importBtn.disabled = 'disabled';
    importBtn.textContent = 'Importing…';
    try {
      const r = await api('api_leads_bulkCreate', parsedRows, assign);
      const lines = [`✅ Imported ${r.created} of ${parsedRows.length}`];
      if (r.duplicate) lines.push(`${r.duplicate} duplicates`);
      if (r.skipped) lines.push(`${r.skipped} skipped`);
      toast(lines.join(' · '));
      modal.remove();
      loadLeads();
    } catch (e) {
      toast(e.message, 'err');
      importBtn.disabled = null;
      importBtn.textContent = 'Import';
    }
  }

  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, '⬆️ Bulk upload leads'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('p', { class: 'muted' }, 'Step 1: pick a CSV or Excel (.xlsx) file. Columns: name, phone, email, whatsapp, source, product, status, notes, city, tags, next_followup_at, assigned_to, plus any custom field keys. The status and product columns accept names — unknown values are auto-created.'),
      h('p', { class: 'muted', style: { fontSize: '.82rem' } },
        h('b', {}, 'Tip: '), 'You can pre-assign leads to specific employees by adding an ',
        h('code', {}, 'assigned_to'),
        ' column with the rep\'s email or full name. Or use Step 2 below to assign in bulk.'
      ),
      fileInput,
      fileInfo,
      filePreview,
      h('p', { style: { marginTop: '1rem' } }, h('a', { href: '/api/sample.csv', download: '' }, '⬇️ Download sample CSV')),
      h('h4', { style: { marginTop: '1.5rem' } }, 'Step 2: how should these leads be assigned?'),
      modePicker,
      singleBody, rrBody, percentBody, csvBody,
      h('div', { class: 'assign-preview-wrap' },
        h('h5', { style: { margin: '1rem 0 .5rem' } }, 'Preview'),
        previewEl
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        importBtn
      )
    )
  );
  document.body.appendChild(modal);
  updateMode();
}
/* ---------------- Spreadsheet parsing (CSV + XLSX) ---------------- */

/** Lazy-load SheetJS only when the user actually opens an Excel file. */
let _xlsxLib = null;
async function ensureXLSX() {
  if (window.XLSX) return window.XLSX;
  if (_xlsxLib) return _xlsxLib;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  _xlsxLib = window.XLSX;
  return _xlsxLib;
}

/** Normalize a column header into a snake_case key (lowercase, spaces+dashes → _). */
function normalizeKey(k) {
  return String(k || '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

/**
 * Clean up a single cell value:
 *  - convert numbers to strings (Excel returns numbers for digit cells)
 *  - strip leading apostrophe (Excel uses ' to force text)
 *  - strip BOM, trim whitespace
 *  - convert scientific-notation phone numbers back to plain digits
 *  - lowercase + trim emails
 */
function cleanCell(key, val) {
  if (val == null) return '';
  if (val instanceof Date && !isNaN(val)) return val.toISOString();
  if (typeof val === 'number') val = String(val);
  let s = String(val).replace(/^﻿/, '').trim();
  s = s.replace(/^'/, '');
  // Scientific notation? Reconstruct (e.g. "9.876543E+9" → "9876543000")
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (!isNaN(n) && isFinite(n)) s = String(n.toFixed(0));
  }
  if (key === 'email') s = s.toLowerCase();
  return s;
}

/**
 * Parse a CSV or XLSX file → array of normalized row objects.
 * Handles BOM, multi-line cells, Excel quirks, scientific-notation phones.
 */
async function parseSpreadsheet(file) {
  const name = (file.name || '').toLowerCase();
  // ---- XLSX / XLS path ----
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) {
    const XLSX = await ensureXLSX();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true, raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, blankrows: false });
    return rows.map(r => {
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        const key = normalizeKey(k);
        out[key] = cleanCell(key, v);
      }
      return out;
    }).filter(r => Object.values(r).some(v => v !== ''));
  }
  // ---- CSV path ----
  let text = await file.text();
  text = text.replace(/^﻿/, ''); // strip UTF-8 BOM (Excel always adds one)
  const rows = parseCSVText(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map(normalizeKey);
  return rows.slice(1).map(line => {
    if (line.every(c => c === '' || c == null)) return null;
    const o = {};
    headers.forEach((h, i) => { o[h] = cleanCell(h, line[i]); });
    return o;
  }).filter(Boolean);
}

/**
 * Full CSV parser — handles quoted multi-line fields, escaped quotes,
 * CRLF or LF line endings. Returns an array of arrays.
 */
function parseCSVText(text) {
  const out = [];
  let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++; // swallow LF after CR
        row.push(cur); cur = '';
        out.push(row); row = [];
      } else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out.filter(r => r.length > 1 || (r[0] && r[0].trim()));
}

// Backwards-compat shim — older code calls parseCSV(text) on already-loaded text
function parseCSV(text) {
  const stripped = String(text || '').replace(/^﻿/, '');
  const rows = parseCSVText(stripped);
  if (rows.length === 0) return [];
  const headers = rows[0].map(normalizeKey);
  return rows.slice(1).map(line => {
    if (line.every(c => c === '' || c == null)) return null;
    const o = {};
    headers.forEach((h, i) => { o[h] = cleanCell(h, line[i]); });
    return o;
  }).filter(Boolean);
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
    field('next_followup_at', 'Next follow-up', isoToLocalDtInput(lead.next_followup_at), { type: 'datetime-local' }),
    field('city', 'City', lead.city),
    field('notes', 'Notes', lead.notes, { type: 'textarea', full: true })
  );

  (customFields || []).forEach(cf => {
    const extra = lead.extra || {};
    form.appendChild(customFieldInput(cf, extra[cf.key]));
  });

  body.appendChild(form);
  if (id) body.appendChild(remarksBlock(remarks, id));
  if (id) body.appendChild(recordingsBlock(id));
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
      tags: fd.get('tags'), next_followup_at: localDtInputToIso(fd.get('next_followup_at')),
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
function parseFieldOptions(raw) {
  // Lenient parser: accept pipe-, comma-, or newline-separated lists.
  // Backwards compatible with existing pipe-separated data.
  return String(raw || '').split(/[|,\n]/).map(s => s.trim()).filter(Boolean);
}
function customFieldInput(cf, val) {
  const name = 'cf_' + cf.key;
  const opts = parseFieldOptions(cf.options);
  let input;
  if (cf.field_type === 'textarea') input = h('textarea', { name }, val || '');
  else if (cf.field_type === 'select') input = h('select', { name },
    h('option', { value: '' }, '—'),
    ...opts.map(o => h('option', { value: o, selected: val === o ? 'selected' : null }, o)));
  else if (cf.field_type === 'multiselect') {
    // Render as a checkbox grid instead of a native <select multiple>.
    // Native multi-select requires Ctrl/Cmd+click and is unusable on touch.
    // FormData.getAll('cf_<key>') still returns the same array of checked values,
    // so the existing save logic at line ~1549 works unchanged.
    const selectedSet = new Set(String(val || '').split(',').map(s => s.trim()).filter(Boolean));
    if (opts.length === 0) {
      input = h('div', { class: 'cf-opts-help' },
        '⚠️ No options defined yet — add some in Admin → Custom fields.');
    } else {
      input = h('div', { class: 'cf-multi-grid' },
        ...opts.map(o => h('label', {},
          h('input', { type: 'checkbox', name, value: o, checked: selectedSet.has(o) ? 'checked' : null }),
          ' ', o
        ))
      );
    }
  }
  else if (cf.field_type === 'checkbox') input = h('input', { type: 'checkbox', name, checked: val ? 'checked' : null, value: '1' });
  else input = h('input', { name, value: val || '', type: cf.field_type === 'number' ? 'number' : cf.field_type === 'date' ? 'date' : 'text' });
  // Long-form fields span both columns in the grid for breathing room.
  const rowClass = (cf.field_type === 'multiselect' || cf.field_type === 'textarea') ? 'f-row full' : 'f-row';
  return h('div', { class: rowClass }, h('label', {}, cf.label + (cf.is_required ? ' *' : '')), input);
}

function recordingsBlock(leadId) {
  const wrap = h('div', { class: 'recordings-block' }, h('h4', {}, '📼 Call recordings'));
  const list = h('ul', { class: 'rec-list' }, h('li', { class: 'muted' }, 'Loading…'));
  wrap.appendChild(list);
  api('api_leads_recordings', leadId).then(rows => {
    list.innerHTML = '';
    if (!rows || rows.length === 0) {
      list.appendChild(h('li', { class: 'muted' }, 'No recordings yet.'));
      return;
    }
    rows.forEach(r => list.appendChild(renderRecordingItem(r)));
  }).catch(e => {
    list.innerHTML = '';
    list.appendChild(h('li', { class: 'muted' }, 'Could not load: ' + e.message));
  });
  return wrap;
}

function renderRecordingItem(r) {
  const dur = Number(r.duration_s) || 0;
  const mm = Math.floor(dur / 60), ss = (dur % 60).toString().padStart(2, '0');
  const dirIcon = r.direction === 'in' ? '📲' : r.direction === 'missed' ? '⚠️' : '📞';
  const audio = h('audio', {
    controls: true,
    preload: 'none',
    src: '/api/recordings/' + r.id + '/audio?token=' + encodeURIComponent(CRM.token || '')
  });
  return h('li', { class: 'rec-item' },
    h('div', { class: 'rec-meta' },
      h('span', { class: 'rec-dir' }, dirIcon),
      h('b', {}, r.lead_name || r.phone || '—'),
      h('span', { class: 'muted' }, ' · ' + fmtDate(r.created_at, 'relative') + ' · ' + mm + ':' + ss)
    ),
    audio
  );
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

/* ---------------- Dialer (TeleCRM-style) ---------------- */
let _dialerState = null;

VIEWS.dialer = async (view) => {
  // Tab state: 'pad' (dialpad) | 'history' (call log) | 'recordings' (audio list)
  _dialerState = { tab: 'pad', digits: '', view };

  view.innerHTML = '';
  const tabs = h('div', { class: 'dialer-tabs' },
    tabBtn('pad', '📟 Dialpad'),
    tabBtn('history', '🕒 History'),
    tabBtn('recordings', '📼 Recordings'),
    tabBtn('settings', '⚙️')
  );
  const body = h('div', { class: 'dialer-body' });
  view.appendChild(h('div', { class: 'dialer-shell' }, tabs, body));

  function tabBtn(id, label) {
    return h('button', {
      class: 'dialer-tab' + (_dialerState.tab === id ? ' active' : ''),
      onclick: () => { _dialerState.tab = id; renderDialerTab(); }
    }, label);
  }

  function renderDialerTab() {
    [...tabs.children].forEach((c, i) => {
      const ids = ['pad', 'history', 'recordings', 'settings'];
      c.classList.toggle('active', _dialerState.tab === ids[i]);
    });
    body.innerHTML = '';
    if (_dialerState.tab === 'pad') body.appendChild(renderDialpad());
    else if (_dialerState.tab === 'history') body.appendChild(renderHistory());
    else if (_dialerState.tab === 'recordings') body.appendChild(renderRecordingsList());
    else body.appendChild(renderDialerSettings());
  }

  renderDialerTab();

  // First-run nudge: if the user hasn't picked a folder yet, gently prompt
  if (window.LeadCRMNative && typeof LeadCRMNative.getRecordingFolder === 'function') {
    try {
      const fld = LeadCRMNative.getRecordingFolder();
      if (!fld && !sessionStorage.getItem('rec_setup_dismissed')) {
        setTimeout(() => {
          if (location.hash === '#/dialer') setupRecordingFolder();
          sessionStorage.setItem('rec_setup_dismissed', '1');
        }, 800);
      }
    } catch (_) {}
  }
};

function renderDialerSettings() {
  const wrap = h('div', { class: 'dialer-settings' });
  const isApp = !!(window.LeadCRMNative && typeof LeadCRMNative.getRecordingFolder === 'function');
  let folder = '';
  try { folder = isApp ? (LeadCRMNative.getRecordingFolder() || '') : ''; } catch (_) {}
  const lastSync = Number(localStorage.getItem('rec_last_sync') || 0);

  if (!isApp) {
    wrap.appendChild(h('div', { class: 'settings-card' },
      h('h4', {}, '📱 Open in the Android app'),
      h('p', { class: 'muted' }, 'Recording sync only works inside the LeadCRM Android app — install it from the Install page.')
    ));
    return wrap;
  }

  // Folder card
  wrap.appendChild(h('div', { class: 'settings-card' },
    h('h4', {}, '📁 Call recordings folder'),
    folder
      ? h('div', {},
          h('div', { class: 'rec-folder-current' }, h('code', {}, folder)),
          h('div', { class: 'muted' }, 'The app reads new files from this folder, parses the phone number, and uploads each recording to the matching lead.'),
          h('div', { class: 'actions' },
            h('button', { class: 'btn primary', onclick: () => syncRecordings() }, '🔄 Sync now'),
            h('button', { class: 'btn', onclick: () => syncRecordings({ full: true }) }, '⚡ Re-sync all'),
            h('button', { class: 'btn ghost', onclick: () => { setupRecordingFolder(); } }, 'Change folder'),
            h('button', { class: 'btn ghost', onclick: () => { if (confirm('Forget folder + clear sync history?')) resetRecordingFolder(); } }, 'Reset')
          ),
          h('div', { class: 'muted', style: { marginTop: '.5rem', fontSize: '.78rem' } },
            h('span', { id: 'sync-progress', style: { fontWeight: 600 } }, ''),
            ' · Last synced: ', lastSync ? fmtDate(new Date(lastSync).toISOString(), 'relative') : 'never'
          )
        )
      : h('div', {},
          h('p', { class: 'muted' }, 'No folder connected yet. Pick the folder where your phone saves call recordings.'),
          h('button', { class: 'btn primary', onclick: () => setupRecordingFolder() }, '📁 Pick recordings folder')
        )
  ));

  // Filter card
  const includeUnmatched = localStorage.getItem('rec_include_unmatched') === '1';
  wrap.appendChild(h('div', { class: 'settings-card' },
    h('h4', {}, '🎯 Sync filter'),
    h('p', { class: 'muted' },
      'By default the app only uploads recordings whose phone number matches a lead in your CRM. ' +
      'Personal calls (family, courier, OTP) are skipped.'),
    h('label', { class: 'toggle-row' },
      h('input', {
        type: 'checkbox',
        checked: includeUnmatched ? 'checked' : null,
        onchange: ev => {
          localStorage.setItem('rec_include_unmatched', ev.target.checked ? '1' : '0');
          toast(ev.target.checked ? 'Will upload all recordings' : 'Lead-only filter active');
        }
      }),
      h('span', {}, 'Include unmatched recordings (upload everything)')
    )
  ));

  // Help card
  wrap.appendChild(h('div', { class: 'settings-card' },
    h('h4', {}, 'ℹ️ How it works'),
    h('ol', { class: 'how-it-works' },
      h('li', {}, 'Enable call recording in your phone\'s dialer (Settings → Phone → Call recording).'),
      h('li', {}, 'Make a call. The phone saves an audio file (e.g. ', h('code', {}, '+91XXXX_2024-04-25.m4a'), ') to its recordings folder.'),
      h('li', {}, 'Open this app and tap ', h('b', {}, 'Sync now'), '. The CRM finds each new file, reads the phone number from the filename, looks up the matching lead, and uploads the recording.'),
      h('li', {}, 'Listen to recordings inside any lead\'s detail page or under ', h('b', {}, 'Recordings'), '.')
    ),
    h('p', { class: 'muted' }, 'Note: the CRM does not record calls itself — that complies with Indian and EU regulations. You (or your phone\'s built-in recorder) control recording.')
  ));

  return wrap;
}

function renderDialpad() {
  const wrap = h('div', { class: 'dialpad-wrap' });

  // Number display + lead-match dropdown
  const display = h('input', {
    type: 'tel',
    class: 'dialpad-display',
    placeholder: 'Enter number or name…',
    value: _dialerState.digits,
    oninput: ev => { _dialerState.digits = ev.target.value; debouncedRenderMatches(); }
  });
  const matches = h('div', { class: 'dialpad-matches' });

  // Debounce so we don't re-filter the lead list on every keystroke
  let _matchTimer = null;
  function debouncedRenderMatches() {
    if (_matchTimer) clearTimeout(_matchTimer);
    _matchTimer = setTimeout(renderMatches, 80);
  }

  function renderMatches() {
    matches.innerHTML = '';
    const q = _dialerState.digits.trim();
    if (!q) return;
    const isDigits = /^[\d+\-\s]+$/.test(q);
    const ql = q.toLowerCase();
    const found = (CRM.cache.lastLeads || []).filter(l => {
      if (isDigits) {
        const d = String(l.phone || '').replace(/\D/g, '');
        return d.includes(q.replace(/\D/g, ''));
      }
      return String(l.name || '').toLowerCase().includes(ql);
    }).slice(0, 6);
    found.forEach(l => matches.appendChild(h('button', {
      class: 'dialpad-match',
      onclick: () => {
        display.value = l.phone || '';
        _dialerState.digits = l.phone || '';
        callLead(l);
      }
    },
      h('div', {}, h('b', {}, l.name || '—')),
      h('div', { class: 'muted' }, l.phone || '')
    )));
    // If no match and digits look like a phone, offer "Save & Call"
    if (found.length === 0 && isDigits && q.replace(/\D/g, '').length >= 6) {
      matches.appendChild(h('button', {
        class: 'dialpad-match new',
        onclick: () => {
          openLeadModal();
          setTimeout(() => {
            const f = $('#lead-form');
            if (f && f.phone) f.phone.value = q;
          }, 150);
        }
      }, '+ Save "' + q + '" as new lead'));
    }
  }

  // Dialpad keys
  const keys = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
    ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
    ['*', ''], ['0', '+'], ['#', '']
  ];
  const grid = h('div', { class: 'dialpad-grid' },
    ...keys.map(([d, sub]) => h('button', {
      class: 'dialpad-key',
      onclick: () => {
        // Long-press on 0 = "+"
        if (d === '0' && _dialerLongPress0) {
          _dialerState.digits += '+';
        } else {
          _dialerState.digits += d;
        }
        display.value = _dialerState.digits;
        debouncedRenderMatches();
      },
      onmousedown: () => { if (d === '0') _dialerLongPress0Timer = setTimeout(() => { _dialerLongPress0 = true; }, 600); },
      onmouseup: () => { clearTimeout(_dialerLongPress0Timer); setTimeout(() => { _dialerLongPress0 = false; }, 50); },
      ontouchstart: () => { if (d === '0') _dialerLongPress0Timer = setTimeout(() => { _dialerLongPress0 = true; }, 600); },
      ontouchend: () => { clearTimeout(_dialerLongPress0Timer); setTimeout(() => { _dialerLongPress0 = false; }, 50); }
    },
      h('span', { class: 'dialpad-d' }, d),
      sub ? h('span', { class: 'dialpad-sub' }, sub) : null
    ))
  );

  const callBtn = h('button', {
    class: 'dialpad-call',
    onclick: () => {
      const raw = _dialerState.digits.trim();
      if (!raw) return toast('Type a number first', 'warn');
      const digits = raw.replace(/\D/g, '');
      // Look up matching lead
      const lead = (CRM.cache.lastLeads || []).find(l =>
        digits && String(l.phone || '').replace(/\D/g, '').endsWith(digits.slice(-10))
      ) || { id: null, name: '', phone: raw };
      callLead(lead);
    }
  }, '📞');

  const back = h('button', {
    class: 'dialpad-back',
    onclick: () => {
      _dialerState.digits = _dialerState.digits.slice(0, -1);
      display.value = _dialerState.digits;
    }
  }, '⌫');

  wrap.appendChild(display);
  wrap.appendChild(matches);
  wrap.appendChild(grid);
  wrap.appendChild(h('div', { class: 'dialpad-actions' }, back, callBtn));
  return wrap;
}
let _dialerLongPress0 = false;
let _dialerLongPress0Timer = null;

function renderHistory() {
  const wrap = h('div', { class: 'dialer-history' }, h('div', { class: 'muted' }, 'Loading call history…'));
  api('api_call_history', 100).then(rows => {
    wrap.innerHTML = '';
    if (!rows || rows.length === 0) {
      wrap.appendChild(h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, 'No calls yet.'));
      return;
    }
    rows.forEach(r => wrap.appendChild(renderHistoryItem(r)));
  }).catch(e => {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'muted' }, 'Could not load: ' + e.message));
  });
  return wrap;
}

function renderHistoryItem(r) {
  const dur = Number(r.duration_s || r.rec_duration) || 0;
  const mm = Math.floor(dur / 60), ss = (dur % 60).toString().padStart(2, '0');
  const dirIcon = r.direction === 'in' ? '📲' :
                  r.event === 'recording_saved' ? '📼' :
                  r.event === 'call_ended' ? '✅' :
                  r.event === 'incoming_ringing' ? '📲' : '📞';
  const item = h('div', { class: 'hist-item' },
    h('div', { class: 'hist-row' },
      h('span', { class: 'hist-icon' }, dirIcon),
      h('div', { class: 'hist-meta' },
        h('div', {}, h('b', {}, r.lead_name || r.phone || 'Unknown')),
        h('div', { class: 'muted' }, (r.lead_name ? r.phone + ' · ' : '') + fmtDate(r.created_at, 'relative') + (dur ? ' · ' + mm + ':' + ss : ''))
      ),
      r.phone ? h('button', {
        class: 'btn icon hist-redial',
        onclick: () => {
          const lead = (CRM.cache.lastLeads || []).find(l =>
            String(l.phone || '').replace(/\D/g, '').endsWith(String(r.phone).replace(/\D/g, '').slice(-10))
          ) || { name: r.lead_name || '', phone: r.phone };
          callLead(lead);
        }
      }, '📞') : null,
      r.lead_id ? h('button', {
        class: 'btn icon',
        title: 'Open lead',
        onclick: () => openLeadModal(r.lead_id)
      }, '📂') : null
    )
  );
  // Inline audio player if there's a recording attached
  if (r.recording_id || r.rec_id) {
    const recId = r.recording_id || r.rec_id;
    item.appendChild(h('audio', {
      controls: true, preload: 'none',
      class: 'hist-audio',
      src: '/api/recordings/' + recId + '/audio?token=' + encodeURIComponent(CRM.token || '')
    }));
  }
  return item;
}

function renderRecordingsList() {
  const wrap = h('div', { class: 'dialer-history' }, h('div', { class: 'muted' }, 'Loading recordings…'));
  api('api_my_recordings', 200).then(rows => {
    wrap.innerHTML = '';
    if (!rows || rows.length === 0) {
      wrap.appendChild(h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, 'No recordings yet.'));
      return;
    }
    rows.forEach(r => wrap.appendChild(renderRecordingItem(r)));
  }).catch(e => {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'muted' }, 'Could not load: ' + e.message));
  });
  return wrap;
}

function refreshDialerHistory() {
  if (!_dialerState || !_dialerState.view) return;
  if (location.hash !== '#/dialer') return;
  // NEVER re-render the whole dialer — that nukes the dialpad input focus
  // and the digits the user is typing. Only refresh the History/Recordings
  // tabs (those don't have user inputs).
  if (_dialerState.tab === 'history') {
    const body = _dialerState.view.querySelector('.dialer-body');
    if (body && typeof renderHistory === 'function') {
      body.innerHTML = '';
      body.appendChild(renderHistory());
    }
  } else if (_dialerState.tab === 'recordings') {
    const body = _dialerState.view.querySelector('.dialer-body');
    if (body && typeof renderRecordingsList === 'function') {
      body.innerHTML = '';
      body.appendChild(renderRecordingsList());
    }
  }
  // Dialpad / Settings tabs intentionally NOT auto-refreshed.
}

/* ---------------- Pipeline ---------------- */
VIEWS.pipeline = async (view) => {
  const [funnel, summary, pipeline] = await Promise.all([
    api('api_reports_funnel', {}),
    api('api_reports_summary', {}),
    api('api_leads_pipeline')
  ]);
  const total = summary.totals.total || 1;
  view.innerHTML = '';

  // Funnel summary card
  view.appendChild(h('div', { class: 'card' },
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
  ));

  // Leads per stage (expandable sections)
  view.appendChild(h('h3', { style: { marginTop: '1.25rem' } }, 'Leads by stage'));
  const wrap = h('div', { class: 'pipeline-stages' });
  view.appendChild(wrap);

  funnel.forEach(s => {
    const entry = pipeline.find(p => Number(p.id) === Number(s.id));
    const leads = entry?.leads || [];
    const details = h('details', { class: 'pipeline-stage-card', style: { borderTopColor: s.color } },
      h('summary', {},
        h('span', { class: 'ps-dot', style: { background: s.color } }),
        h('span', { class: 'ps-name' }, s.name),
        h('span', { class: 'ps-count' }, leads.length),
        h('span', { class: 'ps-hint muted' }, leads.length > 0 ? 'click to expand' : 'no leads')
      ),
      leads.length > 0
        ? h('div', { class: 'ps-body' },
            h('table', { class: 'mini-table' },
              h('thead', {}, h('tr', {},
                h('th', {}, 'Name'), h('th', {}, 'Phone'),
                h('th', {}, 'Source'), h('th', {}, 'Assignee'),
                h('th', {}, 'Follow-up'), h('th', {})
              )),
              h('tbody', {}, ...leads.map(l => h('tr', {},
                h('td', {}, h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(l.id); } }, l.name || '—')),
                h('td', {},
                  l.phone || '',
                  l.phone ? h('button', { class: 'btn icon', title: 'Copy', onclick: () => { navigator.clipboard.writeText(l.phone); toast('Copied'); } }, '📋') : null,
                  l.phone ? h('a', { class: 'btn icon', href: `https://wa.me/${String(l.phone).replace(/\D/g,'')}`, target: '_blank', title: 'WhatsApp' }, '💬') : null
                ),
                h('td', {}, l.source || ''),
                h('td', {}, l.assigned_name || '—'),
                h('td', { class: l.next_followup_at && new Date(l.next_followup_at) < new Date() ? 'overdue' : '' },
                  l.next_followup_at ? fmtDate(l.next_followup_at, 'relative') : '—'),
                h('td', {}, h('button', { class: 'btn sm', onclick: () => openLeadModal(l.id) }, '✎'))
              )))
            )
          )
        : null
    );
    // Auto-expand first non-empty stage
    if (leads.length > 0 && !wrap.querySelector('details[open]')) details.open = true;
    wrap.appendChild(details);
  });
};

/* ---------------- Kanban (drag & drop, stable handlers) ---------------- */
VIEWS.kanban = async (view) => {
  if (!CRM.cache.statuses) await warmCache();
  const statuses = CRM.cache.statuses;
  const kanban = await api('api_leads_pipeline');
  view.innerHTML = '';
  const wrap = h('div', { class: 'kanban' });

  statuses.forEach(s => {
    const col = h('div', { class: 'kanban-col' });
    col.dataset.statusId = s.id;

    // Use addEventListener so handlers survive and stopPropagation works
    col.addEventListener('dragover', ev => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      col.classList.add('drop-hover');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop-hover'));
    col.addEventListener('drop', async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      col.classList.remove('drop-hover');
      const leadId = Number(ev.dataTransfer.getData('text/plain') || ev.dataTransfer.getData('application/lead-id'));
      if (!leadId) return;
      const newStatusId = Number(col.dataset.statusId);
      try {
        await api('api_leads_update', leadId, { status_id: newStatusId });
        toast('Status updated');
        navigateTo('kanban');
      } catch (e) { toast(e.message, 'err'); }
    });

    col.appendChild(h('h4', { class: 'kanban-head', style: { borderTopColor: s.color } },
      h('span', {}, s.name),
      h('span', { class: 'kanban-count' }, (kanban.find(k => Number(k.id) === Number(s.id))?.leads || []).length)
    ));

    (kanban.find(k => Number(k.id) === Number(s.id))?.leads || []).forEach(l => {
      const card = h('div', { class: 'kanban-card', draggable: 'true' });
      card.dataset.leadId = l.id;
      card.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('text/plain', String(l.id));
        ev.dataTransfer.setData('application/lead-id', String(l.id));
        ev.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('click', ev => {
        // Only open modal on click, not after drag
        if (!card.classList.contains('was-dragged')) openLeadModal(l.id);
      });
      card.append(
        h('div', { class: 'kc-name' }, l.name || '—'),
        h('div', { class: 'kc-meta' }, (l.phone || ''), l.source ? ' · ' + l.source : ''),
        l.next_followup_at ? h('div', { class: 'kc-fu' }, '⏰ ' + fmtDate(l.next_followup_at, 'relative')) : null
      );
      col.appendChild(card);
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
      h('thead', {}, h('tr', {},
        h('th', {}, 'Lead'),
        h('th', {}, 'Phone'),
        h('th', {}, 'Due'),
        h('th', {}, 'Latest remark'),
        h('th', {}, 'Note'),
        h('th', { style: { textAlign: 'right' } }, 'Actions')
      )),
      h('tbody', {}, ...rows.map(r => {
        const phone = String(r.lead_phone || '').trim();
        const telHref = phone ? 'tel:' + phone.replace(/[^\d+]/g, '') : null;
        const waHref  = phone ? 'https://wa.me/' + phone.replace(/[^\d]/g, '') : null;
        return h('tr', {},
          h('td', {},
            h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(r.lead_id); } }, r.lead_name || '—')
          ),
          h('td', {}, phone || ''),
          h('td', { class: klass === 'err' ? 'overdue' : '' }, fmtDate(r.due_at)),
          h('td', { class: 'fu-latest-remark', title: r.latest_remark || '' },
            r.latest_remark
              ? h('span', {}, String(r.latest_remark).slice(0, 120) + (String(r.latest_remark).length > 120 ? '…' : ''))
              : h('span', { class: 'muted' }, '—')
          ),
          h('td', { class: 'muted' }, r.note || ''),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            telHref ? h('a', { class: 'btn sm primary', href: telHref, title: 'Call ' + phone }, '📞 Call') : null,
            waHref  ? h('a', { class: 'btn sm ghost', href: waHref, target: '_blank', rel: 'noopener',
              style: { marginLeft: '.3rem' }, title: 'WhatsApp' }, '💬') : null,
            h('button', { class: 'btn sm', style: { marginLeft: '.3rem' },
              onclick: () => openLeadModal(r.lead_id), title: 'Open lead' }, '✎'),
            r.id ? h('button', { class: 'btn sm', style: { marginLeft: '.3rem' },
              onclick: async () => {
                try { await api('api_followup_done', r.id); toast('Marked done'); navigateTo('followups'); }
                catch (e) { toast(e.message, 'err'); }
              }
            }, '✓ Done') : null
          )
        );
      }))
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
  if (!window.Chart) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  // Also load chartjs-plugin-datalabels so we can render the actual numeric
  // value on top of every bar / segment (the user wants numbers visible, not
  // just bars). Register globally so every chart picks it up.
  if (window.Chart && !window.ChartDataLabels) {
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
      if (window.ChartDataLabels && Chart && Chart.register) Chart.register(window.ChartDataLabels);
    } catch (_) { /* non-fatal: charts still render, just without labels */ }
  }
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
    h('div', { class: 'card card-wide' }, h('h3', {}, 'Lead funnel'), h('div', { id: 'chart-funnel-wrap', class: 'rfun-wrap' })),
    h('div', { class: 'card card-wide' },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem', flexWrap: 'wrap', gap: '.5rem' } },
        h('h3', { style: { margin: 0 } }, 'By date'),
        h('button', { class: 'btn sm ghost', id: 'rep-daily-csv', title: 'Download daily breakdown as CSV' }, '⬇️ CSV')
      ),
      h('div', { class: 'chart-wrap', style: { height: '220px' } }, h('canvas', { id: 'chart-daily' })),
      h('div', { id: 'rep-daily-table', style: { marginTop: '1rem' } })
    ),
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
  // Pass the SAME filter object to every endpoint so charts and tables agree.
  const filters = { from, to, scope_user_id: user, role, product_id, source, tag };
  const [summary, funnel, daily] = await Promise.all([
    api('api_reports_summary', filters),
    api('api_reports_funnel',  filters),
    api('api_reports_daily',   filters)
  ]);

  $('#rep-cards').innerHTML = '';
  [['Total', summary.totals.total, 'accent'], ['New', summary.totals.new_leads, ''], ['Won', summary.totals.won, 'ok'], ['Lost', summary.totals.lost, 'err']].forEach(([label, val, klass]) => {
    $('#rep-cards').appendChild(h('div', { class: `card stat ${klass}` },
      h('div', { class: 'stat-body' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, val || 0))
    ));
  });

  // "By status" is now a bar chart with visible numbers — easier to read and
  // compare than a doughnut, especially with many statuses.
  makeChart('chart-status', 'bar',
    (summary.by_status || []).map(x => x.status),
    (summary.by_status || []).map(x => x.c),
    (summary.by_status || []).map(x => x.color));
  makeChart('chart-source', 'bar',
    (summary.by_source || []).map(x => x.source),
    (summary.by_source || []).map(x => x.c));
  // Funnel: replaced the horizontal-bar chart with a true funnel visual
  // (decreasing-width rows showing both count and conversion-from-top %).
  renderFunnel('chart-funnel-wrap', funnel);

  // ---------- "By date" — daily breakdown chart + table ----------
  renderDailyBreakdown(daily, filters);

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

/**
 * Renders the daily breakdown: a multi-line chart (Total / New / Won / Lost
 * per day) AND a sortable table below so users can read the exact numbers.
 *
 * Most users want to see "how many leads did we get on each day" alongside
 * the rolled-up totals — without this they have to eyeball the chart and
 * miss small differences between days.
 */
function renderDailyBreakdown(daily, filters) {
  const tableEl = $('#rep-daily-table');
  if (!tableEl) return;

  // Empty state
  if (!daily || daily.length === 0) {
    tableEl.innerHTML = '<p class="muted">No leads in the selected range.</p>';
    const ctx = document.getElementById('chart-daily');
    if (ctx && ctx._chart) { ctx._chart.destroy(); ctx._chart = null; }
    return;
  }

  // Multi-line chart: Total + New + Won + Lost per day
  const labels = daily.map(d => formatDayLabel(d.date));
  const ctx = document.getElementById('chart-daily');
  if (ctx) {
    if (ctx._chart) ctx._chart.destroy();
    ctx._chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Total', data: daily.map(d => d.total),     borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.1)', tension: .25, fill: true },
          { label: 'New',   data: daily.map(d => d.new_leads), borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,.05)', tension: .25 },
          { label: 'Won',   data: daily.map(d => d.won),       borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.05)', tension: .25 },
          { label: 'Lost',  data: daily.map(d => d.lost),      borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.05)',  tension: .25 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
          // Multi-line chart with 4 datasets → labelling every point would
          // overwhelm. Keep numbers visible via the table below + tooltip.
          datalabels: false
        },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: '#f3f4f6' }, beginAtZero: true, ticks: { stepSize: 1, precision: 0 } }
        },
        interaction: { mode: 'index', intersect: false }
      }
    });
  }

  // Detailed table — one row per day, with totals row at the bottom
  const totals = daily.reduce((a, d) => ({
    total: a.total + d.total,
    new_leads: a.new_leads + d.new_leads,
    open: a.open + d.open,
    won: a.won + d.won,
    lost: a.lost + d.lost
  }), { total: 0, new_leads: 0, open: 0, won: 0, lost: 0 });

  tableEl.innerHTML = '';
  tableEl.appendChild(h('div', { class: 'table-wrap', style: { maxHeight: '420px', overflowY: 'auto' } },
    h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Date'), h('th', { style: { textAlign: 'right' } }, 'Total'),
        h('th', { style: { textAlign: 'right' } }, 'New'), h('th', { style: { textAlign: 'right' } }, 'Open'),
        h('th', { style: { textAlign: 'right' } }, 'Won'), h('th', { style: { textAlign: 'right' } }, 'Lost')
      )),
      h('tbody', {}, ...daily.map(d => h('tr', {},
        h('td', {}, formatDayLabel(d.date)),
        h('td', { style: { textAlign: 'right' } }, d.total),
        h('td', { style: { textAlign: 'right' } }, d.new_leads),
        h('td', { style: { textAlign: 'right' } }, d.open),
        h('td', { class: 'cell-ok',  style: { textAlign: 'right' } }, d.won),
        h('td', { class: 'cell-err', style: { textAlign: 'right' } }, d.lost)
      ))),
      h('tfoot', {}, h('tr', { style: { fontWeight: 700, background: '#f9fafb' } },
        h('td', {}, 'Total'),
        h('td', { style: { textAlign: 'right' } }, totals.total),
        h('td', { style: { textAlign: 'right' } }, totals.new_leads),
        h('td', { style: { textAlign: 'right' } }, totals.open),
        h('td', { style: { textAlign: 'right' } }, totals.won),
        h('td', { style: { textAlign: 'right' } }, totals.lost)
      ))
    )
  ));

  // CSV download — quick win for users who want to paste into Excel/Sheets
  const csvBtn = $('#rep-daily-csv');
  if (csvBtn) {
    csvBtn.onclick = () => {
      const lines = ['Date,Total,New,Open,Won,Lost'];
      daily.forEach(d => lines.push([d.date, d.total, d.new_leads, d.open, d.won, d.lost].join(',')));
      lines.push(['Total', totals.total, totals.new_leads, totals.open, totals.won, totals.lost].join(','));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'daily-report-' + (filters.from || daily[0].date) + '_to_' + (filters.to || daily[daily.length - 1].date) + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  }
}

function formatDayLabel(iso) {
  // Compact format matching the existing date pattern in remarks/dates.
  // "2026-04-25" → "25 Apr"
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/**
 * Render a CSS-based lead funnel into the given container.
 *
 * Each stage is a colored, rounded "bar" whose width is proportional to the
 * count, centered on the page (so it visually narrows like a real funnel).
 * Shows: stage label · absolute count · % of the top stage (conversion rate).
 *
 * Replaces the old horizontal Chart.js bar — which was indistinguishable from
 * a regular bar chart — with a more traditional funnel design that makes
 * stage-to-stage drop-off obvious at a glance.
 */
function renderFunnel(containerId, stages) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!stages || !stages.length) {
    wrap.innerHTML = '<p class="muted">No funnel data for this period.</p>';
    return;
  }
  const max = Math.max(...stages.map(s => Number(s.count) || 0), 1);
  const top = Number(stages[0]?.count) || 0;
  stages.forEach((s, i) => {
    const c = Number(s.count) || 0;
    const widthPct = max > 0 ? Math.max(8, Math.round((c / max) * 100)) : 8;
    const convPct  = top > 0 ? Math.round((c / top) * 100) : 0;
    // Layout: [centering track] [conv % meta]. The bar lives inside the track
    // and gets a percentage width so each subsequent stage is narrower —
    // visually a real funnel.
    const row = h('div', { class: 'rfun-row' },
      h('div', { class: 'rfun-track' },
        h('div', { class: 'rfun-bar', style: { width: widthPct + '%', background: s.color || '#6366f1' } },
          h('span', { class: 'rfun-label' }, s.name),
          h('span', { class: 'rfun-count' }, String(c))
        )
      ),
      h('div', { class: 'rfun-meta muted' }, i === 0 ? '100%' : (convPct + '%'))
    );
    wrap.appendChild(row);
  });
}

function makeChart(canvasId, type, labels, data, colors, extra) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (ctx._chart) ctx._chart.destroy();
  const palette = colors && colors.some(Boolean) ? colors : ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'];

  const isHorizontalBar = (extra && extra.indexAxis === 'y');
  const isPieish = type === 'doughnut' || type === 'pie';

  // Datalabel config — render the numeric value on each bar/segment so the
  // user can read the actual numbers, not just the relative bar height.
  // We only attach datalabels if the plugin is loaded (it's loaded in
  // ensureChartJs but kept best-effort).
  const datalabels = window.ChartDataLabels ? {
    color: isPieish ? '#ffffff' : '#1B233A',
    font: { weight: 'bold', size: 11 },
    formatter: (value) => {
      if (value === 0 || value === null || value === undefined) return '';
      return value;
    },
    anchor: isPieish ? 'center' : (isHorizontalBar ? 'end' : 'end'),
    align:  isPieish ? 'center' : (isHorizontalBar ? 'right' : 'top'),
    offset: 2,
    clamp: true
  } : false;

  const baseOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: isPieish ? 'bottom' : 'top' },
      datalabels
    },
    scales: isPieish ? {} : { x: { grid: { display: false } }, y: { grid: { color: '#f3f4f6' }, beginAtZero: true } }
  };

  // Merge extra options without clobbering our plugins.datalabels block:
  // Object.assign with a top-level `extra` whose `plugins` would replace ours.
  const merged = Object.assign({}, baseOpts, extra || {});
  if (extra && extra.plugins) {
    merged.plugins = Object.assign({}, baseOpts.plugins, extra.plugins);
  }
  if (extra && extra.scales) {
    merged.scales = Object.assign({}, baseOpts.scales, extra.scales);
  }

  ctx._chart = new Chart(ctx, {
    type, data: {
      labels, datasets: [{
        data,
        backgroundColor: labels.map((_, i) => palette[i % palette.length]),
        borderWidth: 0,
        // For line charts (e.g. daily breakdown) Chart.js wants these too:
        borderColor: palette[0],
        pointBackgroundColor: palette[0],
        tension: 0.25
      }]
    },
    options: merged
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
    { id: 'permissions',  label: '🔐 Permissions' },
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
    if (id === 'permissions') body.replaceChildren(await adminPermissions());
    if (id === 'duplicates') body.replaceChildren(await adminDuplicates());
    if (id === 'smtp')     body.replaceChildren(await adminSmtp());
  } catch (e) { body.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}

async function adminCompany() {
  const cfg = await api('api_admin_getConfig');
  const wrap = h('div', {});

  // ---- Brand identity card ----
  const card = h('div', { class: 'card brand-card' },
    h('h4', {}, '🎨 Company branding'),
    h('p', { class: 'muted' }, 'Your brand name and logo show up on the login screen, the sidebar, the topbar, and the Android app icon area.')
  );
  wrap.appendChild(card);

  // Live preview
  const previewLogo = h('div', { class: 'brand-logo-preview' });
  function setPreview(url) {
    previewLogo.innerHTML = '';
    if (url) {
      const img = h('img', { src: url, alt: 'logo' });
      img.onerror = () => { previewLogo.innerHTML = '<span class="muted">⚠️ Could not load image</span>'; };
      previewLogo.appendChild(img);
    } else {
      previewLogo.appendChild(h('span', { class: 'brand-fallback' }, '🎯'));
    }
  }
  setPreview(cfg.COMPANY_LOGO_URL);

  // Name input
  const nameInput = h('input', { type: 'text', value: cfg.COMPANY_NAME || 'Lead CRM', placeholder: 'e.g. Acme CRM' });

  card.appendChild(h('div', { class: 'brand-row' },
    h('div', { class: 'brand-logo-col' },
      h('label', {}, 'Logo'),
      previewLogo,
      h('div', { class: 'actions' },
        h('label', { class: 'btn primary brand-upload-btn' },
          '📤 Upload logo',
          h('input', {
            type: 'file', accept: 'image/png,image/jpeg,image/svg+xml,image/webp',
            style: { display: 'none' },
            onchange: async ev => {
              const f = ev.target.files[0];
              if (!f) return;
              if (f.size > 1.5 * 1024 * 1024) { toast('Logo too large — please use an image under 1.5 MB', 'warn'); return; }
              const dataUrl = await new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(r.result); r.onerror = reject;
                r.readAsDataURL(f);
              });
              try {
                await api('api_admin_uploadLogo', { data_url: dataUrl });
                setPreview(dataUrl);
                CRM.config.company_logo_url = dataUrl;
                // Refresh sidebar + topbar logos in real time
                document.querySelectorAll('img.sidebar-logo, img.login-logo, .brand-img').forEach(i => i.src = dataUrl);
                toast('Logo updated');
              } catch (e) { toast(e.message, 'err'); }
            }
          })
        ),
        cfg.COMPANY_LOGO_URL
          ? h('button', {
              class: 'btn ghost', onclick: async () => {
                if (!await confirmDialog('Remove the company logo? The 🎯 default icon will be used.')) return;
                try {
                  await api('api_admin_clearLogo');
                  setPreview('');
                  CRM.config.company_logo_url = '';
                  document.querySelectorAll('img.sidebar-logo, img.login-logo').forEach(i => i.remove());
                  toast('Logo removed');
                } catch (e) { toast(e.message, 'err'); }
              }
            }, '🗑️ Remove')
          : null
      ),
      h('p', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.4rem' } },
        'Recommended: square PNG, 256×256 to 512×512, transparent background. Max 1.5 MB.'
      )
    ),
    h('div', { class: 'brand-name-col' },
      h('label', {}, 'Company name *'),
      nameInput,
      h('p', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.3rem' } },
        'Shown on the login screen, sidebar, and emails.'
      ),
      h('div', { class: 'actions', style: { marginTop: '1rem' } },
        h('button', { class: 'btn primary', onclick: async () => {
          const newName = nameInput.value.trim();
          if (!newName) return toast('Name cannot be empty', 'warn');
          try {
            await api('api_admin_setConfig', { COMPANY_NAME: newName });
            CRM.config.company_name = newName;
            document.title = newName;
            const brandSpan = document.querySelector('.brand-name');
            if (brandSpan) brandSpan.textContent = newName;
            toast('Saved');
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Save name')
      )
    )
  ));

  // ---- Advanced: paste a URL instead of uploading ----
  wrap.appendChild(h('details', { class: 'card brand-advanced' },
    h('summary', {}, 'Advanced — paste a logo URL instead of uploading'),
    h('p', { class: 'muted' }, 'If you host your logo elsewhere (e.g. on a CDN), you can paste the URL here.'),
    configForm(cfg, ['COMPANY_LOGO_URL'])
  ));

  return wrap;
}

/* ---- Website API / sample CSV ---- */
async function adminApi() {
  const cfg = await api('api_admin_getConfig');
  const origin = location.origin;
  const apiKey = cfg.WEBSITE_API_KEY || '';
  const card = h('div', {});

  function rebuildCurl(key) {
    return `curl -X POST '${origin}/hook/website' \\\n  -H 'x-api-key: ${key || '<your-api-key>'}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name":"John Doe","phone":"+911234567890","email":"john@example.com","source":"Website","notes":"Demo request"}'`;
  }

  const keyEl = h('code', { id: 'admin-api-key' }, apiKey || '(not generated yet)');
  const curlEl = h('pre', { class: 'code-block', id: 'admin-curl' }, rebuildCurl(apiKey));

  async function regenerate() {
    if (!confirm('Generate a new API key? Anyone using the old key will stop working until you update them.')) return;
    try {
      const r = await api('api_admin_regenerateApiKey');
      keyEl.textContent = r.key;
      curlEl.textContent = rebuildCurl(r.key);
      toast('New API key generated');
    } catch (e) { toast(e.message, 'err'); }
  }

  card.appendChild(h('div', { class: 'card' },
    h('h4', {}, '🌐 Website lead API'),
    h('p', { class: 'muted' }, 'Send leads from your website, landing page or any external system by POSTing to this endpoint. Leads go straight into the CRM and trigger your auto-assign rules + automations.'),
    h('div', { class: 'api-endpoint' },
      h('code', {}, origin + '/hook/website'),
      h('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(origin + '/hook/website'); toast('URL copied'); } }, 'Copy URL')
    ),
    h('h5', {}, 'API key'),
    h('div', { class: 'api-endpoint' },
      keyEl,
      h('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(keyEl.textContent); toast('Key copied'); } }, 'Copy'),
      h('button', { class: 'btn sm', onclick: regenerate }, '🔄 Regenerate')
    ),
    h('p', { class: 'muted' }, 'Keep this key secret. If it ever leaks, click Regenerate to invalidate the old one. You can also set it manually below.'),
    configForm(cfg, ['WEBSITE_API_KEY']),
    h('h5', {}, 'Try it — cURL'),
    curlEl,
    h('p', { style: { marginTop: '.75rem' } },
      h('a', { href: '/api-docs', target: '_blank', class: 'btn primary' }, '📖 View full API documentation →')
    ),
    h('p', { class: 'muted' }, 'Includes JS, PHP, Python, WordPress, HTML form examples + how to send tags/labels.'),
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
        h('div', { class: 'f-row full', id: 'auto-subject-row' },
          h('label', {}, 'Email subject (email only)'),
          h('input', { name: 'subject', value: a.subject || '', placeholder: 'New lead: {{lead.name}}' })
        ),
        h('div', { class: 'f-row full', id: 'auto-wa-template-row', hidden: true },
          h('label', {}, 'WhatsApp template (from Meta)'),
          h('div', { class: 'toolbar' },
            h('select', { id: 'wa-template-select', style: { flex: 1 } },
              h('option', { value: '' }, '— free-form text (session message, 24h window) —')
            ),
            h('button', { type: 'button', class: 'btn', onclick: loadWATemplates }, '🔄 Refresh')
          ),
          h('small', { class: 'muted' }, 'Pick an APPROVED template to send outside the 24h window. For a template with {{1}}, {{2}} body params, list them pipe-separated in the Template field below, e.g. "{{lead.name}}|{{lead.phone}}".')
        ),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Template / body (supports {{lead.name}}, {{lead.phone}}, {{lead.status_name}}, {{user.name}}, {{new_status.name}}, {{date}})'),
          h('textarea', { name: 'template', rows: 5, placeholder: 'Hi {{lead.name}}, your status is now {{new_status.name}}. We\'ll get back to you shortly.' }, a.template || '')
        )
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const f = $('#auto-form');
          let subject = f.subject.value;
          const waSel = $('#wa-template-select');
          if (f.channel.value === 'whatsapp' && waSel && waSel.value) {
            const opt = waSel.options[waSel.selectedIndex];
            subject = 'template:' + waSel.value + ':' + (opt.dataset.lang || 'en_US');
          }
          const payload = { id: a.id,
            name: f.name.value, event: f.event.value, channel: f.channel.value,
            recipient: f.recipient.value, condition: f.condition.value,
            subject, template: f.template.value, is_active: 1 };
          try { await api('api_automations_save', payload); toast('Saved'); modal.remove(); showAdminTab('automations'); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(modal);
  // Wire channel change to reveal/hide subject vs WA template row
  const chSel = modal.querySelector('select[name="channel"]');
  if (chSel) chSel.addEventListener('change', () => toggleChannelUI(chSel.value));
  toggleChannelUI(a.channel);
  // Pre-fill WA template dropdown on edit
  if (a.channel === 'whatsapp' && String(a.subject || '').startsWith('template:')) {
    loadWATemplates().then(() => {
      const parts = a.subject.split(':');
      const sel = $('#wa-template-select');
      if (sel) sel.value = parts[1] || '';
    });
  }
}

function toggleChannelUI(channel) {
  const sub = $('#auto-subject-row');
  const wa  = $('#auto-wa-template-row');
  if (sub) sub.hidden = channel !== 'email';
  if (wa)  wa.hidden  = channel !== 'whatsapp';
  if (channel === 'whatsapp') loadWATemplates();
}

async function loadWATemplates() {
  const sel = $('#wa-template-select');
  if (!sel) return;
  // Preserve existing selection
  const current = sel.value;
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const { templates, error } = await api('api_whatsapp_templates');
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '' }, '— free-form text (session message, 24h window) —'));
    if (error) {
      sel.appendChild(h('option', { value: '', disabled: true }, 'Error: ' + error));
      return;
    }
    if (!templates.length) {
      sel.appendChild(h('option', { value: '', disabled: true }, 'No templates — add WABA ID + token in Settings → WhatsApp'));
      return;
    }
    templates.forEach(t => {
      const label = `${t.name} (${t.language}${t.body_params ? ', ' + t.body_params + ' params' : ''}) — ${t.status}`;
      sel.appendChild(h('option', { value: t.name, 'data-lang': t.language }, label));
    });
    if (current) sel.value = current;
  } catch (e) {
    sel.innerHTML = '<option value="" disabled>Error: ' + e.message + '</option>';
  }
}
async function adminFb() {
  // Pull live state — settings, status, page list, lookup data for the dropdowns.
  const [settings, status, pages, sources, statuses, users] = await Promise.all([
    api('api_fb_settings_get').catch(e => { console.warn(e); return {}; }),
    api('api_fb_status').catch(() => ({ connected: false })),
    api('api_fb_pages_list').catch(() => []),
    api('api_sources_list').catch(() => []),
    api('api_statuses_list').catch(() => []),
    api('api_users_list').catch(() => [])
  ]);

  // Preload the FB SDK so when the user clicks "Connect with Facebook",
  // FB.login() runs synchronously inside the click event and the browser
  // allows the popup. If the SDK only loads on click, Chrome blocks the
  // popup because the user gesture has already expired.
  if (settings && settings.app_id) {
    ensureFbSdkLoaded(settings.app_id).catch(e => console.warn('FB SDK preload:', e.message));
  }

  const wrap = h('div', { class: 'fb-admin' });
  wrap.appendChild(h('h3', { style: { margin: '0 0 1rem' } }, 'Facebook Leads Integration'));

  // ============ 1. Application Settings ============
  const appCard = h('div', { class: 'card' });
  appCard.appendChild(h('h4', { style: { marginTop: 0 } }, 'Facebook Application Settings'));
  const appForm = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('api_fb_settings_set', {
        app_id: fd.get('app_id'),
        app_secret: fd.get('app_secret')   // empty = leave existing untouched
      });
      toast('Application settings saved');
      showAdminTab('fb');
    } catch (e) { toast(e.message, 'err'); }
  }});
  appForm.appendChild(h('div', { class: 'f-row full' },
    h('label', {}, 'Facebook Application ID'),
    h('input', { name: 'app_id', value: settings.app_id || '', placeholder: 'e.g. 1234567890123456' })
  ));
  appForm.appendChild(h('div', { class: 'f-row full' },
    h('label', {}, 'Facebook Application Secret',
      settings.app_secret_present ? h('span', { class: 'muted', style: { fontSize: '.75rem', marginLeft: '.4rem' } }, '(saved — leave blank to keep)') : null
    ),
    h('input', { name: 'app_secret', type: 'password', autocomplete: 'new-password',
      placeholder: settings.app_secret_present ? '••••••••••••••' : 'paste from Meta App Dashboard' })
  ));
  appForm.appendChild(h('div', { class: 'f-row full' },
    h('button', { type: 'submit', class: 'btn primary' }, '💾 Save application settings')
  ));
  appCard.appendChild(appForm);
  wrap.appendChild(appCard);

  // ============ 2. Module Settings ============
  const modCard = h('div', { class: 'card' });
  modCard.appendChild(h('h4', { style: { marginTop: 0 } }, 'Module Settings'));
  const modForm = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('api_fb_settings_set', {
        verify_token:      fd.get('verify_token'),
        default_user_id:   fd.get('default_user_id'),
        default_source:    fd.get('default_source'),
        default_status_id: fd.get('default_status_id')
      });
      toast('Module settings saved');
    } catch (e) { toast(e.message, 'err'); }
  }});
  modForm.appendChild(h('div', { class: 'f-row full' },
    h('label', {}, 'Webhook Verify Token ',
      h('span', { class: 'muted', style: { fontWeight: 'normal' } }, '(you can change this if you want)')),
    h('input', { name: 'verify_token', value: settings.verify_token || '',
      placeholder: 'e.g. token654321 — paste this same value into Meta → Webhooks → Verify Token' })
  ));
  modForm.appendChild(h('div', { class: 'f-row full', style: { marginTop: '.5rem' } },
    h('label', {}, 'Select an operator / source / status for leads that will be captured:')
  ));
  // Three dropdowns side-by-side (matching the screenshot)
  const trio = h('div', { class: 'fb-trio' },
    h('select', { name: 'default_user_id' },
      h('option', { value: '' }, '— Use assignment rules —'),
      ...users.map(u => h('option', {
        value: u.id,
        selected: String(u.id) === String(settings.default_user_id) ? 'selected' : null
      }, u.name + (u.role ? ' (' + u.role + ')' : '')))
    ),
    h('select', { name: 'default_source' },
      ...['Facebook', 'Facebook Lead Ad', 'Instagram', 'Meta Ads', ...sources.map(s => s.name)]
        .filter((v, i, a) => v && a.indexOf(v) === i)   // dedupe
        .map(s => h('option', {
          value: s,
          selected: s === (settings.default_source || 'Facebook') ? 'selected' : null
        }, s))
    ),
    h('select', { name: 'default_status_id' },
      h('option', { value: '' }, '— Default New —'),
      ...statuses.map(s => h('option', {
        value: s.id,
        selected: String(s.id) === String(settings.default_status_id) ? 'selected' : null
      }, s.name))
    )
  );
  modForm.appendChild(h('div', { class: 'f-row full' }, trio));
  // Webhook URL display (read-only)
  modForm.appendChild(h('div', { class: 'f-row full', style: { marginTop: '.5rem' } },
    h('label', {}, 'Your unique webhook callback URL is:'),
    h('input', { value: location.origin + '/hook/meta', readonly: 'readonly',
      style: { background: '#f1f5f9', fontFamily: 'monospace', cursor: 'text' },
      onclick: ev => ev.target.select() })
  ));
  modForm.appendChild(h('div', { class: 'f-row full' },
    h('button', { type: 'submit', class: 'btn primary' }, '💾 Save module settings')
  ));
  modCard.appendChild(modForm);
  wrap.appendChild(modCard);

  // ============ 3. Pages list ============
  const pagesCard = h('div', { class: 'card' });
  pagesCard.appendChild(h('h4', { style: { marginTop: 0 } }, 'Fetch / relist Facebook pages'));
  const pagesToolbar = h('div', { class: 'toolbar', style: { marginBottom: '.75rem' } });

  // "Connect with Facebook" — only shown when not connected.
  // Uses the SERVER-SIDE OAuth flow now (no popup, no SDK, no permission needed).
  if (!status.connected) {
    pagesToolbar.appendChild(
      h('button', { class: 'btn primary', onclick: connectFacebookServerFlow }, '🔗 Connect with Facebook')
    );
    pagesToolbar.appendChild(h('span', { class: 'muted', style: { fontSize: '.85rem' } },
      'You\'ll be redirected to facebook.com to log in. Pick which pages to monitor here when you return.'
    ));
  } else {
    pagesToolbar.appendChild(
      h('button', { class: 'btn primary', onclick: async () => {
        try { const r = await api('api_fb_pages_refetch'); toast('Found ' + r.count + ' pages'); showAdminTab('fb'); }
        catch (e) { toast(e.message, 'err'); }
      } }, '🔄 Fetch Facebook Pages')
    );
    pagesToolbar.appendChild(
      h('button', { class: 'btn ghost', onclick: connectFacebookServerFlow }, '🔁 Re-login (different account)')
    );
    pagesToolbar.appendChild(
      h('button', { class: 'btn ghost', onclick: async () => {
        if (!await confirmDialog('Disconnect Facebook? This will unsubscribe all monitored pages.')) return;
        try { await api('api_fb_disconnect'); toast('Disconnected'); showAdminTab('fb'); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Disconnect')
    );
  }
  pagesCard.appendChild(pagesToolbar);

  // Show a flash message if we just came back from a server-side OAuth callback.
  // The callback redirects us with ?fb=<status> in the URL; surface it as a toast.
  try {
    const flash = new URLSearchParams(location.search).get('fb');
    if (flash) {
      if (flash.startsWith('connected:')) {
        const n = flash.split(':')[1];
        toast(`Connected — ${n} page${n === '1' ? '' : 's'} fetched. Pick which to monitor below.`);
      } else if (flash.startsWith('error:')) {
        toast(decodeURIComponent(flash), 'err');
      }
      history.replaceState({}, '', location.pathname + location.hash);
    }
  } catch (_) { /* ignore */ }

  // ---- Manual page registration (no OAuth) ----
  // Lets the admin paste a Page ID + a Page Access Token they obtained from
  // Graph API Explorer or a System User in Business Manager. Bypasses the
  // entire OAuth dance — useful when the app isn't approved for
  // business_management yet, or for never-expiring System User tokens.
  pagesCard.appendChild(h('details', { class: 'fb-manual-add', style: { marginTop: '1rem' } },
    h('summary', { style: { cursor: 'pointer', fontWeight: 600, color: 'var(--brand)' } },
      '➕ Add a page manually (no OAuth — paste a Page Access Token)'),
    h('div', { style: { marginTop: '.75rem' } },
      h('p', { class: 'muted', style: { fontSize: '.85rem', marginBottom: '.5rem' } },
        'Skip the Facebook login flow. Get a Page Access Token from ',
        h('a', { href: 'https://developers.facebook.com/tools/explorer/', target: '_blank', style: { color: 'var(--brand)' } }, 'Graph API Explorer'),
        ' (select your app → Get Token → User Token → grant pages_show_list, pages_manage_metadata, leads_retrieval, pages_read_engagement → then click "Get Page Access Token" and pick the page) — or generate one in Business Manager → System Users.'),
      h('form', { class: 'form-grid', onsubmit: async ev => {
        ev.preventDefault();
        const f = ev.target;
        const submitBtn = f.querySelector('button[type=submit]');
        submitBtn.disabled = 'disabled'; submitBtn.textContent = 'Validating…';
        try {
          const r = await api('api_fb_pages_addManual', {
            page_id: f.page_id.value.trim(),
            page_access_token: f.page_access_token.value.trim(),
            page_name: f.page_name.value.trim()
          });
          toast(`Added ${r.page.page_name} — now monitoring leadgen.`);
          showAdminTab('fb');
        } catch (e) {
          toast(e.message, 'err');
        } finally {
          submitBtn.disabled = null; submitBtn.textContent = 'Validate & add page';
        }
      }},
        h('div', { class: 'f-row' },
          h('label', {}, 'Page ID *'),
          h('input', { name: 'page_id', placeholder: 'e.g. 100012345678901', required: true,
            style: { fontFamily: 'monospace' } })
        ),
        h('div', { class: 'f-row' },
          h('label', {}, 'Page name (optional)'),
          h('input', { name: 'page_name', placeholder: 'auto-detected if blank' })
        ),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Page Access Token *'),
          h('textarea', { name: 'page_access_token', rows: '3', required: true,
            placeholder: 'EAAB... (paste the long token from Graph API Explorer)',
            style: { fontFamily: 'monospace', fontSize: '.8rem' } })
        ),
        h('div', { class: 'f-row full' },
          h('button', { type: 'submit', class: 'btn primary' }, 'Validate & add page')
        )
      )
    )
  ));

  if (status.connected && pages.length === 0) {
    pagesCard.appendChild(h('p', { class: 'muted' },
      'Connected, but no pages are showing yet. Click ', h('b', {}, 'Fetch Facebook Pages'), ' to load them.'
    ));
  }

  if (pages.length > 0) {
    const tbl = h('table', { class: 'mini-table fb-pages' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Page Name'), h('th', { style: { textAlign: 'right' } }, 'Action')
      )),
      h('tbody', {}, ...pages.map(pg => h('tr', {},
        h('td', {},
          h('div', {}, pg.page_name || ('Page ' + pg.page_id)),
          pg.category ? h('div', { class: 'muted', style: { fontSize: '.75rem' } }, pg.category) : null
        ),
        h('td', { style: { textAlign: 'right' } },
          pg.is_monitored
            ? h('button', { class: 'btn sm danger', onclick: async () => {
                try { await api('api_fb_pages_toggle', pg.page_id, false); toast('Unmonitored ' + pg.page_name); showAdminTab('fb'); }
                catch (e) { toast(e.message, 'err'); }
              } }, 'Unmonitor')
            : h('button', { class: 'btn sm primary', onclick: async () => {
                try { await api('api_fb_pages_toggle', pg.page_id, true); toast('Monitoring ' + pg.page_name); showAdminTab('fb'); }
                catch (e) { toast(e.message, 'err'); }
              } }, 'Monitor')
        )
      )))
    );
    pagesCard.appendChild(tbl);
  }

  wrap.appendChild(pagesCard);
  return wrap;
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
    h('thead', {}, h('tr', {},
      h('th', {}, 'Key'), h('th', {}, 'Label'), h('th', {}, 'Type'),
      h('th', {}, 'Options'), h('th', {}, 'Sort'),
      h('th', {}, 'In list'), h('th', {}, 'Required'), h('th', {})
    )),
    h('tbody', {}, ...(fields.length === 0
      ? [h('tr', {}, h('td', { colspan: 8, class: 'muted', style: { textAlign: 'center', padding: '1rem' } }, 'No custom fields yet — add one below.'))]
      : fields.map(f => h('tr', {},
          h('td', {}, h('code', {}, f.key)),
          h('td', {}, f.label),
          h('td', {}, f.field_type),
          h('td', { class: 'muted' }, Array.isArray(f.options) ? f.options.join(', ') : (f.options || '—')),
          h('td', {}, String(f.sort_order || 0)),
          h('td', {}, f.show_in_list ? '✓' : '—'),
          h('td', {}, f.is_required ? '✓' : '—'),
          h('td', { style: { whiteSpace: 'nowrap' } },
            h('button', { class: 'btn sm', onclick: () => editCustomField(f) }, '✏️ Edit'),
            h('button', { class: 'btn sm danger', style: { marginLeft: '.3rem' },
              onclick: async () => {
                if (!await confirmDialog(`Delete field "${f.label}"?`)) return;
                try { await api('api_customFields_delete', f.id); toast('Deleted'); await warmCache(); showAdminTab('customfields'); }
                catch (e) { toast(e.message, 'err'); }
              }
            }, '🗑️')
          )
    )))
  )));

  // ---- "Add new field" form ----
  card.appendChild(h('h5', { style: { marginTop: '1.25rem' } }, '+ Add new field'));
  card.appendChild(buildCustomFieldForm({}, async (payload) => {
    await api('api_customFields_save', payload);
    toast('Added');
    await warmCache();
    showAdminTab('customfields');
  }, 'Add field'));
  return card;
}

/** Open a modal to edit an existing custom field. */
function editCustomField(field) {
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target === modal) modal.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '✏️ Edit custom field: ' + field.label),
        h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
      ),
      h('p', { class: 'muted', style: { fontSize: '.85rem' } },
        'Note: changing the ', h('code', {}, 'key'), ' may break older data references — only do it if no leads have used this field yet.'
      ),
      buildCustomFieldForm(field, async (payload) => {
        payload.id = field.id;
        await api('api_customFields_save', payload);
        toast('Saved');
        modal.remove();
        await warmCache();
        showAdminTab('customfields');
      }, 'Save changes', () => modal.remove())
    )
  );
  document.body.appendChild(modal);
}

/** Shared form for create/edit. `onSave` receives the field payload. */
function buildCustomFieldForm(initial, onSave, submitLabel, onCancel) {
  const optsString = Array.isArray(initial.options) ? initial.options.join('|') : (initial.options || '');

  // --- Options field (textarea + chip preview, only visible for select/multiselect) ---
  const optsTextarea = h('textarea', {
    name: 'options',
    placeholder: 'One option per line, e.g.\nLow\nMedium\nHigh',
    rows: '4'
  });
  optsTextarea.value = optsString.replace(/\|/g, '\n');
  const chipsBox = h('div', { class: 'cf-opts-chips' });
  const optsHelp = h('div', { class: 'cf-opts-help' },
    'Type one option per line (or separate with commas / pipes). These are the choices the user picks from on the lead form.');
  function renderChips() {
    chipsBox.innerHTML = '';
    parseFieldOptions(optsTextarea.value).forEach(o =>
      chipsBox.appendChild(h('span', { class: 'cf-opts-chip' }, o)));
  }
  optsTextarea.addEventListener('input', renderChips);
  const optsRow = h('div', { class: 'f-row full' },
    h('label', {}, 'Options *'),
    optsTextarea, optsHelp, chipsBox
  );

  // --- Type selector — toggles the visibility of the Options row ---
  const typeRow = selectField('field_type', 'Type', initial.field_type || 'text',
    ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox']);
  const typeSelect = typeRow.querySelector('select');
  function syncOptsVisibility() {
    const needsOpts = typeSelect.value === 'select' || typeSelect.value === 'multiselect';
    optsRow.style.display = needsOpts ? '' : 'none';
    optsTextarea.toggleAttribute('required', needsOpts);
    if (needsOpts) renderChips();
  }
  typeSelect.addEventListener('change', syncOptsVisibility);

  const form = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const f = ev.target;
    const fieldType = f.field_type.value;
    const needsOpts = fieldType === 'select' || fieldType === 'multiselect';
    if (needsOpts && parseFieldOptions(optsTextarea.value).length === 0) {
      toast('Please add at least one option for ' + fieldType + ' fields.', 'err');
      optsTextarea.focus();
      return;
    }
    try {
      await onSave({
        key: f.key.value,
        label: f.label.value,
        field_type: fieldType,
        // Always store as pipe-separated for backwards compatibility with the DB.
        options: needsOpts ? parseFieldOptions(optsTextarea.value).join('|') : '',
        show_in_list: f.show_in_list.checked ? 1 : 0,
        is_required: f.is_required.checked ? 1 : 0,
        sort_order: Number(f.sort_order.value) || 10
      });
    } catch (e) { toast(e.message, 'err'); }
  }},
    field('key', 'Key *', initial.key || '', { required: true }),
    field('label', 'Label *', initial.label || '', { required: true }),
    typeRow,
    optsRow,
    field('sort_order', 'Sort order', String(initial.sort_order != null ? initial.sort_order : 10), { type: 'number' }),
    h('div', { class: 'f-row' }, h('label', { class: 'cb' },
      h('input', { name: 'show_in_list', type: 'checkbox', checked: initial.show_in_list ? 'checked' : null }),
      ' Show in lead list')),
    h('div', { class: 'f-row' }, h('label', { class: 'cb' },
      h('input', { name: 'is_required', type: 'checkbox', checked: initial.is_required ? 'checked' : null }),
      ' Required')),
    h('div', { class: 'f-row full actions' },
      onCancel ? h('button', { type: 'button', class: 'btn', onclick: onCancel }, 'Cancel') : null,
      h('button', { type: 'submit', class: 'btn primary' }, submitLabel)
    )
  );

  // Initial visibility + chip render once the form is mounted.
  syncOptsVisibility();
  renderChips();
  return form;
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
async function adminPermissions() {
  const { catalog, matrix } = await api('api_permissions_get');
  const roles = ['admin', 'manager', 'team_leader', 'sales'];
  const card = h('div', { class: 'card' },
    h('h4', {}, '🔐 Role permissions'),
    h('p', { class: 'muted' }, 'For scoped permissions (view/edit/delete leads), pick a scope: Self, Team, or Global. Admin always has full access.')
  );
  // Build matrix table
  const thead = h('thead', {}, h('tr', {}, h('th', {}, 'Permission'),
    ...roles.map(r => h('th', { style: { textTransform: 'capitalize' } }, r.replace('_', ' ')))));
  const tbody = h('tbody', {});
  catalog.forEach(p => {
    const row = h('tr', {}, h('td', {}, p.label, p.scoped ? h('span', { class: 'muted' }, ' (scoped)') : null));
    roles.forEach(role => {
      const current = matrix[role]?.[p.key];
      const cell = h('td', {});
      if (p.scoped) {
        const sel = h('select', { 'data-role': role, 'data-perm': p.key },
          h('option', { value: '0',       selected: !current ? 'selected' : null }, '— no —'),
          h('option', { value: 'self',    selected: current === 'self' ? 'selected' : null }, 'Self only'),
          h('option', { value: 'team',    selected: current === 'team' ? 'selected' : null }, 'Team'),
          h('option', { value: 'global',  selected: current === 'global' ? 'selected' : null }, 'Everyone')
        );
        cell.appendChild(sel);
      } else {
        const cb = h('input', { type: 'checkbox', 'data-role': role, 'data-perm': p.key,
          checked: current ? 'checked' : null });
        cell.appendChild(h('label', { class: 'switch' }, cb, h('span', { class: 'slider' })));
      }
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  card.appendChild(h('div', { class: 'table-wrap scroll-x' }, h('table', { class: 'perm-matrix' }, thead, tbody)));
  card.appendChild(h('div', { class: 'actions', style: { marginTop: '1rem' } },
    h('button', { class: 'btn primary', onclick: async () => {
      const out = {};
      roles.forEach(r => { out[r] = {}; });
      $$('[data-role][data-perm]', card).forEach(el => {
        const r = el.dataset.role;
        const k = el.dataset.perm;
        if (el.type === 'checkbox') out[r][k] = el.checked ? 1 : 0;
        else {
          const v = el.value;
          out[r][k] = v === '0' ? 0 : v;
        }
      });
      try { await api('api_permissions_save', out); toast('Permissions saved'); }
      catch (e) { toast(e.message, 'err'); }
    } }, '💾 Save permissions')
  ));
  return card;
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
  const me = CRM.user || {};
  const canReset = ['admin', 'manager'].includes(me.role);
  const canDelete = me.role === 'admin';
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
        h('td', { style: { whiteSpace: 'nowrap' } },
          h('button', { class: 'btn sm', onclick: () => openUserModal(u), title: 'Edit' }, '✎'),
          canReset ? h('button', {
            class: 'btn sm ghost', style: { marginLeft: '.3rem' },
            title: 'Reset password',
            onclick: () => openUserModal(u)   // opens the modal where the reset block lives
          }, '🔑') : null,
          // Delete: admin-only, hidden for self (server also enforces both rules).
          canDelete && Number(u.id) !== Number(me.id) ? h('button', {
            class: 'btn sm danger', style: { marginLeft: '.3rem' },
            title: 'Delete user',
            onclick: async () => {
              const ok = await confirmDialog(
                `Delete user "${u.name}" (${u.email})?\n\n` +
                `Their leads will be re-assigned to you. Their remarks and ` +
                `notifications will keep the lead history but lose the author. ` +
                `This cannot be undone.`
              );
              if (!ok) return;
              try {
                const r = await api('api_users_delete', u.id);
                toast(`Deleted ${u.name}. ${r.reassigned_to ? 'Their leads moved to you.' : ''}`);
                await warmCache();
                navigateTo('users');
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '🗑️') : null
        )
      )))
    ))
  );
};
async function openUserModal(u) {
  u = u || { role: 'sales', is_active: 1 };
  const parents = CRM.cache.users || await api('api_users_list');
  // The password-reset section is only built for existing users — there's no
  // user_id to target until after the row is created.
  const passwordResetBlock = u.id ? buildPasswordResetBlock(u) : null;

  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, u.id ? 'Edit user — ' + u.name : 'New user'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
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
      passwordResetBlock,
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

/**
 * Password reset section inside the user edit modal. Lets an admin (or
 * manager-of-this-user) set a custom password OR generate a random one,
 * apply it, and copy the plaintext to share with the employee.
 *
 * Only the bcrypt hash is stored on the server. The plaintext shown here is
 * the one moment it's available — the admin should copy it and send it to
 * the user via WhatsApp / email immediately.
 */
function buildPasswordResetBlock(u) {
  const me = CRM.user || {};
  // Hide for users who can't reset others — keeps the UI clean for non-admins.
  if (!['admin', 'manager'].includes(me.role)) return null;

  const wrap = h('div', { class: 'pwd-reset-block' });
  wrap.appendChild(h('h4', {}, '🔑 Reset password'));
  wrap.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem' } },
    'Set a new password for ', h('b', {}, u.name),
    '. Leave the field empty and click Generate to auto-create a strong one.'));

  const input = h('input', {
    type: 'text', name: 'pwd_new',
    placeholder: 'Type a new password (min 6 chars), or click Generate',
    autocomplete: 'new-password',
    style: { fontFamily: 'monospace' }
  });

  const result = h('div', { class: 'pwd-reset-result', hidden: 'hidden' });

  const generateBtn = h('button', { type: 'button', class: 'btn', onclick: () => {
    input.value = generateTempPasswordClient();
    input.focus();
    input.select();
  } }, '🎲 Generate');

  const applyBtn = h('button', { type: 'button', class: 'btn warn', onclick: async () => {
    const proposed = String(input.value || '').trim();
    if (proposed && proposed.length < 6) {
      toast('Password must be at least 6 characters (or leave it empty to auto-generate).', 'err');
      return;
    }
    if (!await confirmDialog(
      `Reset password for ${u.name}?\n\nThis will not log them out of existing sessions, but their old password will stop working. Make sure to share the new one with them.`
    )) return;
    applyBtn.disabled = 'disabled';
    applyBtn.textContent = 'Resetting…';
    try {
      const out = await api('api_users_resetPassword', u.id, proposed);
      // Show the new password — this is the only chance to see it.
      result.innerHTML = '';
      const pwdSpan = h('code', { class: 'pwd-reveal' }, out.password);
      result.appendChild(h('div', { class: 'pwd-reveal-row' },
        h('span', { class: 'muted', style: { marginRight: '.5rem' } }, '✅ New password:'),
        pwdSpan,
        h('button', { type: 'button', class: 'btn sm ghost', onclick: () => {
          navigator.clipboard.writeText(out.password).then(
            () => toast('Copied to clipboard'),
            () => toast('Copy failed — select and copy manually.', 'err')
          );
        } }, '📋 Copy')
      ));
      result.appendChild(h('p', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.5rem' } },
        '⚠️ This password is shown only once. Send it to ', h('b', {}, u.name),
        ' now (WhatsApp / email). Closing this modal will not be able to recover it.'
      ));
      result.hidden = null;
      input.value = '';
      toast('Password reset for ' + u.name);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      applyBtn.disabled = null;
      applyBtn.textContent = 'Apply reset';
    }
  } }, 'Apply reset');

  wrap.appendChild(h('div', { class: 'pwd-reset-row' }, input, generateBtn, applyBtn));
  wrap.appendChild(result);
  return wrap;
}

/**
 * Client-side password generator — same character set as the server's
 * _generateTempPassword. Used only for previewing in the input; the server
 * generates its own when the field is left empty.
 */
function generateTempPasswordClient() {
  const upper  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower  = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const punct  = '@#$%&*';
  const all = upper + lower + digits + punct;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(punct)];
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/* ---------------- HR views ---------------- */
VIEWS.tasks = async (view) => {
  view.innerHTML = '';
  // Two-tab view: All tasks + Done today
  const tabs = h('div', { class: 'subtabs' },
    h('button', { class: 'subtab active', onclick: ev => switchTab(ev, 'all') }, 'All tasks'),
    h('button', { class: 'subtab', onclick: ev => switchTab(ev, 'today') }, "✅ What I did today")
  );
  const content = h('div', { id: 'task-content' });
  view.append(tabs, content);
  renderAllTasks();

  function switchTab(ev, which) {
    $$('.subtab', tabs).forEach(b => b.classList.remove('active'));
    ev.target.classList.add('active');
    if (which === 'all')   renderAllTasks();
    if (which === 'today') renderTodayTasks();
  }

  async function renderAllTasks() {
    content.innerHTML = '<div class="loading">Loading…</div>';
    const rows = await api('api_tasks_list', {});
    content.innerHTML = '';
    content.append(
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openTaskModal() }, '+ New task')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Assigned'), h('th', {}, 'Due'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, ...rows.map(t => h('tr', {},
          h('td', {}, t.title), h('td', {}, t.assigned_name || ''),
          h('td', {}, fmtDate(t.due_at)), h('td', {}, t.status),
          h('td', {}, t.status !== 'done' ? h('button', { class: 'btn sm', onclick: async () => { await api('api_tasks_complete', t.id); toast('Done'); renderAllTasks(); } }, '✓') : null)
        )))
      ))
    );
  }

  async function renderTodayTasks() {
    content.innerHTML = '<div class="loading">Loading…</div>';
    const d = await api('api_tasks_doneToday');
    content.innerHTML = '';
    content.append(
      h('div', { class: 'cards' },
        h('div', { class: 'card stat ok' },
          h('div', { class: 'stat-icon' }, '✅'),
          h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Tasks done today'),
            h('div', { class: 'stat-value' }, d.totals.my_tasks))),
        h('div', { class: 'card stat accent' },
          h('div', { class: 'stat-icon' }, '🔔'),
          h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Follow-ups done today'),
            h('div', { class: 'stat-value' }, d.totals.my_followups))),
        d.totals.team_tasks > 0 ? h('div', { class: 'card stat' },
          h('div', { class: 'stat-icon' }, '👥'),
          h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Team tasks today'),
            h('div', { class: 'stat-value' }, d.totals.team_tasks))) : null
      ),
      h('div', { class: 'card' },
        h('h3', {}, '🎯 My completed tasks'),
        d.my_tasks_done.length === 0
          ? h('p', { class: 'muted' }, 'Nothing ticked off yet today — let\'s get to it!')
          : h('ul', { class: 'done-list' },
              ...d.my_tasks_done.map(t => h('li', {},
                h('span', { class: 'check' }, '✓'),
                h('div', { class: 'done-body' },
                  h('div', { class: 'done-title' }, t.title),
                  t.description ? h('div', { class: 'muted' }, t.description) : null
                ),
                h('span', { class: 'done-time muted' }, t.completed_at_label)
              ))
            )
      ),
      d.my_followups_done.length > 0 ? h('div', { class: 'card' },
        h('h3', {}, '🔔 Follow-ups closed today'),
        h('ul', { class: 'done-list' }, ...d.my_followups_done.map(f => h('li', {},
          h('span', { class: 'check' }, '✓'),
          h('div', { class: 'done-body' },
            h('div', { class: 'done-title' }, 'Follow-up #' + f.id),
            f.note ? h('div', { class: 'muted' }, f.note) : null)
        )))
      ) : null,
      d.team_done && d.team_done.length > 0 ? h('div', { class: 'card' },
        h('h3', {}, '👥 Team activity today'),
        ...d.team_done.map(g => h('div', { class: 'team-group' },
          h('h4', {}, g.user_name, ' ', h('small', { class: 'muted' }, g.user_role, ' — ', g.count, ' done')),
          h('ul', { class: 'done-list' }, ...g.tasks.map(t => h('li', {},
            h('span', { class: 'check' }, '✓'), h('div', { class: 'done-body' }, h('div', { class: 'done-title' }, t.title))
          )))
        ))
      ) : null
    );
  }
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
        try { await api('api_tasks_save', { title: f.title.value, description: f.description.value, assigned_to: Number(f.assigned_to.value), due_at: localDtInputToIso(f.due_at.value) }); toast('Created'); modal.remove(); navigateTo('tasks'); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Create')
    )
  ));
  document.body.appendChild(modal);
}

VIEWS.attendance = async (view) => {
  view.innerHTML = '';
  const canReport = ['admin', 'manager', 'team_leader'].includes(CRM.user.role);
  const tabs = [{ id: 'mine', label: 'My attendance' }];
  if (canReport) tabs.push({ id: 'report', label: 'Team report' });
  const nav = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab' + (t.id === 'mine' ? ' active' : ''),
      onclick: ev => showAttTab(ev, t.id) }, t.label))
  );
  view.append(nav, h('div', { id: 'att-body' }));
  showAttTab(null, 'mine');
};
async function showAttTab(ev, id) {
  if (ev) { $$('.subtab').forEach(b => b.classList.remove('active')); ev.target.classList.add('active'); }
  const body = $('#att-body');
  body.innerHTML = '<div class="loading">…</div>';
  if (id === 'mine')   body.replaceChildren(await renderMyAttendance());
  if (id === 'report') body.replaceChildren(await renderAttendanceReport());
}
async function renderMyAttendance() {
  const rows = await api('api_attendance_mine');
  const card = h('div', {});
  card.append(
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => checkInOut('checkIn') }, '🕘 Check in'),
      h('button', { class: 'btn', onclick: () => checkInOut('checkOut') }, '🕔 Check out')
    ),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Date'), h('th', {}, 'In'), h('th', {}, 'Out'),
        h('th', {}, 'Location'), h('th', {}, 'Device'), h('th', {}, 'Status')
      )),
      h('tbody', {}, ...rows.map(r => h('tr', {},
        h('td', {}, r.date),
        h('td', {}, fmtDate(r.check_in, 'time')),
        h('td', {}, fmtDate(r.check_out, 'time')),
        h('td', {}, (r.check_in_lat && r.check_in_lng)
          ? h('a', { href: '#', onclick: ev => { ev.preventDefault(); openAttendanceMap(r); } }, '🗺️ Map')
          : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'muted' }, r.device_info || '—'),
        h('td', {}, r.status || '')
      )))
    ))
  );
  return card;
}
async function renderAttendanceReport() {
  const month = new Date().toISOString().slice(0, 7);
  const users = CRM.cache.users || [];
  const monthInput = h('input', { type: 'month', id: 'ar-month', value: month });
  const userSel = h('select', { id: 'ar-user' },
    h('option', { value: '' }, 'All users'),
    ...users.map(u => h('option', { value: u.id }, u.name))
  );
  const out = h('div', { id: 'ar-out' });
  const card = h('div', {},
    h('div', { class: 'toolbar' },
      h('label', {}, 'Month'), monthInput,
      h('label', {}, 'User'), userSel,
      h('button', { class: 'btn primary', onclick: load }, 'Load')
    ),
    out
  );
  await load();
  return card;

  async function load() {
    out.innerHTML = '<div class="loading">…</div>';
    try {
      const r = await api('api_attendance_report', monthInput.value, userSel.value || undefined);
      out.innerHTML = '';
      if (!r.users.length) { out.innerHTML = '<p class="muted">No users in scope.</p>'; return; }

      // Summary cards per user
      out.append(h('div', { class: 'cards' }, ...r.users.slice(0, 4).map(u => {
        const t = r.totals[u.id];
        return h('div', { class: 'card stat' },
          h('div', { class: 'stat-icon' }, '🕒'),
          h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, u.name),
            h('div', { class: 'stat-value' }, t.present + ' days'),
            h('div', { class: 'muted' }, Math.round(t.hours) + 'h worked · ' + t.absent + ' absent')
          )
        );
      })));

      // Matrix table
      const thead = h('thead', {},
        h('tr', {},
          h('th', {}, 'User'),
          ...r.dates.map(d => h('th', { class: 'day-col', title: d }, d.slice(-2))),
          h('th', {}, 'Present'),
          h('th', {}, 'Hours')
        )
      );
      const tbody = h('tbody', {},
        ...r.users.map(u => {
          const t = r.totals[u.id];
          return h('tr', {},
            h('td', {}, h('b', {}, u.name), h('br'), h('span', { class: 'muted' }, u.role)),
            ...r.dates.map(d => {
              const c = r.matrix[u.id][d];
              if (!c) return h('td', { class: 'day-cell absent', title: d + ' absent' }, '');
              const hours = c.hours ? c.hours.toFixed(1) : '';
              const title = `${d} · in ${c.in ? new Date(c.in).toLocaleTimeString() : '—'} · out ${c.out ? new Date(c.out).toLocaleTimeString() : '—'} · ${hours}h · ${c.device}`;
              return h('td', { class: 'day-cell present', title }, '✓');
            }),
            h('td', { class: 'cell-ok' }, t.present),
            h('td', {}, t.hours.toFixed(1) + 'h')
          );
        })
      );
      out.append(h('div', { class: 'table-wrap scroll-x' }, h('table', { class: 'att-matrix' }, thead, tbody)));
    } catch (e) { out.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  }
}

async function ensureLeaflet() {
  if (window.L) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.crossOrigin = '';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function openAttendanceMap(r) {
  await ensureLeaflet();
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, `🗺️ ${r.date} — attendance trail`), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('div', { id: 'att-map', style: { height: '400px', borderRadius: '8px' } }),
      h('div', { class: 'att-meta' },
        r.device_info ? h('div', {}, h('b', {}, 'Device: '), r.device_info) : null,
        r.user_agent ? h('div', { class: 'muted' }, h('b', {}, 'UA: '), r.user_agent) : null,
        h('div', {}, h('b', {}, 'Check in: '), fmtDate(r.check_in), '  ·  ',
          r.check_in_lat ? `${Number(r.check_in_lat).toFixed(5)}, ${Number(r.check_in_lng).toFixed(5)}` : '—'),
        r.check_out ? h('div', {}, h('b', {}, 'Check out: '), fmtDate(r.check_out), '  ·  ',
          r.check_out_lat ? `${Number(r.check_out_lat).toFixed(5)}, ${Number(r.check_out_lng).toFixed(5)}` : '—') : null
      )
    )
  );
  document.body.appendChild(modal);
  setTimeout(() => {
    const map = L.map('att-map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19
    }).addTo(map);
    const pts = [];
    if (r.check_in_lat && r.check_in_lng) {
      const c = [Number(r.check_in_lat), Number(r.check_in_lng)];
      L.marker(c).addTo(map).bindPopup('🕘 Check in<br>' + fmtDate(r.check_in));
      pts.push(c);
    }
    if (r.check_out_lat && r.check_out_lng) {
      const c = [Number(r.check_out_lat), Number(r.check_out_lng)];
      L.marker(c).addTo(map).bindPopup('🕔 Check out<br>' + fmtDate(r.check_out));
      pts.push(c);
    }
    if (pts.length === 2) L.polyline(pts, { color: '#6366f1', weight: 3 }).addTo(map);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    else map.setView([20, 78], 4);
  }, 50);
}

async function checkInOut(which) {
  const device = _collectDevice();
  const call = async (lat, lng) => {
    try { await api('api_attendance_' + which, lat, lng, device); toast(which === 'checkIn' ? 'Checked in' : 'Checked out'); navigateTo('attendance'); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (!navigator.geolocation) return call(null, null);
  navigator.geolocation.getCurrentPosition(
    p => call(p.coords.latitude, p.coords.longitude),
    () => call(null, null)
  );
}

function _collectDevice() {
  const ua = navigator.userAgent || '';
  const uad = navigator.userAgentData || {};
  // Try to parse a friendly summary
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const osMatch = ua.match(/Windows NT [\d.]+|Mac OS X [\d_.]+|Android [\d.]+|iPhone OS [\d_]+|iPad; CPU OS [\d_]+|Linux/);
  const browserMatch = ua.match(/(Edg|Chrome|Safari|Firefox|OPR)\/([\d.]+)/);
  const modelMatch = ua.match(/;\s*([A-Z][\w\-]+ [\w\-]+(?: [\w\-]+)?)[);]/i) || ua.match(/\(Linux; Android [\d.]+; ([^)]+)\)/);
  const os      = osMatch ? osMatch[0].replace(/_/g, '.') : 'unknown';
  const browser = browserMatch ? browserMatch[1] + ' ' + browserMatch[2] : 'unknown';
  const model   = modelMatch ? modelMatch[1] : (uad.mobile ? 'mobile' : 'desktop');
  const summary = [isMobile ? '📱' : '💻', model, '·', os, '·', browser,
    screen.width + '×' + screen.height].join(' ').trim();
  return { summary, user_agent: ua };
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
  view.innerHTML = '';
  const isAdminOrMgr = ['admin', 'manager'].includes(CRM.user.role);
  const tabs = [{ id: 'my', label: 'My salary' }];
  if (isAdminOrMgr) tabs.push({ id: 'report', label: 'Monthly report' });
  if (CRM.user.role === 'admin') tabs.push({ id: 'bulk', label: '✎ Bulk entry' });

  const nav = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab' + (t.id === 'my' ? ' active' : ''), 'data-tab': t.id,
      onclick: ev => showSalaryTab(ev, t.id) }, t.label))
  );
  view.append(nav, h('div', { id: 'salary-content' }));
  showSalaryTab(null, 'my');
};

async function showSalaryTab(ev, id) {
  if (ev) {
    $$('.subtab').forEach(b => b.classList.remove('active'));
    ev.target.classList.add('active');
  }
  const body = $('#salary-content');
  body.innerHTML = '<div class="loading">Loading…</div>';
  if (id === 'my')     body.replaceChildren(await renderMySalary());
  if (id === 'report') body.replaceChildren(await renderSalaryReport());
  if (id === 'bulk')   body.replaceChildren(await renderSalaryBulk());
}

async function renderMySalary() {
  const rows = await api('api_salary_mine');
  const card = h('div', {});
  if (!rows.length) {
    card.appendChild(h('p', { class: 'muted' }, 'No salary records yet.'));
    return card;
  }
  card.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Base'), h('th', {}, 'Allowances'), h('th', {}, 'Deductions'), h('th', {}, 'Net'), h('th', {}))),
    h('tbody', {}, ...rows.map(s => h('tr', {},
      h('td', {}, s.month),
      h('td', {}, '₹ ' + Number(s.base).toFixed(2)),
      h('td', {}, '₹ ' + Number(s.allowances).toFixed(2)),
      h('td', {}, '₹ ' + Number(s.deductions).toFixed(2)),
      h('td', {}, '₹ ' + Number(s.net_pay).toFixed(2)),
      h('td', {}, h('button', { class: 'btn sm', onclick: () => downloadPayslip(s.id) }, '📄 Payslip'))
    )))
  )));
  return card;
}

async function downloadPayslip(id) {
  try {
    const r = await api('api_salary_payslip', id);
    const w = window.open('', '_blank');
    w.document.write(r.html);
    w.document.close();
    setTimeout(() => w.print(), 500);
  } catch (e) { toast(e.message, 'err'); }
}

async function renderSalaryReport() {
  const monthInput = h('input', { type: 'month', id: 'sal-month', value: new Date().toISOString().slice(0, 7) });
  const go = h('button', { class: 'btn primary', onclick: () => refreshSalaryReport() }, 'Load');
  const out = h('div', { id: 'sal-report' });
  const card = h('div', {}, h('div', { class: 'toolbar' }, h('label', {}, 'Month'), monthInput, go), out);
  await refreshSalaryReport();
  return card;

  async function refreshSalaryReport() {
    out.innerHTML = '<div class="loading">…</div>';
    try {
      const r = await api('api_salary_report', monthInput.value);
      out.innerHTML = '';
      if (!r.rows.length) { out.innerHTML = '<p class="muted">No salary records for this month.</p>'; return; }
      out.append(
        h('div', { class: 'cards' },
          h('div', { class: 'card stat accent' }, h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Total base'), h('div', { class: 'stat-value' }, '₹' + r.totals.base.toFixed(0)))),
          h('div', { class: 'card stat' }, h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Allowances'), h('div', { class: 'stat-value' }, '₹' + r.totals.allowances.toFixed(0)))),
          h('div', { class: 'card stat err' }, h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Deductions'), h('div', { class: 'stat-value' }, '₹' + r.totals.deductions.toFixed(0)))),
          h('div', { class: 'card stat ok' }, h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Net payout'), h('div', { class: 'stat-value' }, '₹' + r.totals.net_pay.toFixed(0))))
        ),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Role'),
            h('th', {}, 'Base'), h('th', {}, 'Allowances'), h('th', {}, 'Deductions'), h('th', {}, 'Net'), h('th', {}))),
          h('tbody', {}, ...r.rows.map(s => h('tr', {},
            h('td', {}, s.user_name),
            h('td', {}, s.user_role),
            h('td', {}, '₹' + Number(s.base).toFixed(2)),
            h('td', {}, '₹' + Number(s.allowances).toFixed(2)),
            h('td', {}, '₹' + Number(s.deductions).toFixed(2)),
            h('td', { class: 'cell-ok' }, '₹' + Number(s.net_pay).toFixed(2)),
            h('td', {}, h('button', { class: 'btn sm', onclick: () => downloadPayslip(s.id) }, '📄'))
          )))
        ))
      );
    } catch (e) { out.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  }
}

async function renderSalaryBulk() {
  const users = await api('api_users_list');
  const month = new Date().toISOString().slice(0, 7);
  const existing = await api('api_salary_report', month);
  const exByUser = {}; existing.rows.forEach(r => { exByUser[Number(r.user_id)] = r; });

  const monthInput = h('input', { type: 'month', id: 'bulk-month', value: month });
  const card = h('div', {},
    h('div', { class: 'toolbar' },
      h('label', {}, 'Month'),
      monthInput,
      h('button', { class: 'btn', onclick: () => showSalaryTab({ target: $$('.subtab')[2] }, 'bulk') }, 'Load month')
    ),
    h('p', { class: 'muted' }, 'Enter/adjust base / allowances / deductions for each employee and click Save all.')
  );
  const tbl = h('table', { class: 'mini-table', id: 'bulk-tbl' });
  tbl.append(
    h('thead', {}, h('tr', {},
      h('th', {}, 'User'), h('th', {}, 'Role'),
      h('th', {}, 'Base (₹)'), h('th', {}, 'Allowances (₹)'), h('th', {}, 'Deductions (₹)'), h('th', {}, 'Net')
    )),
    h('tbody', {},
      ...users.map(u => {
        const ex = exByUser[Number(u.id)] || {};
        const baseIn = h('input', { type: 'number', step: '0.01', 'data-uid': u.id, 'data-f': 'base', value: ex.base || u.monthly_salary || 0, style: { width: '110px' } });
        const alIn   = h('input', { type: 'number', step: '0.01', 'data-uid': u.id, 'data-f': 'allowances', value: ex.allowances || 0, style: { width: '110px' } });
        const dedIn  = h('input', { type: 'number', step: '0.01', 'data-uid': u.id, 'data-f': 'deductions', value: ex.deductions || 0, style: { width: '110px' } });
        const net = h('td', { class: 'cell-ok', 'data-uid-net': u.id }, '₹' + (Number(ex.net_pay) || 0).toFixed(2));
        const update = () => {
          const n = Number(baseIn.value || 0) + Number(alIn.value || 0) - Number(dedIn.value || 0);
          net.textContent = '₹' + n.toFixed(2);
        };
        [baseIn, alIn, dedIn].forEach(i => i.addEventListener('input', update));
        return h('tr', {},
          h('td', {}, u.name), h('td', {}, u.role),
          h('td', {}, baseIn), h('td', {}, alIn), h('td', {}, dedIn),
          net
        );
      })
    )
  );
  card.append(tbl, h('div', { class: 'actions' },
    h('button', { class: 'btn primary', onclick: async () => {
      const rows = [];
      const m = monthInput.value;
      users.forEach(u => {
        const base = $$(`[data-uid="${u.id}"][data-f="base"]`)[0]?.value;
        const al   = $$(`[data-uid="${u.id}"][data-f="allowances"]`)[0]?.value;
        const ded  = $$(`[data-uid="${u.id}"][data-f="deductions"]`)[0]?.value;
        rows.push({ user_id: u.id, month: m, base, allowances: al, deductions: ded });
      });
      try {
        const r = await api('api_salary_bulkSave', rows);
        toast(`Saved ${r.saved} salary rows`);
      } catch (e) { toast(e.message, 'err'); }
    } }, '💾 Save all')
  ));
  return card;
}

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
// Scopes mirror the proven PHP-CRM reference. business_management is critical
// for accounts that hold pages inside a Business Manager — without it,
// /me/accounts returns nothing or only personal pages.
const FB_LOGIN_SCOPE = [
  'public_profile',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_ads',
  'leads_retrieval',
  'ads_management',
  'ads_read',
  'business_management'
].join(',');

const FB_REQUIRED_PERMS = [
  'pages_show_list', 'leads_retrieval', 'pages_read_engagement', 'pages_manage_metadata'
];

// Track FB SDK readiness so we can preload it when the admin Facebook tab
// renders. Without this, the SDK loads only after the user clicks Connect —
// and by the time FB.login runs, Chrome has expired the user gesture and
// blocks the popup window. Result: the "Opening Facebook login…" toast fires
// but no popup ever appears. Preloading the SDK fixes this.
let _fbSdkLoading = null;
function ensureFbSdkLoaded(appId) {
  if (window.FB && typeof window.FB.login === 'function') return Promise.resolve();
  if (_fbSdkLoading) return _fbSdkLoading;
  _fbSdkLoading = new Promise((resolve, reject) => {
    if (!appId) return reject(new Error('Set Facebook Application ID first (Admin → Facebook → Application Settings)'));
    window.fbAsyncInit = function () {
      try {
        FB.init({ appId, cookie: true, xfbml: false, version: 'v19.0' });
        resolve();
      } catch (e) { reject(e); }
    };
    if (document.getElementById('facebook-jssdk')) return; // already in DOM, wait for fbAsyncInit
    const s = document.createElement('script');
    s.id = 'facebook-jssdk';
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Failed to load Facebook SDK — check internet / ad-blocker.'));
    document.body.appendChild(s);
  });
  return _fbSdkLoading;
}

/**
 * Server-side OAuth flow (the new primary method).
 * Redirects the whole browser to facebook.com — no popup, no SDK, no
 * browser permission needed. Facebook redirects back to /fb/auth/callback,
 * which fetches pages, persists, and redirects back to /#/admin/fb.
 */
async function connectFacebookServerFlow() {
  toast('Redirecting to Facebook…');
  try {
    const { auth_url } = await api('api_fb_oauth_url', location.origin);
    if (!auth_url) throw new Error('No auth URL returned');
    location.href = auth_url;
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

function connectFacebook() {
  // Hot path: SDK is already loaded — call FB.login SYNCHRONOUSLY inside the
  // click event so the browser allows the popup. Anything async here loses
  // the user gesture and Chrome will block the popup silently.
  if (window.FB && typeof window.FB.login === 'function') {
    return _fbDoLogin();
  }

  // Cold path: SDK isn't loaded yet. Tell the user, kick off the load, and
  // ask them to click again. We can't auto-retry inside the same handler
  // because the user gesture has been spent.
  toast('Loading Facebook SDK… please click Connect again in 2 seconds.', 'warn');
  api('api_fb_status').then(({ app_id }) => {
    return ensureFbSdkLoaded(app_id);
  }).then(() => {
    toast('Facebook SDK ready — click Connect with Facebook now.');
  }).catch(e => toast(e.message, 'err'));
}

function _fbDoLogin() {
  toast('Opening Facebook login…');
  FB.login(async resp => {
    if (!resp.authResponse) return toast('Login cancelled or popup blocked. Allow popups for this site and try again.', 'warn');
    // Verify the user actually granted the four permissions we need. Without
    // this the connect appears to succeed but pages fetch returns empty.
    FB.api('me/permissions', async (permResp) => {
      const granted = (permResp && permResp.data || [])
        .filter(p => p.status === 'granted')
        .map(p => p.permission);
      const missing = FB_REQUIRED_PERMS.filter(p => !granted.includes(p));
      if (missing.length) {
        toast('Missing permissions: ' + missing.join(', ') +
          '. Click Connect again and grant ALL requested permissions in the Facebook dialog.', 'err');
        return;
      }
      try {
        toast('Connected. Fetching your Facebook pages…');
        const r = await api('api_fb_connect', resp.authResponse.accessToken);
        if (r.pages_count === 0) {
          toast('Login succeeded but no pages came back. Check that your account has Facebook page admin access.', 'warn');
        } else {
          toast(`Connected — ${r.pages_count} page${r.pages_count === 1 ? '' : 's'} fetched. Pick which to monitor below.`);
        }
        showAdminTab('fb');
      } catch (e) { toast(e.message, 'err'); }
    });
  }, {
    scope: FB_LOGIN_SCOPE,
    // rerequest forces the dialog to ask for permissions the user previously
    // declined or skipped. Without it, FB silently reuses the partial grant.
    auth_type: 'rerequest',
    return_scopes: true
  });
}

/* ---------------- Native Android integration (Capacitor APK) ---------------- */
// (Auto-recording is disabled. We use the SAF folder-watcher pattern instead —
//  see syncRecordings() below.)

/**
 * Parse a phone-call recording filename. Common patterns we handle:
 *   "Call recording with +91XXXXXXXXXX_2024-01-15-14-30-22.m4a"
 *   "+919876543210_20240115_143022.mp3"
 *   "Outgoing_+91XXXXXXXXXX_15-01-2024.amr"
 *   "Incoming call from John Doe (9876543210) 15-Jan-2024.amr"
 *   "20240115_143022_+919876543210_out.m4a"
 */
function parseRecordingFilename(name, fallbackTimestamp) {
  const lower = name.toLowerCase();
  // Phone — first run of 7-15 digits (optionally + prefix), preferring + form
  let phone = '';
  const plusMatch = name.match(/\+\d{8,15}/);
  if (plusMatch) phone = plusMatch[0];
  else {
    const m = name.match(/(\d{7,15})/);
    if (m) phone = m[1];
  }
  // Direction
  let direction = 'out';
  if (/(incoming|received|\bin[_\-\s]|inbound)/.test(lower)) direction = 'in';
  else if (/(outgoing|outbound|\bout[_\-\s]|dialed|made)/.test(lower)) direction = 'out';
  // Date — try YYYY-MM-DD HH:MM:SS or YYYYMMDD_HHMMSS variants
  let startedAt = fallbackTimestamp || Date.now();
  const dt1 = name.match(/(\d{4})[\-_]?(\d{2})[\-_]?(\d{2})[\-_\sT]+(\d{2})[\-_:]?(\d{2})[\-_:]?(\d{2})/);
  if (dt1) {
    const [, y, mo, d, h, mi, s] = dt1;
    const ts = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
    if (!isNaN(ts)) startedAt = ts;
  }
  return { phone, direction, startedAt };
}

/**
 * Walk the user's selected recordings folder, find new files, look up the
 * matching lead by phone number, and upload each new recording to the CRM.
 *
 * Skips files we've already uploaded (tracked in localStorage by file URI).
 */
async function syncRecordings(opts) {
  opts = opts || {};
  if (!window.LeadCRMNative || typeof LeadCRMNative.listRecordings !== 'function') {
    toast('Sync only works in the Android app', 'warn');
    return;
  }
  let folderName = '';
  try { folderName = LeadCRMNative.getRecordingFolder() || ''; } catch (e) {}
  if (!folderName) {
    return setupRecordingFolder();
  }

  const sinceMs = Number(localStorage.getItem('rec_last_sync') || 0);
  const filesJson = LeadCRMNative.listRecordings(opts.full ? 0 : sinceMs);
  let files = [];
  try { files = JSON.parse(filesJson || '[]'); } catch (e) { files = []; }

  if (files.length === 0) {
    toast('No new recordings in the folder');
    return;
  }

  // Make sure we have leads loaded for matching
  if (!CRM.cache.lastLeads || CRM.cache.lastLeads.length === 0) {
    try {
      const r = await api('api_leads_list', {});
      CRM.cache.lastLeads = (r.leads || r);
    } catch (_) {}
  }

  // Build a set of "last 7 digits" for every phone we know across leads —
  // used to filter out personal/family calls.
  const knownTails = new Set();
  for (const l of CRM.cache.lastLeads || []) {
    for (const fld of ['phone', 'whatsapp', 'alt_phone']) {
      const d = String(l[fld] || '').replace(/\D/g, '');
      if (d.length >= 7) knownTails.add(d.slice(-7));
    }
  }
  const includeUnmatched = !!opts.includeUnmatched
    || localStorage.getItem('rec_include_unmatched') === '1';

  const uploaded = JSON.parse(localStorage.getItem('rec_uploaded') || '{}');
  let success = 0, failed = 0, skipped = 0, skippedNoMatch = 0;

  // Show progress in dialer view if visible
  const progress = $('#sync-progress');
  if (progress) progress.textContent = `0 / ${files.length}`;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (uploaded[f.uri]) { skipped++; continue; }
    const meta = parseRecordingFilename(f.name, f.modified);
    const digits = String(meta.phone || '').replace(/\D/g, '');
    const tail = digits.slice(-7);
    // SKIP files whose phone number doesn't match a lead in your CRM
    // (personal calls, family, courier, OTPs, etc.)
    if (!includeUnmatched && (!tail || !knownTails.has(tail))) {
      skippedNoMatch++;
      continue;
    }
    const lead = digits ? (CRM.cache.lastLeads || []).find(l =>
      String(l.phone || '').replace(/\D/g, '').endsWith(digits.slice(-10))
    ) : null;
    const leadId = lead ? String(lead.id) : '';
    // Rough duration: ~12 KB/sec for AAC m4a, ~8 KB/sec for amr, ~16 KB/sec for mp3
    const bytesPerSec = /\.(mp3|wav)$/i.test(f.name) ? 16000 : /\.(amr|3gp)$/i.test(f.name) ? 8000 : 12000;
    const durationGuess = Math.max(0, Math.round((Number(f.size) || 0) / bytesPerSec));

    const ok = await new Promise(resolve => {
      const cbName = '__recCB_' + Math.random().toString(36).slice(2, 10);
      window[cbName] = (success, detail) => {
        delete window[cbName];
        resolve({ success, detail });
      };
      try {
        LeadCRMNative.uploadRecordingByUri(
          f.uri, location.origin, CRM.token || '',
          meta.phone || '', meta.direction || 'out',
          durationGuess, leadId,
          new Date(meta.startedAt).toISOString(), f.name, cbName
        );
      } catch (e) {
        delete window[cbName];
        resolve({ success: false, detail: e.message });
      }
    });

    if (ok.success) {
      success++;
      uploaded[f.uri] = Date.now();
    } else {
      failed++;
      console.warn('[leadcrm] upload failed:', f.name, ok.detail);
    }
    if (progress) progress.textContent = `${i + 1} / ${files.length}`;
  }

  localStorage.setItem('rec_uploaded', JSON.stringify(uploaded));
  localStorage.setItem('rec_last_sync', String(Date.now()));
  const parts = [];
  parts.push(`✅ ${success} synced`);
  if (skipped) parts.push(`${skipped} already uploaded`);
  if (skippedNoMatch) parts.push(`${skippedNoMatch} skipped (not in CRM)`);
  if (failed) parts.push(`${failed} failed`);
  toast(parts.join(' · '));
  if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
}

/** First-run flow: ask the user to point the app at their recordings folder. */
function setupRecordingFolder() {
  if (!window.LeadCRMNative || typeof LeadCRMNative.pickRecordingFolder !== 'function') {
    toast('Folder picker only works in the Android app', 'warn');
    return;
  }
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '📁 Connect call-recordings folder'),
        h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
      ),
      h('p', { class: 'muted' },
        'Pick the folder where your phone (or call recorder app) saves call recordings. ' +
        'The CRM will read each file, match it to the right lead by phone number, and ' +
        'upload it. Common locations:'
      ),
      h('ul', { class: 'rec-folder-tips' },
        h('li', {}, h('b', {}, 'Stock Android: '), 'Internal storage › Recordings › Call'),
        h('li', {}, h('b', {}, 'Samsung: '), 'Internal storage › Call'),
        h('li', {}, h('b', {}, 'Xiaomi/Redmi: '), 'Internal storage › MIUI › sound_recorder › call_rec'),
        h('li', {}, h('b', {}, 'OnePlus/Realme: '), 'Internal storage › Recordings › Call'),
        h('li', {}, h('b', {}, 'Truecaller: '), 'Internal storage › Truecaller'),
        h('li', {}, h('b', {}, 'Google Phone: '), 'Internal storage › Recorded Calls')
      ),
      h('p', { class: 'muted' }, 'Recording must be enabled separately in your phone\'s call recorder. ' +
        'The CRM only reads the files — it doesn\'t record calls itself.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          window.__onFolderPicked = (ok, name) => {
            delete window.__onFolderPicked;
            if (ok) {
              toast('📁 Folder connected: ' + name);
              modal.remove();
              if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
              // Run an initial full sync so existing recordings show up
              setTimeout(() => syncRecordings({ full: true }), 600);
            } else {
              toast('Folder selection cancelled', 'warn');
            }
          };
          try {
            LeadCRMNative.pickRecordingFolder('__onFolderPicked');
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Pick folder')
      )
    )
  );
  document.body.appendChild(modal);
}

/** Reset the folder + clear the upload cache (for "switch folder" flow). */
function resetRecordingFolder() {
  if (!window.LeadCRMNative) return;
  try { LeadCRMNative.clearRecordingFolder(); } catch (e) {}
  localStorage.removeItem('rec_last_sync');
  localStorage.removeItem('rec_uploaded');
  toast('Folder cleared');
  if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
}

// When the native PhoneStateReceiver fires a call event, it calls this function.
window.onLeadCRMCallEvent = function (event, number) {
  try {
    console.log('[leadcrm] native call event:', event, number);
    if (!CRM.user) return;
    const digits = String(number || '').replace(/\D/g, '');
    // Match either the lead currently being dialed (pendingCall) or any lead
    // matching the number that just rang.
    const ctx = CRM.pendingCall;
    const ctxLead = ctx && ctx.lead;
    const matchByNumber = (CRM.cache.lastLeads || []).find(l =>
      digits && String(l.phone || '').replace(/\D/g, '').endsWith(digits.slice(-10))
    );
    const lead = matchByNumber || ctxLead;

    // Log every call into the timeline (best-effort)
    if (digits) {
      const direction = (event === 'incoming_ringing') ? 'in' : 'out';
      api('api_call_logEvent', { phone: number, direction, event }).catch(() => {});
    }

    if (event === 'incoming_ringing' && !matchByNumber && digits) {
      promptSaveAsLead(number);
    } else if (event === 'call_ended') {
      // Native broadcast fired — try to resume from the localStorage stash
      // (works even if WebView was destroyed). _resumePendingCall is idempotent.
      _resumePendingCall('call_ended_native');
      if (!matchByNumber && digits) {
        // No lead match anywhere — offer to save as new lead
        setTimeout(() => {
          if (!document.querySelector('.after-call-modal')) promptSaveAsLead(number);
        }, 1200);
      }
      if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
    }
  } catch (e) { console.error('[leadcrm] callEvent handler:', e); }
};

/**
 * Open the after-call update modal — purely for manual remark + status entry.
 * Recording match + upload happens silently in the background; the user just
 * fills in their note and saves. The recording will be linked to the lead by
 * the time they look at the lead detail again.
 */
async function openAfterCallModalWithRecording(lead, callContext) {
  await openAfterCallModal(lead);
  // Fire the silent background sync — runs independently while the user types.
  if (window.LeadCRMNative && typeof LeadCRMNative.syncCallRecording === 'function') {
    triggerBackgroundRecordingSync(lead, callContext);
  }
}

/**
 * Background: wait 5s for the OS recorder to finalise the file, then ask the
 * native bridge to find the matching recording and upload it. No spinners,
 * no audio players in the modal — the user only sees the remark/status form.
 *
 * Surfaces problems via toast only when there's something the user can fix
 * (folder not picked, folder unreachable). "No recording found" is silent —
 * it usually means the user hasn't enabled call recording on their dialer,
 * which is their choice.
 */
/**
 * Silent background sweep: walks the recording folder, uploads any new
 * lead-matched files since the last sweep. No toasts unless the user
 * needs to act (folder not picked, folder unreachable). Used on app
 * launch so missed-call recordings get picked up automatically.
 */
async function silentBackgroundSync() {
  if (!window.LeadCRMNative || typeof LeadCRMNative.listRecordings !== 'function') return;
  try {
    const folder = LeadCRMNative.getRecordingFolder();
    if (!folder) return; // user hasn't picked a folder yet — don't nag here
    // Save a stash of toast() so we can suppress info-toasts during the silent run
    const realToast = window.toast;
    let suppressedSuccess = 0;
    window.toast = function (msg, kind) {
      // only let warnings through
      if (kind === 'warn' || kind === 'err') return realToast(msg, kind);
      if (typeof msg === 'string' && msg.startsWith('✅')) suppressedSuccess++;
    };
    try {
      await syncRecordings({});
    } finally {
      window.toast = realToast;
    }
    if (suppressedSuccess) {
      console.log('[leadcrm] background sweep done, ' + suppressedSuccess + ' new');
    }
  } catch (e) {
    console.warn('[leadcrm] silent sweep error:', e);
  }
}

function triggerBackgroundRecordingSync(lead, callContext) {
  setTimeout(async () => {
    const cbName = '__cbBgRec_' + Math.random().toString(36).slice(2, 10);
    const result = await new Promise(resolve => {
      window[cbName] = (ok, detail) => {
        delete window[cbName];
        resolve({ ok, detail });
      };
      try {
        LeadCRMNative.syncCallRecording(
          callContext.dialedPhone, lead.id ? String(lead.id) : '',
          Math.max(0, callContext.startedAt - 60_000),
          location.origin, CRM.token || '', cbName
        );
      } catch (e) {
        delete window[cbName];
        resolve({ ok: false, detail: e.message });
      }
    });

    if (result.ok) {
      console.log('[leadcrm] bg recording sync ok');
      // Tiny success toast — non-intrusive
      toast('📼 Recording linked to ' + (lead.name || 'lead'));
      if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
    } else {
      const code = String(result.detail || '');
      if (code === 'no_folder') {
        toast('Pick recordings folder in Dialer → Settings to enable auto-sync', 'warn');
      } else if (code === 'folder_unreachable') {
        toast('Recordings folder no longer accessible — re-pick it in Settings', 'warn');
      } else {
        // 'no_match' / network errors / etc — log but don't bother the user
        console.warn('[leadcrm] bg sync skipped:', code);
      }
    }
  }, 5000);
}

// Shared-intent handler — when user shares a phone number into the app
window.onLeadCRMSharedLead = function (text) {
  if (!CRM.user) return;
  const phoneMatch = String(text).match(/(\+?\d[\d\s\-\(\)]{6,})/);
  const phone = phoneMatch ? phoneMatch[1].replace(/[\s\-\(\)]/g, '') : '';
  const name = String(text).replace(phone, '').trim() || 'Shared Contact';
  setTimeout(() => {
    // Open lead modal with name + phone pre-filled
    const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
      h('h3', {}, '📥 Save as lead?'),
      h('p', { class: 'muted' }, 'Received from another app:'),
      h('pre', { class: 'code-block' }, text),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Dismiss'),
        h('button', { class: 'btn primary', onclick: () => {
          modal.remove();
          // Open new lead modal and pre-fill
          openLeadModal();
          setTimeout(() => {
            const f = $('#lead-form'); if (f) {
              if (f.name) f.name.value = name;
              if (f.phone) f.phone.value = phone;
              if (f.whatsapp) f.whatsapp.value = phone;
            }
          }, 200);
        } }, '+ Save as lead')
      )
    ));
    document.body.appendChild(modal);
  }, 300);
};

function promptSaveAsLead(number) {
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, '📞 Unknown number'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
    h('p', {}, 'Incoming/outgoing call with ', h('b', {}, number)),
    h('p', { class: 'muted' }, 'This number isn\'t in your CRM. Save as a new lead?'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Later'),
      h('button', { class: 'btn primary', onclick: () => {
        modal.remove();
        openLeadModal();
        setTimeout(() => {
          const f = $('#lead-form'); if (f) {
            if (f.phone) f.phone.value = number;
            if (f.whatsapp) f.whatsapp.value = number;
            if (f.source) {
              // Add "Incoming Call" as source if not present
              const opt = [...f.source.options].find(o => o.value === 'Incoming Call');
              if (opt) f.source.value = 'Incoming Call';
            }
            if (f.name) f.name.focus();
          }
        }, 200);
      } }, '+ Save as lead')
    )
  ));
  document.body.appendChild(modal);
}

/* ---------------- Web Push subscription ---------------- */
/**
 * Register the browser's Push Manager with our VAPID public key, then send
 * the subscription to the backend so it can push to this device. Idempotent —
 * calling again with an existing subscription just re-syncs it.
 *
 * Once subscribed, the service worker handles `push` events and shows a
 * native banner + sound + vibration EVEN IF THE TAB / INSTALLED APP IS CLOSED.
 * That's the SMS-like behaviour the user wants.
 */
async function registerWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'denied') return;

  // Ask for permission if we haven't yet. Don't be aggressive — only on
  // explicit "default" state. Granted = re-use; Denied = give up silently.
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return;
  }

  const reg = await navigator.serviceWorker.ready;

  // Pull the server's VAPID public key — it's persistent so we cache it.
  let publicKey = sessionStorage.getItem('vapid_pub') || '';
  if (!publicKey) {
    try {
      const r = await api('api_push_publicKey');
      publicKey = r.publicKey || '';
      if (publicKey) sessionStorage.setItem('vapid_pub', publicKey);
    } catch (e) { console.warn('[push] no public key from server:', e.message); return; }
  }
  if (!publicKey) return;

  // Subscribe (or re-use existing). Browsers de-dupe by endpoint, so calling
  // subscribe with the same applicationServerKey is safe and returns the
  // same object.
  let sub;
  try {
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8(publicKey)
      });
    }
  } catch (e) {
    console.warn('[push] subscribe failed:', e.message);
    return;
  }

  // Send the subscription to the backend. Even if it's the same one as
  // before, this refreshes the user_id link in case the user has logged
  // in as someone else on this device.
  try {
    await api('api_push_subscribe', sub.toJSON ? sub.toJSON() : sub, navigator.userAgent);
    console.log('[push] subscription registered');
  } catch (e) { console.warn('[push] register on server failed:', e.message); }
}

/**
 * Register the Capacitor app for Firebase Cloud Messaging push.
 *
 * Only runs inside the native APK — browsers and PWAs go through Web Push
 * (registerWebPush) instead. FCM is what makes notifications survive the
 * Android OS killing the WebView, because Google's servers wake the device
 * directly instead of relying on a service worker.
 *
 * Flow:
 *   1. Request POST_NOTIFICATIONS permission (Android 13+)
 *   2. Register with FCM → token is delivered async via the 'registration' event
 *   3. POST the token to /api → fcm_tokens table
 *   4. Wire 'pushNotificationActionPerformed' so tapping a notification
 *      navigates the WebView to the URL we baked into the data payload.
 */
async function registerCapacitorPush() {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
  const Push = cap.Plugins && cap.Plugins.PushNotifications;
  if (!Push) {
    console.warn('[push] PushNotifications plugin not present (rebuild APK after npm install)');
    return;
  }
  try {
    let perm = await Push.checkPermissions();
    if (perm.receive !== 'granted') {
      perm = await Push.requestPermissions();
    }
    if (perm.receive !== 'granted') {
      console.warn('[push] notification permission not granted on Android');
      return;
    }

    // Listener BEFORE register() — token can arrive within milliseconds.
    Push.addListener('registration', async (tk) => {
      console.log('[push] FCM token received');
      try {
        await api('api_fcm_register', tk.value, 'android', navigator.userAgent);
        console.log('[push] FCM token sent to server');
      } catch (e) { console.warn('[push] FCM token register failed:', e.message); }
    });

    Push.addListener('registrationError', (err) => {
      console.warn('[push] FCM registrationError:', err && err.error);
    });

    // App in foreground: show a toast so users know a push arrived (otherwise
    // FCM only shows the notification when the app is backgrounded).
    Push.addListener('pushNotificationReceived', (n) => {
      try {
        const t = (n && n.title) || 'Lead CRM';
        const b = (n && n.body)  || '';
        if (typeof toast === 'function') toast(t + (b ? ' — ' + b : ''));
      } catch (_) {}
    });

    // Tap → navigate inside the WebView to the URL we put in `data.url`.
    Push.addListener('pushNotificationActionPerformed', (action) => {
      try {
        const url = action && action.notification && action.notification.data && action.notification.data.url;
        if (url) {
          // Hash-routed SPA — `location.hash = '#/foo'` is the right move.
          if (url.startsWith('/#/')) location.hash = url.slice(1);
          else if (url.startsWith('#/')) location.hash = url;
          else if (url.startsWith('/')) location.hash = '#' + url;
          else location.href = url;
        }
      } catch (_) {}
    });

    await Push.register();
  } catch (e) {
    console.warn('[push] Capacitor push register failed:', e && e.message);
  }
}

// Convert the URL-safe base64 VAPID public key into the Uint8Array the
// PushManager API expects.
function _urlBase64ToUint8(s) {
  const padding = '='.repeat((4 - s.length % 4) % 4);
  const base64 = (s + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
  return arr;
}

/* ---------------- Notifications + follow-up popup ---------------- */
let followupPollTimer = null;
let newLeadPollTimer = null;
function startFollowupPolling() {
  if (followupPollTimer) clearInterval(followupPollTimer);
  followupPollTimer = setInterval(refreshNotifs, 60_000);
  // Poll for new leads every 30s — fires a popup + toast when one arrives
  if (newLeadPollTimer) clearInterval(newLeadPollTimer);
  newLeadPollTimer = setInterval(checkNewLeads, 30_000);
  // Also fire an immediate check so the baseline ID is set
  checkNewLeads();
}

/**
 * Refresh the Leads listing. Re-fetches without leaving the page,
 * spins the icon while loading, and surfaces a toast when done.
 */
async function refreshLeads() {
  const btn = document.getElementById('btn-refresh-leads');
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  try {
    await loadLeads();
    // Update baseline so the new-lead poller doesn't re-fire for leads
    // we just pulled in.
    const list = (CRM.cache.lastLeads || []);
    if (list.length) CRM._lastSeenLeadId = Math.max(...list.map(l => Number(l.id) || 0));
    toast('🔄 Leads refreshed (' + list.length + ')');
  } catch (e) { toast(e.message, 'err'); }
  finally {
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

/**
 * Background poller — checks every 30s for new leads with id > last seen.
 * Shows a popup + toast when a new lead arrives. Auto-pulls them into the
 * leads listing if it's currently visible.
 */
async function checkNewLeads() {
  if (!CRM.user) return;
  // Skip polling while the user is actively typing on the dialpad — the
  // tiny background fetch + DOM updates were causing keystroke lag.
  if (location.hash === '#/dialer' && _dialerState && _dialerState.tab === 'pad') return;
  try {
    const d = await api('api_leads_list', { limit: 5 });
    const leads = (d && (d.leads || d)) || [];
    if (!leads.length) return;
    const newest = Math.max(...leads.map(l => Number(l.id) || 0));
    const baseline = Number(CRM._lastSeenLeadId || 0);
    if (!baseline) {
      // First poll — set baseline silently
      CRM._lastSeenLeadId = newest;
      return;
    }
    if (newest > baseline) {
      const fresh = leads
        .filter(l => Number(l.id) > baseline)
        .sort((a, b) => Number(a.id) - Number(b.id));
      CRM._lastSeenLeadId = newest;
      if (fresh.length === 0) return;
      // Show toast + system notification (if granted) + in-app popup
      const summary = fresh.length === 1
        ? `🎯 New lead: ${fresh[0].name || fresh[0].phone || 'Unknown'}`
        : `🎯 ${fresh.length} new leads received`;
      toast(summary);
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          fresh.slice(0, 3).forEach(l => new Notification('🎯 New lead', {
            body: `${l.name || ''} ${l.phone || ''}\nSource: ${l.source || '—'}`,
            tag: 'lead-' + l.id
          }));
        } else if ('Notification' in window && Notification.permission === 'default') {
          // Ask once on first arrival
          Notification.requestPermission().catch(() => {});
        }
      } catch (_) {}
      popupNewLeads(fresh);
      // If the user is on the leads page, refresh inline
      if (location.hash === '#/leads' && typeof loadLeads === 'function') {
        loadLeads();
      }
    }
  } catch (e) { console.warn('[leadcrm] new-lead poll error:', e.message); }
}

let _newLeadPopupShown = false;
function popupNewLeads(leads) {
  if (_newLeadPopupShown) return;
  _newLeadPopupShown = true;
  const close = () => { modal.remove(); _newLeadPopupShown = false; };
  const modal = h('div', { class: 'modal-backdrop popup-new-lead', onclick: ev => { if (ev.target === modal) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '🎯 ' + (leads.length === 1 ? 'New lead' : leads.length + ' new leads')),
        h('button', { class: 'btn icon', onclick: close }, '✕')
      ),
      h('ul', { class: 'new-lead-list' }, ...leads.slice(0, 6).map(l => h('li', {},
        h('div', { class: 'new-lead-row' },
          h('div', { class: 'nl-meta' },
            h('div', {}, h('b', {}, l.name || '—')),
            h('div', { class: 'muted' }, (l.phone || '') + ' · ' + (l.source || '—'))
          ),
          h('button', { class: 'btn sm primary', onclick: () => { close(); openLeadModal(l.id); } }, 'Open')
        )
      ))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, 'Dismiss'),
        h('button', { class: 'btn primary', onclick: () => { close(); navigateTo('leads'); } }, 'See all leads')
      )
    )
  );
  document.body.appendChild(modal);
  // Try to play a soft notification ping (browser-policy permitting)
  try {
    const audio = new Audio('data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjQ1LjEwMAAAAAAAAAAAAAAA//tQwAAACQAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDA');
    audio.volume = 0.3; audio.play().catch(() => {});
  } catch (_) {}
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

// Track which follow-ups we've already fired the popup for so each new reminder
// pops exactly once when its time arrives, instead of either spamming or
// firing only once per session.
const _firedFollowupIds = new Set();
let _popupShown = false;

function popupFollowupDue(d) {
  // Filter the urgent items down to ones we have NOT yet shown a popup for.
  // Use the followup id when available, otherwise lead_id+due_at as a stable key.
  const all = [...(d.overdue || []), ...(d.due_today || [])];
  const fresh = all.filter(f => {
    const key = f.id ? 'fu:' + f.id : 'lead:' + f.lead_id + '@' + f.due_at;
    if (_firedFollowupIds.has(key)) return false;
    _firedFollowupIds.add(key);
    return true;
  });
  if (!fresh.length) return;

  // Browser-level Notification (desktop / Android lock screen) — request
  // permission once on first follow-up arrival; subsequent fires use the
  // already-granted permission silently.
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        fresh.slice(0, 3).forEach(f => new Notification('⏰ Follow-up due', {
          body: `${f.lead_name || ''} ${f.lead_phone ? '· ' + f.lead_phone : ''}\nDue: ${new Date(f.due_at).toLocaleString()}` +
            (f.latest_remark ? `\n${String(f.latest_remark).slice(0, 80)}` : ''),
          tag: 'fu-' + (f.id || (f.lead_id + '-' + f.due_at)),
          requireInteraction: true
        }));
      } else if (Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    }
  } catch (_) {}

  if (_popupShown) return;
  const urgent = fresh.slice(0, 5);
  _popupShown = true;
  const close = () => { modal.remove(); _popupShown = false; };
  const modal = h('div', { class: 'modal-backdrop popup-followup' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, '⏰ Follow-ups due'), h('button', { class: 'btn icon', onclick: close }, '✕')),
      h('ul', { class: 'followup-list' }, ...urgent.map(f => {
        const phone = String(f.lead_phone || '').trim();
        const telHref = phone ? 'tel:' + phone.replace(/[^\d+]/g, '') : null;
        return h('li', {},
          h('b', {}, f.lead_name || '—'), ' — ', f.lead_phone || '',
          h('div', { class: 'muted' }, 'Due: ', fmtDate(f.due_at)),
          f.latest_remark ? h('div', { class: 'fu-latest-remark', style: { marginTop: '.25rem' } },
            '💬 ', String(f.latest_remark).slice(0, 160) + (String(f.latest_remark).length > 160 ? '…' : '')) : null,
          f.note ? h('div', {}, f.note) : null,
          h('div', { class: 'actions' },
            telHref ? h('a', { class: 'btn sm primary', href: telHref }, '📞 Call') : null,
            f.id ? h('button', { class: 'btn sm', onclick: async () => { await api('api_followup_done', f.id); toast('Marked done'); refreshNotifs(); } }, '✓ Done') : null,
            h('button', { class: 'btn sm ghost', onclick: () => { close(); navigateTo('leads'); setTimeout(() => openLeadModal(f.lead_id), 300); } }, 'Open lead')
          )
        );
      })),
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
