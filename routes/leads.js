const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

function _parseExtra(lead) {
  if (!lead) return {};
  try {
    const raw = lead.extra_json;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    return JSON.parse(String(raw));
  } catch (_) { return {}; }
}

async function _lookups() {
  const [usersArr, statusesArr, productsArr] = await Promise.all([
    db.getAll('users'), db.getAll('statuses'), db.getAll('products')
  ]);
  const usersById = {}, statusesById = {}, productsById = {};
  usersArr.forEach(u => { usersById[Number(u.id)] = u; });
  statusesArr.forEach(s => { statusesById[Number(s.id)] = s; });
  productsArr.forEach(p => { productsById[Number(p.id)] = p; });
  return { usersById, statusesById, productsById };
}

function _hydrate(l, usersById, statusesById, productsById) {
  const u = usersById[Number(l.assigned_to)];
  const s = statusesById[Number(l.status_id)];
  const p = productsById[Number(l.product_id)];
  return Object.assign({}, l, {
    assigned_name: u ? u.name : '',
    status_name: s ? s.name : '',
    status_color: s ? s.color : '#6b7280',
    product_name: p ? p.name : '',
    extra: _parseExtra(l)
  });
}

function _isVisible(me, visible, lead) {
  if (me.role === 'admin') return true;
  if (!lead.assigned_to) return false;
  return visible.includes(Number(lead.assigned_to));
}

// Duplicate detection
async function _findDuplicate(payload) {
  const policy = process.env.DUPLICATE_POLICY || 'allow';
  if (policy === 'allow') return null;
  const hours = Number(process.env.DUPLICATE_WINDOW_HOURS) || 24;
  const fields = String(process.env.DUPLICATE_MATCH_FIELDS || 'phone,email')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!hours || !fields.length) return null;

  const phone = String(payload.phone || '').replace(/\D/g, '');
  const email = String(payload.email || '').trim().toLowerCase();
  const wa    = String(payload.whatsapp || '').replace(/\D/g, '');
  if (!phone && !email && !wa) return null;

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const leads = (await db.getAll('leads')).filter(l => String(l.created_at) >= since);
  for (const l of leads) {
    const lp = String(l.phone || '').replace(/\D/g, '');
    const lw = String(l.whatsapp || '').replace(/\D/g, '');
    const le = String(l.email || '').trim().toLowerCase();
    if (fields.includes('phone')) {
      if (phone && (phone === lp || phone === lw)) return l;
      if (wa && (wa === lp || wa === lw)) return l;
    }
    if (fields.includes('email')) {
      if (email && email === le) return l;
    }
  }
  return null;
}

async function _applyDuplicatePolicy(payload, fallbackUserId) {
  const match = await _findDuplicate(payload);
  if (!match) return { payload, duplicate: false, matched_id: null };
  const policy = process.env.DUPLICATE_POLICY || 'allow';
  const out = Object.assign({}, payload);
  if (policy === 'reject') {
    const err = new Error('DUPLICATE: matched existing lead id ' + match.id);
    err.matched_id = match.id;
    throw err;
  }
  if (policy === 'assign_same_user') {
    out.assigned_to = match.assigned_to || fallbackUserId || '';
  } else if (policy === 'skip_assignment') {
    out.assigned_to = '';
  }
  return { payload: out, duplicate: true, matched_id: match.id, matched_assigned_to: match.assigned_to || '' };
}

async function _newStatusId() {
  const s = await db.findOneBy('statuses', 'name', 'New');
  return s ? s.id : '';
}

/**
 * Resolve a status NAME (e.g. "Follow Up", "Converted") to a status_id.
 * Case-insensitive, trims whitespace. Auto-creates the status if it doesn't
 * exist yet — that way bulk CSV imports just work even when the spreadsheet
 * has status values the admin hasn't pre-defined.
 *
 * Pass an empty/falsy raw to fall back to the default "New" status.
 */
async function _resolveStatusIdByName(raw) {
  const name = String(raw || '').trim();
  if (!name) return await _newStatusId();
  // Already an integer ID? Trust it.
  if (/^\d+$/.test(name)) return Number(name);
  const all = await db.getAll('statuses');
  const lower = name.toLowerCase();
  const match = all.find(s => String(s.name || '').trim().toLowerCase() === lower);
  if (match) return Number(match.id);
  // Auto-create with neutral grey colour, sorted to the bottom so it doesn't
  // disrupt the existing pipeline order. Admin can recolour / reorder later.
  const newId = await db.insert('statuses', {
    name, color: '#94a3b8', sort_order: 900, is_final: 0
  });
  return Number(newId);
}

/**
 * Resolve a product NAME to a product_id. Same pattern as statuses.
 */
async function _resolveProductIdByName(raw) {
  const name = String(raw || '').trim();
  if (!name) return '';
  if (/^\d+$/.test(name)) return Number(name);
  const all = await db.getAll('products');
  const lower = name.toLowerCase();
  const match = all.find(p => String(p.name || '').trim().toLowerCase() === lower);
  if (match) return Number(match.id);
  const newId = await db.insert('products', {
    name, description: '', price: 0, is_active: 1
  });
  return Number(newId);
}

async function api_leads_list(token, filters) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const { usersById, statusesById, productsById } = await _lookups();
  filters = filters || {};
  let rows = (await db.getAll('leads')).filter(l => _isVisible(me, visible, l));

  if (filters.status_id)   rows = rows.filter(l => Number(l.status_id) === Number(filters.status_id));
  if (filters.source)      rows = rows.filter(l => l.source === filters.source);
  if (filters.product_id)  rows = rows.filter(l => Number(l.product_id) === Number(filters.product_id));
  if (filters.assigned_to) rows = rows.filter(l => Number(l.assigned_to) === Number(filters.assigned_to));
  if (filters.from)        rows = rows.filter(l => String(l.created_at).slice(0, 10) >= filters.from);
  if (filters.to)          rows = rows.filter(l => String(l.created_at).slice(0, 10) <= filters.to);
  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    rows = rows.filter(l =>
      String(l.name || '').toLowerCase().includes(q) ||
      String(l.email || '').toLowerCase().includes(q) ||
      String(l.phone || '').toLowerCase().includes(q) ||
      String(l.whatsapp || '').toLowerCase().includes(q) ||
      String(l.notes || '').toLowerCase().includes(q)
    );
  }
  if (filters.followup === 'today') {
    const today = new Date().toISOString().slice(0, 10);
    rows = rows.filter(l => String(l.next_followup_at || '').slice(0, 10) === today);
  } else if (filters.followup === 'overdue') {
    const now = new Date().toISOString();
    rows = rows.filter(l => l.next_followup_at && String(l.next_followup_at) < now);
  }

  // Duplicate filter:
  //   'only'   → show only duplicates
  //   'unique' → show only non-duplicates
  if (filters.duplicate === 'only')        rows = rows.filter(l => Number(l.is_duplicate) === 1);
  else if (filters.duplicate === 'unique') rows = rows.filter(l => Number(l.is_duplicate) !== 1);

  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = rows.length;
  const statusCount = {};
  rows.forEach(l => { const sid = Number(l.status_id) || 0; statusCount[sid] = (statusCount[sid] || 0) + 1; });

  const page = Number(filters.page || 1);
  const pageSize = Math.min(Number(filters.page_size || 100), 500);
  rows = rows.slice((page - 1) * pageSize, page * pageSize);

  const remarks = await db.getAll('remarks');
  const remarksByLead = {};
  remarks.forEach(r => {
    const k = Number(r.lead_id);
    const prev = remarksByLead[k];
    if (!prev || String(r.created_at) > String(prev.created_at)) remarksByLead[k] = r;
  });

  const hydrated = rows.map(l => {
    const h = _hydrate(l, usersById, statusesById, productsById);
    const r = remarksByLead[Number(l.id)];
    h.recent_remark = r ? r.remark : '';
    h.recent_remark_at = r ? r.created_at : '';
    return h;
  });
  return { leads: hydrated, total, page, page_size: pageSize, status_count: statusCount };
}

async function api_leads_statusCounts(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const rows = (await db.getAll('leads')).filter(l => _isVisible(me, visible, l));
  const out = {};
  rows.forEach(l => { const k = Number(l.status_id) || 0; out[k] = (out[k] || 0) + 1; });
  return out;
}

async function api_leads_get(token, id) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const lead = await db.findById('leads', id);
  if (!lead) throw new Error('Not found');
  if (!_isVisible(me, visible, lead)) throw new Error('Forbidden');

  const { usersById, statusesById, productsById } = await _lookups();
  const hydrated = _hydrate(lead, usersById, statusesById, productsById);

  const remarks = (await db.getAll('remarks'))
    .filter(r => Number(r.lead_id) === Number(id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(r => Object.assign({}, r, {
      user_name: usersById[Number(r.user_id)]?.name || 'System',
      status_name: statusesById[Number(r.status_id)]?.name || ''
    }));
  const followups = (await db.getAll('followups'))
    .filter(f => Number(f.lead_id) === Number(id))
    .sort((a, b) => String(b.due_at).localeCompare(String(a.due_at)))
    .map(f => Object.assign({}, f, { user_name: usersById[Number(f.user_id)]?.name || '' }));
  const messages = (await db.getAll('whatsapp_messages'))
    .filter(m => Number(m.lead_id) === Number(id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  return { lead: hydrated, remarks, followups, messages };
}

async function api_leads_create(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.name) throw new Error('name required');

  // Mobile number is required — leads without a contact phone are essentially
  // un-followable, so reject them at the API layer (covers both manual lead
  // form and CSV bulk import). Strip Excel artefacts before checking.
  // Also accept `mobile`, `whatsapp`, `contact` as aliases so CSV uploads with
  // any of those columns still work.
  const _phoneRaw =
    p.phone ?? p.mobile ?? p.contact ?? p.whatsapp ?? p.mobile_number ?? p.contact_number ?? '';
  const _phoneDigits = String(_phoneRaw || '').trim().replace(/^'/, '').replace(/\D/g, '');
  if (!_phoneDigits) throw new Error('Mobile number is required');

  // Resolve assigned_to: accepts integer ID, email, or full name.
  // Recognises common CSV column aliases people actually use:
  //   assigned_to / user / owner / assignee / sales_rep / salesperson / agent
  let resolvedAssignee = '';
  const rawAssignSrc =
    p.assigned_to ?? p.user ?? p.owner ?? p.assignee ??
    p.sales_rep ?? p.salesperson ?? p.agent ?? p.assigned_user ?? p.rep ?? '';
  const rawAssign = String(rawAssignSrc || '').trim();
  if (rawAssign) {
    if (/^\d+$/.test(rawAssign)) {
      resolvedAssignee = Number(rawAssign);
    } else {
      const allUsers = await db.getAll('users');
      const lower = rawAssign.toLowerCase();
      const norm  = lower.replace(/\s+/g, ' '); // collapse internal spaces too
      const byEmail = allUsers.find(u => String(u.email || '').trim().toLowerCase() === lower);
      const byName  = allUsers.find(u => String(u.name  || '').trim().toLowerCase() === norm);
      // Fallback: case-insensitive substring match (handles "Manoj" vs "Manoj Kumar ")
      const byPartial = !byEmail && !byName
        ? allUsers.find(u => {
            const n = String(u.name || '').trim().toLowerCase();
            return n && (n === norm || n.includes(norm) || norm.includes(n));
          })
        : null;
      if (byEmail) resolvedAssignee = Number(byEmail.id);
      else if (byName) resolvedAssignee = Number(byName.id);
      else if (byPartial) resolvedAssignee = Number(byPartial.id);
      // If we couldn't resolve, leave blank so assignment rules can take over
    }
  }

  // Normalize phone — strip Excel artefacts (leading apostrophe used to force text)
  const cleanPhone = String(p.phone || '').trim().replace(/^'/, '');
  const cleanWA    = String(p.whatsapp || cleanPhone || '').trim().replace(/^'/, '');

  // Resolve status_id: prefer numeric `status_id`, otherwise look up `status`
  // by NAME (the natural shape of CSV imports). Auto-creates missing statuses.
  // Same idea for product_id / product.
  const resolvedStatusId = p.status_id
    ? Number(p.status_id)
    : await _resolveStatusIdByName(p.status);
  const resolvedProductId = p.product_id
    ? Number(p.product_id)
    : (p.product ? await _resolveProductIdByName(p.product) : '');

  let base = {
    name: String(p.name).trim(),
    email: String(p.email || '').trim(),
    phone: cleanPhone,
    whatsapp: cleanWA,
    source: p.source || 'manual',
    source_ref: p.source_ref || '',
    product_id: resolvedProductId,
    status_id: resolvedStatusId || (await _newStatusId()),
    assigned_to: resolvedAssignee || me.id,
    city: p.city || '',
    tags: p.tags || '',
    notes: p.notes || '',
    extra_json: p.extra ? JSON.stringify(p.extra) : '',
    next_followup_at: p.next_followup_at || '',
    last_status_change_at: db.nowIso(),
    created_by: me.id
  };
  const dup = await _applyDuplicatePolicy(base, me.id);
  base = dup.payload;
  base.is_duplicate = dup.duplicate ? 1 : 0;
  // Also flag is_duplicate=1 if the row's tag/notes explicitly say "Duplicate"
  // — common in spreadsheets exported from older CRMs where users tag dupes
  // manually. Word-boundary match so "Not Duplicate" doesn't trigger.
  if (!base.is_duplicate && /\b(duplicate|dup)\b/i.test(String(base.tags || ''))) {
    base.is_duplicate = 1;
  }
  base.duplicate_of = dup.duplicate ? dup.matched_id : '';
  const id = await db.insert('leads', base);
  if (dup.duplicate) {
    await db.insert('remarks', {
      lead_id: id, user_id: me.id,
      remark: '⚠️ Duplicate of lead #' + dup.matched_id + ' (policy: ' + (process.env.DUPLICATE_POLICY || 'allow') + ')',
      status_id: ''
    });
  }
  // Sync followup + fire automations
  if (base.next_followup_at) {
    await _syncFollowup(id, base.assigned_to || me.id, base.next_followup_at, '');
  }
  try { require('../utils/automations').fire('lead_created', { lead: Object.assign({ id }, base), user: me }); } catch (_) {}

  // ---- Email notifications (fire-and-forget) ----
  setImmediate(async () => {
    try {
      const mailer = require('../utils/mailer');
      const cfg = (await db.getAll('config').catch(() => [])).reduce((a, r) => (a[r.key] = r.value, a), {});
      const baseUrl = cfg.BASE_URL || process.env.BASE_URL || '';
      const lead_url = baseUrl ? baseUrl + '/#/leads' : '#/leads';

      const ctx = {
        name: base.name, phone: base.phone, email: base.email,
        source: base.source, city: base.city, tags: base.tags,
        notes: base.notes,
        lead_url
      };

      // 1. New lead → admins + manager(s)
      const adminUsers = (await db.getAll('users')).filter(u =>
        u.email && (u.role === 'admin' || u.role === 'manager') && Number(u.is_active) === 1
      );
      for (const u of adminUsers) {
        await mailer.sendEvent('new_lead', Object.assign({ to: u.email }, ctx));
      }
      // 2. Lead assigned → the assignee (if not the same person who created it)
      if (resolvedAssignee && Number(resolvedAssignee) !== Number(me.id)) {
        const assignee = await db.findById('users', resolvedAssignee).catch(() => null);
        if (assignee && assignee.email) {
          await mailer.sendEvent('lead_assigned', Object.assign({ to: assignee.email }, ctx, {
            assigned_name: assignee.name,
            assigned_first_name: (assignee.name || '').split(' ')[0],
            assigned_email: assignee.email
          }));
        }
      }
    } catch (e) { console.warn('[mailer] lead_created notify failed:', e.message); }

    // ---- Web Push (SMS-style) — fires on user's phone even if app is closed ----
    try {
      const push = require('./push');
      if (resolvedAssignee && Number(resolvedAssignee) !== Number(me.id)) {
        await push.sendPushToUser(resolvedAssignee, {
          title: '🎯 New lead assigned',
          body:  `${base.name || 'Unknown'} ${base.phone ? '· ' + base.phone : ''}${base.source ? '\nSource: ' + base.source : ''}`,
          url:   '/#/leads',
          tag:   'lead-' + id,
          sticky: true
        });
      }
    } catch (e) { console.warn('[push] lead_assigned failed:', e.message); }
  });

  return { id, duplicate: dup.duplicate, matched_id: dup.matched_id };
}

async function api_leads_update(token, id, patch) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const lead = await db.findById('leads', id);
  if (!lead) throw new Error('Not found');
  if (!_isVisible(me, visible, lead)) throw new Error('Forbidden');

  const allowed = {};
  ['name', 'email', 'phone', 'whatsapp', 'product_id', 'status_id', 'assigned_to',
   'city', 'state', 'pincode', 'country', 'company', 'address',
   'notes', 'next_followup_at', 'tags', 'source', 'source_ref',
   'value', 'currency']
    .forEach(k => { if (k in patch) allowed[k] = patch[k]; });
  allowed.updated_at = db.nowIso();

  if (patch.extra && typeof patch.extra === 'object') {
    const curr = _parseExtra(lead);
    allowed.extra_json = JSON.stringify(Object.assign({}, curr, patch.extra));
  }
  const statusChanged = patch.status_id && Number(patch.status_id) !== Number(lead.status_id);
  const assigneeChanged = patch.assigned_to && Number(patch.assigned_to) !== Number(lead.assigned_to);
  if (statusChanged) allowed.last_status_change_at = db.nowIso();

  await db.update('leads', id, allowed);

  // Sync next_followup_at → followups table so reminder/notification views find it
  if ('next_followup_at' in patch) {
    await _syncFollowup(id, me.id, patch.next_followup_at, patch.followup_note || '');
  }

  if (statusChanged) {
    const s = await db.findById('statuses', patch.status_id);
    await db.insert('remarks', {
      lead_id: id, user_id: me.id,
      remark: 'Status changed to ' + (s ? s.name : ''),
      status_id: patch.status_id
    });
    // Fire automations
    try { require('../utils/automations').fire('status_changed', { lead: Object.assign({}, lead, allowed), user: me, new_status: s }); } catch (_) {}
  }
  if (assigneeChanged) {
    try { require('../utils/automations').fire('lead_assigned', { lead: Object.assign({}, lead, allowed), user: me }); } catch (_) {}
    // Direct push to the new assignee — same SMS-style banner the lead-create
    // flow uses. Fire-and-forget so we don't block the response.
    setImmediate(async () => {
      try {
        const newAssignee = Number(patch.assigned_to);
        if (!newAssignee || newAssignee === Number(me.id)) return;
        const push = require('./push');
        const updatedLead = Object.assign({}, lead, allowed);
        await push.sendPushToUser(newAssignee, {
          title: '🎯 Lead reassigned to you',
          body:  `${updatedLead.name || 'Unknown'}${updatedLead.phone ? ' · ' + updatedLead.phone : ''}${updatedLead.source ? '\nSource: ' + updatedLead.source : ''}`,
          url:   '/#/leads',
          tag:   'lead-' + id,
          sticky: true
        });
      } catch (e) { console.warn('[push] reassign notify failed:', e.message); }
    });
  }
  return { ok: true };
}

// Sync helper — creates or updates a followup row when the lead's next_followup_at changes
async function _syncFollowup(leadId, userId, dueAt, note) {
  const existing = (await db.getAll('followups')).filter(f =>
    Number(f.lead_id) === Number(leadId) && Number(f.is_done) === 0
  );
  if (!dueAt) {
    // Mark existing open follow-ups done
    for (const f of existing) await db.update('followups', f.id, { is_done: 1, done_at: db.nowIso() });
    return;
  }
  if (existing.length > 0) {
    await db.update('followups', existing[0].id, { due_at: dueAt, note: note || existing[0].note || '' });
    for (let i = 1; i < existing.length; i++) {
      await db.update('followups', existing[i].id, { is_done: 1, done_at: db.nowIso() });
    }
  } else {
    await db.insert('followups', {
      lead_id: leadId, user_id: userId, due_at: dueAt,
      note: note || '', is_done: 0, created_at: db.nowIso()
    });
  }
}

async function api_leads_addRemark(token, leadId, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.remark) throw new Error('remark required');
  await db.insert('remarks', {
    lead_id: leadId, user_id: me.id,
    remark: p.remark, status_id: p.status_id || ''
  });
  const leadPatch = { updated_at: db.nowIso() };
  if (p.status_id) leadPatch.status_id = p.status_id;
  if (p.next_followup_at) leadPatch.next_followup_at = p.next_followup_at;
  await db.update('leads', leadId, leadPatch);
  if (p.next_followup_at) {
    await db.insert('followups', {
      lead_id: leadId, user_id: me.id,
      due_at: p.next_followup_at, note: p.remark, is_done: 0
    });
  }
  return { ok: true };
}

async function api_leads_pipeline(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const { usersById, statusesById, productsById } = await _lookups();
  const statuses = (await db.getAll('statuses')).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const leads = (await db.getAll('leads')).filter(l => _isVisible(me, visible, l));
  return statuses.map(s => {
    const cols = leads
      .filter(l => Number(l.status_id) === Number(s.id))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 100)
      .map(l => _hydrate(l, usersById, statusesById, productsById));
    return Object.assign({}, s, { leads: cols });
  });
}

async function api_myFollowups(token) {
  const me = await authUser(token);
  const leadsById = {};
  (await db.getAll('leads')).forEach(l => { leadsById[Number(l.id)] = l; });
  return (await db.getAll('followups'))
    .filter(f => Number(f.user_id) === Number(me.id) && Number(f.is_done) === 0)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
    .map(f => {
      const l = leadsById[Number(f.lead_id)] || {};
      return Object.assign({}, f, {
        lead_name: l.name || '', lead_phone: l.phone || '', lead_whatsapp: l.whatsapp || ''
      });
    });
}

async function api_followup_done(token, id) {
  await authUser(token);
  await db.update('followups', id, { is_done: 1, done_at: db.nowIso() });
  return { ok: true };
}

async function api_leads_bulkUpdate(token, leadIds, patch) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Forbidden');
  const allowed = {};
  ['assigned_to', 'status_id', 'source', 'product_id'].forEach(k => { if (k in patch) allowed[k] = patch[k]; });
  if (patch.status_id) allowed.last_status_change_at = db.nowIso();
  // Track per-assignee bulk pushes — one summary push per recipient instead of
  // 200 spammy banners if you reassign 200 leads.
  const reassignedPerUser = {}; // userId -> [leadName, leadName, ...]
  const newAssignee = (patch.assigned_to !== undefined && patch.assigned_to !== '')
    ? Number(patch.assigned_to) : null;
  let count = 0;
  for (const id of (leadIds || [])) {
    const lead = await db.findById('leads', id); if (!lead) continue;
    const wasAssignedTo = Number(lead.assigned_to) || 0;
    await db.update('leads', id, allowed);
    if (patch.status_id && Number(patch.status_id) !== Number(lead.status_id)) {
      const s = await db.findById('statuses', patch.status_id);
      await db.insert('remarks', { lead_id: id, user_id: me.id, remark: 'Status changed to ' + (s ? s.name : '') + ' (bulk)', status_id: patch.status_id });
    }
    if (newAssignee && newAssignee !== wasAssignedTo && newAssignee !== Number(me.id)) {
      if (!reassignedPerUser[newAssignee]) reassignedPerUser[newAssignee] = [];
      reassignedPerUser[newAssignee].push(lead.name || ('Lead #' + id));
    }
    count++;
  }
  // Single summary push per assignee — fire-and-forget so the bulk update
  // returns instantly even if FCM/Web Push are slow.
  setImmediate(async () => {
    try {
      const push = require('./push');
      for (const uid of Object.keys(reassignedPerUser)) {
        const names = reassignedPerUser[uid];
        const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '');
        await push.sendPushToUser(Number(uid), {
          title: `🎯 ${names.length} new lead${names.length > 1 ? 's' : ''} assigned`,
          body:  preview,
          url:   '/#/leads',
          tag:   'bulk-assign-' + uid,
          sticky: true
        });
      }
    } catch (e) { console.warn('[push] bulk reassign notify failed:', e.message); }
  });
  return { ok: true, count };
}

/**
 * Delete all leads marked is_duplicate=1.
 * Returns the count of leads deleted. The corresponding remarks/followups
 * are removed via ON DELETE CASCADE.
 */
async function api_leads_deleteAllDuplicates(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const dups = (await db.getAll('leads')).filter(l => Number(l.is_duplicate) === 1);
  let count = 0;
  for (const lead of dups) {
    if (await db.removeRow('leads', lead.id)) count++;
  }
  return { ok: true, count };
}

async function api_leads_bulkDelete(token, leadIds) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  let count = 0;
  for (const id of (leadIds || [])) { if (await db.removeRow('leads', id)) count++; }
  return { ok: true, count };
}

/**
 * Bulk-create leads from a CSV upload, with flexible assignment.
 *
 * `assign` shape:
 *   { mode: 'csv' }                              // honour the assigned_to column on each row (or assignment rules)
 *   { mode: 'single', user_id: 5 }               // assign every lead to user 5
 *   { mode: 'round_robin', user_ids: [3,7,9] }   // round-robin across these users (or all sales users if omitted)
 *   { mode: 'percent', split: { 3: 60, 7: 30, 9: 10 } }   // 60/30/10 split across users 3, 7, 9
 */
async function api_leads_bulkCreate(token, rows, assign) {
  const me = await authUser(token);
  const results = { ok: true, created: 0, skipped: 0, duplicate: 0, assignedCounts: {}, errors: [] };
  const assignment = assign || { mode: 'csv' };
  const total = (rows || []).length;

  // Pre-resolve the user list for round_robin / percent modes
  let users = [];
  if (assignment.mode === 'round_robin' || assignment.mode === 'percent') {
    const all = await db.getAll('users');
    users = all.filter(u => Number(u.is_active) === 1 && u.role !== 'admin');
  }

  // Build a per-row assignment plan up front (deterministic, easier to debug)
  const plan = new Array(total).fill(null);

  if (assignment.mode === 'single') {
    const uid = Number(assignment.user_id);
    if (!uid) throw new Error('user_id required for single-assign mode');
    for (let i = 0; i < total; i++) plan[i] = uid;

  } else if (assignment.mode === 'round_robin') {
    const ids = (assignment.user_ids && assignment.user_ids.length)
      ? assignment.user_ids.map(Number)
      : users.map(u => Number(u.id));
    if (!ids.length) throw new Error('No users selected for round-robin');
    for (let i = 0; i < total; i++) plan[i] = ids[i % ids.length];

  } else if (assignment.mode === 'percent') {
    const split = assignment.split || {};
    const pairs = Object.entries(split).map(([uid, pct]) => [Number(uid), Number(pct)]).filter(([u, p]) => u && p > 0);
    if (!pairs.length) throw new Error('At least one user with a positive % required');
    const sumPct = pairs.reduce((s, [, p]) => s + p, 0);
    if (sumPct <= 0) throw new Error('Percentages must sum to >0');
    // Build a deterministic queue by allocating ceil(pct/100 * total) per user, then trimming
    const queue = [];
    for (const [uid, pct] of pairs) {
      const want = Math.round((pct / sumPct) * total);
      for (let i = 0; i < want; i++) queue.push(uid);
    }
    // Round/clip to exact total
    while (queue.length < total) queue.push(pairs[0][0]);
    queue.length = total;
    // Shuffle a tiny bit so consecutive rows aren't all on one rep — Fisher-Yates with seeded prng would be fine,
    // but a simple interleave is plenty here.
    for (let i = 0; i < total; i++) plan[i] = queue[i];
  }
  // mode 'csv' (default): leave plan[i] = null → use the row's own assigned_to (or assignment rules)

  for (let i = 0; i < total; i++) {
    const r = Object.assign({}, rows[i]);
    if (plan[i]) r.assigned_to = plan[i];
    try {
      if (!r.name) { results.skipped++; results.errors.push({ row: i + 1, error: 'missing name' }); continue; }
      const out = await api_leads_create(token, r);
      results.created++;
      if (out.duplicate) results.duplicate++;
      const finalAssignee = r.assigned_to || (out && out.assigned_to) || 'unassigned';
      results.assignedCounts[finalAssignee] = (results.assignedCounts[finalAssignee] || 0) + 1;
    } catch (e) {
      results.skipped++; results.errors.push({ row: i + 1, error: String(e.message || e) });
    }
  }
  return results;
}

async function api_leads_duplicateHistory(token, leadId) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Not found');
  if (!_isVisible(me, visible, lead)) throw new Error('Forbidden');

  const phone = String(lead.phone || '').replace(/\D/g, '');
  const wa = String(lead.whatsapp || '').replace(/\D/g, '');
  const email = String(lead.email || '').trim().toLowerCase();
  const all = (await db.getAll('leads')).filter(l => {
    if (Number(l.id) === Number(leadId)) return false;
    const lp = String(l.phone || '').replace(/\D/g, '');
    const lw = String(l.whatsapp || '').replace(/\D/g, '');
    const le = String(l.email || '').trim().toLowerCase();
    if (phone && (phone === lp || phone === lw)) return true;
    if (wa && (wa === lp || wa === lw)) return true;
    if (email && email === le) return true;
    return false;
  });
  const { usersById, statusesById, productsById } = await _lookups();
  const remarks = await db.getAll('remarks');
  return all
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(l => {
      const h = _hydrate(l, usersById, statusesById, productsById);
      h.remarks = remarks
        .filter(r => Number(r.lead_id) === Number(l.id))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 10);
      return h;
    });
}

async function api_whatsapp_send(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.text) throw new Error('text required');
  let to = p.to;
  if (p.lead_id) {
    const l = await db.findById('leads', p.lead_id);
    to = to || l?.whatsapp || l?.phone;
  }
  if (!to) throw new Error('no whatsapp number');

  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  let waId = ''; let status = 'simulated (no WA creds)';
  if (phoneId && accessToken && !accessToken.startsWith('your_')) {
    try {
      const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
      const resp = await (await fetch)(
        `https://graph.facebook.com/v19.0/${phoneId}/messages`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to), type: 'text', text: { body: p.text } })
        }
      );
      const json = await resp.json();
      if (json.messages && json.messages[0]) { waId = json.messages[0].id; status = 'sent'; }
      else status = 'failed: ' + (json.error?.message || JSON.stringify(json));
    } catch (e) { status = 'failed: ' + e.message; }
  }
  await db.insert('whatsapp_messages', {
    lead_id: p.lead_id || '', direction: 'out', from_number: '', to_number: String(to),
    body: p.text, wa_message_id: waId, status
  });
  return { ok: true, status, wa_message_id: waId };
}

module.exports = {
  api_leads_list, api_leads_statusCounts, api_leads_get, api_leads_create, api_leads_update,
  api_leads_addRemark, api_leads_pipeline, api_myFollowups, api_followup_done,
  api_leads_bulkUpdate, api_leads_bulkDelete, api_leads_bulkCreate, api_leads_duplicateHistory,
  api_leads_deleteAllDuplicates,
  api_whatsapp_send
};
