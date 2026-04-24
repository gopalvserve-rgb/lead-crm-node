/**
 * Lead CRM frontend
 * Single-page app that talks to POST /api with { fn, args } payloads.
 * Mirrors google.script.run usage from the Apps Script edition.
 */

const CRM = {
  token: localStorage.getItem('crm_token') || null,
  user: null,
  config: { company_name: 'Lead CRM', company_logo_url: '', base_url: location.origin },
  cache: {}
};

// -------------------- API helper --------------------
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
// API helper for non-authed calls (login)
async function apiRaw(fn, ...args) {
  const res = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args })
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error || 'API error');
  return j.result;
}

// -------------------- Boot --------------------
(async () => {
  try {
    const r = await fetch('/config.json');
    if (r.ok) CRM.config = Object.assign(CRM.config, await r.json());
  } catch (_) {}

  if (CRM.token) {
    try {
      CRM.user = await api('api_me');
      renderShell();
      navigateTo('dashboard');
      refreshNotifs();
    } catch (_) { logout(); }
  } else {
    renderLogin();
  }
})();

// -------------------- Render helpers --------------------
function $(sel, ctx) { return (ctx || document).querySelector(sel); }
function $$(sel, ctx) { return [...(ctx || document).querySelectorAll(sel)]; }
function tpl(id) { return document.getElementById(id).content.cloneNode(true); }
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v === false || v == null) {}
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleString(); } catch (_) { return String(s); }
}

function bindTemplate(root) {
  $$('[data-bind]', root).forEach(el => {
    const key = el.dataset.bind;
    let val = '';
    if (key === 'company_name')  val = CRM.config.company_name;
    if (key === 'logo_url')      { if (CRM.config.company_logo_url) el.src = CRM.config.company_logo_url; else el.style.display = 'none'; return; }
    if (key === 'initials')      val = CRM.user ? CRM.user.name.split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase() : '';
    if (key === 'user_name')     val = CRM.user ? CRM.user.name : '';
    if (key === 'user_role')     val = CRM.user ? CRM.user.role : '';
    el.textContent = val;
  });
}

function logout() {
  localStorage.removeItem('crm_token');
  CRM.token = null; CRM.user = null;
  location.reload();
}

// -------------------- Login --------------------
function renderLogin() {
  const app = $('#app');
  app.innerHTML = '';
  app.append(tpl('tpl-login'));
  bindTemplate(app);
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = ev.target.email.value;
    const password = ev.target.password.value;
    $('#login-err').textContent = '';
    try {
      const r = await apiRaw('api_login', email, password);
      CRM.token = r.token; CRM.user = r.user;
      localStorage.setItem('crm_token', r.token);
      location.reload();
    } catch (e) {
      $('#login-err').textContent = e.message;
    }
  });
}

// -------------------- Shell --------------------
const NAV = [
  { id: 'dashboard', label: '📊 Dashboard' },
  { id: 'leads',     label: '🎯 Leads' },
  { id: 'pipeline',  label: '📈 Pipeline' },
  { id: 'kanban',    label: '🗂️ Kanban' },
  { id: 'followups', label: '🔔 Follow-ups' },
  { id: 'reports',   label: '📉 Reports',  roles: ['admin', 'manager', 'team_leader'] },
  { id: 'tasks',     label: '✅ Tasks' },
  { id: 'attendance',label: '🕒 Attendance' },
  { id: 'leaves',    label: '🏖️ Leaves' },
  { id: 'salary',    label: '💰 Salary' },
  { id: 'bank',      label: '🏦 Bank Details' },
  { id: 'users',     label: '👥 Users',    roles: ['admin', 'manager'] },
  { id: 'admin',     label: '⚙️ Settings', roles: ['admin'] }
];

function renderShell() {
  const app = $('#app');
  app.innerHTML = '';
  app.append(tpl('tpl-shell'));
  bindTemplate(app);
  const nav = $('#nav');
  NAV.forEach(item => {
    if (item.roles && !item.roles.includes(CRM.user.role)) return;
    const a = h('a', { href: '#/' + item.id, 'data-view': item.id }, item.label);
    a.addEventListener('click', ev => { ev.preventDefault(); navigateTo(item.id); });
    nav.append(a);
  });
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-notif').addEventListener('click', showNotifs);
}

function navigateTo(id) {
  const item = NAV.find(n => n.id === id) || NAV[0];
  $$('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.view === id));
  $('#page-title').textContent = item.label.replace(/^\S+\s+/, '');
  const view = $('#view');
  view.innerHTML = '<p class="muted">Loading…</p>';
  const fn = VIEWS[id];
  Promise.resolve(fn ? fn(view) : view.innerHTML = '<p>Not found</p>').catch(e => {
    view.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  });
}

// -------------------- Views --------------------
const VIEWS = {};

VIEWS.dashboard = async (view) => {
  const summary = await api('api_reports_summary', {});
  view.innerHTML = '';
  const cards = h('div', { class: 'cards' },
    card('Total Leads', summary.totals.total, 'accent'),
    card('New', summary.totals.new_leads, ''),
    card('Won',  summary.totals.won,  'ok'),
    card('Lost', summary.totals.lost, 'err')
  );
  view.append(cards);

  // Pipeline
  const pipeline = await api('api_reports_funnel', {});
  const pwrap = h('div', { class: 'pipeline' },
    ...pipeline.map(s => h('div', { class: 'stage', style: { borderTop: `3px solid ${s.color}` } },
      h('div', { class: 'count' }, s.count),
      h('div', { class: 'name' }, s.name)
    ))
  );
  view.append(h('h3', {}, 'Pipeline'), pwrap);

  function card(label, val, klass) {
    return h('div', { class: `card ${klass || ''}` },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, val ?? 0)
    );
  }
};

VIEWS.leads = async (view) => {
  const [statuses, sources, products, users] = await Promise.all([
    api('api_statuses_list'), api('api_sources_list'),
    api('api_products_list'), api('api_users_list')
  ]);
  CRM.cache = { statuses, sources, products, users };

  view.innerHTML = '';
  const bar = h('div', { class: 'toolbar' },
    h('input', { placeholder: 'Search name/phone/email…', id: 'f-search' }),
    selectOpts('f-status', [{ id: '', name: 'Any status' }, ...statuses]),
    selectOpts('f-source', [{ id: '', name: 'Any source' }, ...sources.map(s => ({ id: s.name, name: s.name }))]),
    h('button', { class: 'btn', onclick: () => loadLeads() }, 'Filter'),
    h('button', { class: 'btn primary', onclick: () => openLeadModal() }, '+ New Lead')
  );
  view.append(bar);

  const tableWrap = h('div', { class: 'table-wrap' }, h('table', { id: 'leads-table' }));
  view.append(tableWrap);
  await loadLeads();

  async function loadLeads() {
    const filters = {
      q: $('#f-search').value,
      status_id: $('#f-status').value || null,
      source: $('#f-source').value || null
    };
    const { leads } = await api('api_leads_list', filters);
    renderLeadsTable(leads || []);
  }
};

function renderLeadsTable(rows) {
  const table = $('#leads-table');
  if (!table) return;
  const { statuses, users } = CRM.cache;
  table.innerHTML = `
    <thead><tr>
      <th>Name</th><th>Phone</th><th>Source</th><th>Status</th>
      <th>Assigned</th><th>Follow-up</th><th>Created</th><th></th>
    </tr></thead>
    <tbody>
      ${rows.map(l => `
        <tr>
          <td><a href="#" data-lead="${l.id}">${escapeHtml(l.name || '—')}</a></td>
          <td>${escapeHtml(l.phone || '')}
              ${l.phone ? `<button class="btn sm ghost" title="Copy" onclick="navigator.clipboard.writeText('${l.phone}')">📋</button>` : ''}
              ${l.whatsapp ? `<a href="https://wa.me/${l.whatsapp.replace(/\\D/g,'')}" target="_blank" class="btn sm ghost">💬</a>` : ''}
          </td>
          <td>${escapeHtml(l.source || '')}</td>
          <td>
            <select class="status-pill" style="background:${escapeHtml(l.status_color || '#6b7280')}"
                    data-lead-status="${l.id}">
              ${statuses.map(s => `<option value="${s.id}" ${Number(s.id) === Number(l.status_id) ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
            </select>
          </td>
          <td>${escapeHtml(l.assigned_name || '—')}</td>
          <td>${l.next_followup_at ? fmtDate(l.next_followup_at) : ''}</td>
          <td class="muted">${fmtDate(l.created_at)}</td>
          <td><button class="btn sm" data-lead="${l.id}">Edit</button></td>
        </tr>`).join('')}
    </tbody>`;
  $$('a[data-lead], button[data-lead]', table).forEach(a =>
    a.addEventListener('click', ev => { ev.preventDefault(); openLeadModal(Number(a.dataset.lead)); })
  );
  $$('select[data-lead-status]', table).forEach(sel =>
    sel.addEventListener('change', async () => {
      try {
        await api('api_leads_update', Number(sel.dataset.leadStatus), { status_id: Number(sel.value) });
        const opt = CRM.cache.statuses.find(s => Number(s.id) === Number(sel.value));
        if (opt) sel.style.background = opt.color;
      } catch (e) { alert(e.message); }
    })
  );
}

async function openLeadModal(id) {
  const { statuses, sources, products, users } = CRM.cache;
  let lead = { name: '', phone: '', email: '', source: '', status_id: statuses[0]?.id, assigned_to: CRM.user.id, notes: '' };
  let remarks = [];
  if (id) {
    const resp = await api('api_leads_get', id);
    lead = resp.lead; remarks = resp.remarks || [];
  }
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } },
    h('div', { class: 'modal' },
      h('h3', {}, id ? 'Edit Lead' : 'New Lead'),
      h('form', { id: 'lead-form' },
        field('name', 'Name *', lead.name, { required: true }),
        field('phone', 'Phone', lead.phone),
        field('email', 'Email', lead.email, { type: 'email' }),
        field('whatsapp', 'WhatsApp', lead.whatsapp),
        selectField('source', 'Source', lead.source, sources.map(s => s.name)),
        selectField('status_id', 'Status', lead.status_id, statuses.map(s => ({ value: s.id, label: s.name }))),
        selectField('assigned_to', 'Assigned To', lead.assigned_to, users.map(u => ({ value: u.id, label: u.name }))),
        field('notes', 'Notes', lead.notes, { type: 'textarea' }),
        id ? remarksBlock(remarks) : null,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn primary' }, id ? 'Save' : 'Create')
        )
      )
    )
  );
  document.body.append(modal);
  $('#lead-form', modal).addEventListener('submit', async ev => {
    ev.preventDefault();
    const form = ev.target;
    const payload = {
      name: form.name.value, phone: form.phone.value, email: form.email.value,
      whatsapp: form.whatsapp.value, source: form.source.value,
      status_id: Number(form.status_id.value) || null,
      assigned_to: Number(form.assigned_to.value) || null,
      notes: form.notes.value
    };
    try {
      if (id) await api('api_leads_update', id, payload);
      else    await api('api_leads_create', payload);
      modal.remove();
      navigateTo('leads');
    } catch (e) { alert(e.message); }
  });

  if (id) {
    $('#add-remark', modal)?.addEventListener('click', async () => {
      const body = $('#remark-body', modal).value.trim();
      if (!body) return;
      await api('api_leads_addRemark', id, { remark: body });
      const resp = await api('api_leads_get', id);
      const list = $('#remarks-list', modal);
      list.innerHTML = resp.remarks.map(r => `<li><b>${escapeHtml(r.user_name || '—')}</b> · ${fmtDate(r.created_at)}<br>${escapeHtml(r.remark || '')}</li>`).join('');
      $('#remark-body', modal).value = '';
    });
  }

  function remarksBlock(rs) {
    return h('div', { class: 'remarks' },
      h('label', {}, 'Remarks'),
      h('ul', { id: 'remarks-list' },
        ...rs.map(r => h('li', {}, h('b', {}, r.user_name || '—'), ' · ', fmtDate(r.created_at), h('br'), r.remark || ''))
      ),
      h('textarea', { id: 'remark-body', placeholder: 'Add a remark…', rows: 2 }),
      h('button', { type: 'button', class: 'btn sm', id: 'add-remark' }, 'Add remark')
    );
  }
}

function field(name, label, val, opts = {}) {
  const tag = opts.type === 'textarea' ? 'textarea' : 'input';
  const el = h(tag, Object.assign({ name, value: val || '', required: !!opts.required }, opts.type && opts.type !== 'textarea' ? { type: opts.type } : {}));
  if (opts.type === 'textarea') el.textContent = val || '';
  return h('div', {}, h('label', {}, label), el);
}
function selectField(name, label, val, options) {
  const sel = h('select', { name },
    ...options.map(o => {
      const value = typeof o === 'object' ? o.value : o;
      const text  = typeof o === 'object' ? o.label : o;
      return h('option', { value: value, selected: String(val) === String(value) || undefined }, text);
    })
  );
  return h('div', {}, h('label', {}, label), sel);
}
function selectOpts(id, items) {
  return h('select', { id },
    ...items.map(i => h('option', { value: i.id }, i.name))
  );
}

// -------------------- Pipeline & Kanban --------------------
VIEWS.pipeline = async (view) => {
  const funnel = await api('api_reports_funnel', {});
  view.innerHTML = '';
  view.append(
    h('div', { class: 'pipeline' },
      ...funnel.map(s => h('div', { class: 'stage', style: { borderTop: `3px solid ${s.color}` } },
        h('div', { class: 'count' }, s.count),
        h('div', { class: 'name' }, s.name)
      ))
    )
  );
};

VIEWS.kanban = async (view) => {
  const statuses = await api('api_statuses_list');
  const kanban = await api('api_leads_pipeline');
  view.innerHTML = '';
  const wrap = h('div', { class: 'kanban' });
  statuses.forEach(s => {
    const rows = kanban.find(k => Number(k.id) === Number(s.id))?.leads || [];
    const col = h('div', { class: 'kanban-col' },
      h('h4', { style: { color: s.color } }, s.name, h('span', {}, rows.length)),
      ...rows.map(l => h('div', { class: 'kanban-card' },
        h('div', { class: 'name' }, l.name || '—'),
        h('div', { class: 'meta' }, `${l.phone || ''} · ${l.source || ''}`)
      ))
    );
    wrap.append(col);
  });
  view.append(wrap);
};

// -------------------- Follow-ups --------------------
VIEWS.followups = async (view) => {
  const data = await api('api_notifications_mine');
  view.innerHTML = '';
  section('Overdue', data.overdue);
  section('Due Today', data.due_today);
  section('Upcoming', data.upcoming);
  function section(title, rows) {
    view.append(h('h3', {}, `${title} (${rows.length})`));
    if (!rows.length) { view.append(h('p', { class: 'muted' }, 'Nothing here.')); return; }
    const tbl = h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Lead'), h('th', {}, 'Phone'), h('th', {}, 'Due'), h('th', {}, 'Note'), h('th', {}))),
        h('tbody', {},
          ...rows.map(r => h('tr', {},
            h('td', {}, r.lead_name || ''),
            h('td', {}, r.lead_phone || ''),
            h('td', {}, fmtDate(r.due_at)),
            h('td', {}, r.note || ''),
            h('td', {}, h('button', { class: 'btn sm', onclick: async () => { await api('api_followup_done', r.id); navigateTo('followups'); } }, '✓ Done'))
          ))
        )
      )
    );
    view.append(tbl);
  }
};

// -------------------- Reports --------------------
VIEWS.reports = async (view) => {
  const r = await api('api_reports_summary', {});
  view.innerHTML = '';
  view.append(
    h('div', { class: 'cards' },
      h('div', { class: 'card accent' }, h('div', { class: 'label' }, 'Total'), h('div', { class: 'value' }, r.totals.total)),
      h('div', { class: 'card' },         h('div', { class: 'label' }, 'New'),   h('div', { class: 'value' }, r.totals.new_leads)),
      h('div', { class: 'card ok' },      h('div', { class: 'label' }, 'Won'),   h('div', { class: 'value' }, r.totals.won)),
      h('div', { class: 'card err' },     h('div', { class: 'label' }, 'Lost'),  h('div', { class: 'value' }, r.totals.lost))
    )
  );
  view.append(h('h3', {}, 'By user'));
  view.append(tableFrom(r.by_user, ['name', 'role', 'total', 'new_leads', 'open_leads', 'won', 'lost']));
  view.append(h('h3', {}, 'By status'));
  view.append(tableFrom(r.by_status, ['status', 'c']));
  view.append(h('h3', {}, 'By source'));
  view.append(tableFrom(r.by_source, ['source', 'c']));

  function tableFrom(arr, cols) {
    return h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, ...cols.map(c => h('th', {}, c)))),
        h('tbody', {}, ...arr.map(row => h('tr', {}, ...cols.map(c => h('td', {}, row[c] ?? '')))))
      )
    );
  }
};

// -------------------- HR views --------------------
VIEWS.tasks = async (view) => {
  const rows = await api('api_tasks_list', {});
  view.innerHTML = '';
  view.append(
    h('button', { class: 'btn primary', onclick: () => openTaskModal() }, '+ New Task'),
    h('div', { class: 'table-wrap', style: { marginTop: '1rem' } },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Assigned'), h('th', {}, 'Due'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, ...rows.map(t => h('tr', {},
          h('td', {}, t.title),
          h('td', {}, t.assigned_name || ''),
          h('td', {}, fmtDate(t.due_at)),
          h('td', {}, t.status),
          h('td', {}, t.status !== 'done'
            ? h('button', { class: 'btn sm', onclick: async () => { await api('api_tasks_complete', t.id); navigateTo('tasks'); } }, '✓ Done')
            : null
          )
        )))
      )
    )
  );
};
async function openTaskModal() {
  const users = await api('api_users_list');
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, 'New Task'),
    h('form', { id: 'task-form' },
      field('title', 'Title *', '', { required: true }),
      field('description', 'Description', '', { type: 'textarea' }),
      selectField('assigned_to', 'Assigned To', CRM.user.id, users.map(u => ({ value: u.id, label: u.name }))),
      field('due_at', 'Due', '', { type: 'datetime-local' }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Create')
      )
    )
  ));
  document.body.append(modal);
  $('#task-form', modal).addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    await api('api_tasks_save', {
      title: f.title.value, description: f.description.value,
      assigned_to: Number(f.assigned_to.value),
      due_at: f.due_at.value || null
    });
    modal.remove();
    navigateTo('tasks');
  });
}

VIEWS.attendance = async (view) => {
  const rows = await api('api_attendance_mine');
  view.innerHTML = '';
  view.append(
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: checkIn }, 'Check In'),
      h('button', { class: 'btn', onclick: checkOut }, 'Check Out')
    ),
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'In'), h('th', {}, 'Out'), h('th', {}, 'Status'))),
        h('tbody', {}, ...rows.map(r => h('tr', {},
          h('td', {}, r.date),
          h('td', {}, fmtDate(r.check_in)),
          h('td', {}, fmtDate(r.check_out)),
          h('td', {}, r.status || '')
        )))
      )
    )
  );
  async function checkIn() {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(async pos => {
        try { await api('api_attendance_checkIn', pos.coords.latitude, pos.coords.longitude); navigateTo('attendance'); }
        catch (e) { alert(e.message); }
      }, async () => {
        try { await api('api_attendance_checkIn', null, null); navigateTo('attendance'); }
        catch (e) { alert(e.message); }
      });
    } else {
      try { await api('api_attendance_checkIn', null, null); navigateTo('attendance'); }
      catch (e) { alert(e.message); }
    }
  }
  async function checkOut() {
    try { await api('api_attendance_checkOut', null, null); navigateTo('attendance'); }
    catch (e) { alert(e.message); }
  }
};

VIEWS.leaves = async (view) => {
  const rows = await api('api_leaves_mine');
  view.innerHTML = '';
  view.append(
    h('button', { class: 'btn primary', onclick: openLeaveModal }, '+ Apply for Leave'),
    h('div', { class: 'table-wrap', style: { marginTop: '1rem' } },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'From'), h('th', {}, 'To'), h('th', {}, 'Reason'), h('th', {}, 'Status'))),
        h('tbody', {}, ...rows.map(l => h('tr', {},
          h('td', {}, l.from_date),
          h('td', {}, l.to_date),
          h('td', {}, l.reason || ''),
          h('td', {}, l.status)
        )))
      )
    )
  );
};
function openLeaveModal() {
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, 'Apply for leave'),
    h('form', { id: 'lv-form' },
      field('from_date', 'From', '', { type: 'date', required: true }),
      field('to_date', 'To', '', { type: 'date', required: true }),
      field('reason', 'Reason', '', { type: 'textarea' }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Apply')
      )
    )
  ));
  document.body.append(modal);
  $('#lv-form', modal).addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    await api('api_leaves_apply', { from_date: f.from_date.value, to_date: f.to_date.value, reason: f.reason.value });
    modal.remove();
    navigateTo('leaves');
  });
}

VIEWS.salary = async (view) => {
  const rows = await api('api_salary_mine');
  view.innerHTML = '';
  view.append(h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Base'), h('th', {}, 'Allowances'), h('th', {}, 'Deductions'), h('th', {}, 'Net'))),
      h('tbody', {}, ...rows.map(s => h('tr', {},
        h('td', {}, s.month),
        h('td', {}, Number(s.base).toFixed(2)),
        h('td', {}, Number(s.allowances).toFixed(2)),
        h('td', {}, Number(s.deductions).toFixed(2)),
        h('td', {}, Number(s.net_pay).toFixed(2))
      )))
    )
  ));
};

VIEWS.bank = async (view) => {
  const info = (await api('api_bank_mine')) || {};
  view.innerHTML = '';
  const form = h('form', { id: 'bank-form' },
    field('bank_name', 'Bank Name', info.bank_name),
    field('account_holder', 'Account Holder', info.account_holder),
    field('account_number', 'Account Number', info.account_number),
    field('ifsc', 'IFSC', info.ifsc),
    field('branch', 'Branch', info.branch),
    field('upi_id', 'UPI ID', info.upi_id),
    field('notes', 'Notes', info.notes, { type: 'textarea' }),
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'btn primary' }, 'Save')
    )
  );
  view.append(form);
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    await api('api_bank_save', {
      bank_name: f.bank_name.value, account_holder: f.account_holder.value,
      account_number: f.account_number.value, ifsc: f.ifsc.value,
      branch: f.branch.value, upi_id: f.upi_id.value, notes: f.notes.value
    });
    alert('Saved.');
  });
};

VIEWS.users = async (view) => {
  const users = await api('api_users_list');
  view.innerHTML = '';
  view.append(
    h('button', { class: 'btn primary', onclick: () => openUserModal() }, '+ New User'),
    h('div', { class: 'table-wrap', style: { marginTop: '1rem' } },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Department'), h('th', {}))),
        h('tbody', {}, ...users.map(u => h('tr', {},
          h('td', {}, u.name),
          h('td', {}, u.email),
          h('td', {}, u.role),
          h('td', {}, u.department || ''),
          h('td', {}, h('button', { class: 'btn sm', onclick: () => openUserModal(u) }, 'Edit'))
        )))
      )
    )
  );
};
async function openUserModal(user) {
  user = user || { role: 'sales', is_active: 1 };
  const parents = await api('api_users_list');
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, user.id ? 'Edit User' : 'New User'),
    h('form', { id: 'u-form' },
      field('name', 'Name *', user.name, { required: true }),
      field('email', 'Email *', user.email, { required: true, type: 'email' }),
      field('phone', 'Phone', user.phone),
      selectField('role', 'Role', user.role, ['admin', 'manager', 'team_leader', 'sales']),
      selectField('parent_id', 'Reports To', user.parent_id || '', [{ value: '', label: '— None —' }, ...parents.map(p => ({ value: p.id, label: p.name }))]),
      field('department', 'Department', user.department),
      field('designation', 'Designation', user.designation),
      user.id ? null : field('password', 'Password', '', { type: 'password', required: true }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Save')
      )
    )
  ));
  document.body.append(modal);
  $('#u-form', modal).addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    const payload = {
      id: user.id,
      name: f.name.value, email: f.email.value, phone: f.phone.value,
      role: f.role.value, parent_id: f.parent_id.value || null,
      department: f.department.value, designation: f.designation.value
    };
    if (!user.id) payload.password = f.password.value;
    await api('api_users_save', payload);
    modal.remove();
    navigateTo('users');
  });
}

VIEWS.admin = async (view) => {
  const cfg = await api('api_admin_getConfig');
  const fb  = await api('api_fb_status').catch(() => ({ connected: false }));
  view.innerHTML = '';
  view.append(
    h('h3', {}, '🏢 Company'),
    configForm(cfg, ['COMPANY_NAME', 'COMPANY_LOGO_URL']),
    h('h3', {}, '📘 Facebook / Meta'),
    h('p', {}, fb.connected
      ? `Connected to: ${escapeHtml(fb.page_name || fb.page_id)}`
      : 'Not connected.'
    ),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: connectFacebook }, 'Connect with Facebook'),
      fb.connected ? h('button', { class: 'btn', onclick: async () => { await api('api_fb_disconnect'); navigateTo('admin'); } }, 'Disconnect') : null
    ),
    h('h3', {}, '🎯 Duplicate Lead Policy'),
    configForm(cfg, ['DUPLICATE_POLICY', 'DUPLICATE_WINDOW_HOURS', 'DUPLICATE_MATCH_FIELDS']),
    h('h3', {}, '📧 Email notifications (SMTP)'),
    configForm(cfg, ['EMAIL_NOTIFY_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_NOTIFY_FROM'])
  );
};
function configForm(cfg, keys) {
  const form = h('form', { onsubmit: async ev => {
    ev.preventDefault();
    const patch = {};
    keys.forEach(k => { patch[k] = form[k].value; });
    await api('api_admin_setConfig', patch);
    alert('Saved.');
  }});
  keys.forEach(k => form.append(h('div', {}, h('label', {}, k), h('input', { name: k, value: cfg[k] || '' }))));
  form.append(h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
  return form;
}

// -------------------- Facebook embedded login --------------------
function connectFacebook() {
  if (!window.FB) {
    const appId = prompt('This server has no Meta SDK loaded. Paste META_APP_ID to initialize:');
    if (!appId) return;
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.onload = () => {
      FB.init({ appId, cookie: true, xfbml: false, version: 'v19.0' });
      _doFbLogin();
    };
    document.body.append(s);
  } else {
    _doFbLogin();
  }
}
function _doFbLogin() {
  FB.login(async (resp) => {
    if (!resp.authResponse) return alert('FB login cancelled.');
    try {
      const r = await api('api_fb_connect', resp.authResponse.accessToken);
      alert('Connected to page: ' + (r.page_name || r.page_id));
      navigateTo('admin');
    } catch (e) { alert(e.message); }
  }, { scope: 'pages_show_list,pages_manage_metadata,leads_retrieval,pages_read_engagement' });
}

// -------------------- Notifications --------------------
async function refreshNotifs() {
  try {
    const d = await api('api_notifications_mine');
    const n = d.counts.overdue + d.counts.due_today + d.counts.unread;
    const badge = $('#notif-count');
    if (badge) { badge.textContent = n; badge.hidden = n === 0; }
  } catch (_) {}
}
async function showNotifs() {
  const d = await api('api_notifications_mine');
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } },
    h('div', { class: 'modal' },
      h('h3', {}, 'Notifications'),
      d.unread_notifications.length
        ? h('ul', {}, ...d.unread_notifications.map(n => h('li', {}, h('b', {}, n.title), h('br'), n.body)))
        : h('p', { class: 'muted' }, 'No unread notifications.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => { await api('api_notifications_read_all'); refreshNotifs(); modal.remove(); } }, 'Mark all read'),
        h('button', { class: 'btn primary', onclick: () => modal.remove() }, 'Close')
      )
    )
  );
  document.body.append(modal);
}
