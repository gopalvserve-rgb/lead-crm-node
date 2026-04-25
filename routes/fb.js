/**
 * routes/fb.js — Facebook / Meta Lead Ads integration
 *
 * Two-tier model that mirrors the screenshot the user shared:
 *
 * 1. Application Settings (DB-backed via the `config` table):
 *      - META_APP_ID       (FB App ID)
 *      - META_APP_SECRET   (FB App Secret)
 *      - META_VERIFY_TOKEN (webhook verify token)
 *
 * 2. Module Settings (DB-backed):
 *      - META_DEFAULT_USER_ID    (assignee for incoming Meta leads)
 *      - META_DEFAULT_SOURCE     (source label, e.g. "Facebook")
 *      - META_DEFAULT_STATUS_ID  (initial status)
 *
 * 3. Pages: a JSON list in META_PAGES_LIST with each page's id, name,
 *    access_token, and is_monitored flag. Admin connects with FB Login,
 *    we fetch ALL pages they have access to, then they pick which ones
 *    to monitor. Subscribing a page = POSTing /<page-id>/subscribed_apps
 *    with subscribed_fields=leadgen.
 */
const fetch = require('node-fetch');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const GRAPH = 'https://graph.facebook.com/v19.0';

// ---------- helpers ----------

async function _appCreds() {
  // DB config wins; env vars are the fallback (and bootstrap for fresh deploys).
  const app_id = await db.getConfig('META_APP_ID', '');
  const app_secret = await db.getConfig('META_APP_SECRET', '');
  return { app_id, app_secret };
}

async function _gget(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error('Meta: ' + (j.error.message || JSON.stringify(j.error)));
  return j;
}

async function _readPagesList() {
  const raw = await db.getConfig('META_PAGES_LIST', '');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (_) { return []; }
}

async function _writePagesList(list) {
  await db.setConfig('META_PAGES_LIST', JSON.stringify(list || []));
}

async function _longLived(shortToken) {
  const { app_id, app_secret } = await _appCreds();
  if (!app_id || !app_secret) {
    throw new Error('Set Facebook Application ID and Secret first (Admin → Facebook).');
  }
  const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${app_id}&client_secret=${app_secret}&fb_exchange_token=${shortToken}`;
  const j = await _gget(url);
  return j.access_token;
}

// Subscribe / unsubscribe a single page to leadgen.
async function _subscribePage(pageId, pageAccessToken, subscribe) {
  const method = subscribe ? 'POST' : 'DELETE';
  const r = await fetch(`${GRAPH}/${pageId}/subscribed_apps`, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: subscribe
      ? `subscribed_fields=leadgen&access_token=${encodeURIComponent(pageAccessToken)}`
      : `access_token=${encodeURIComponent(pageAccessToken)}`
  });
  const j = await r.json();
  if (j.error) throw new Error((subscribe ? 'Subscribe' : 'Unsubscribe') + ' failed: ' + j.error.message);
  return j;
}

// ---------- API: Settings (Application + Module) ----------

async function api_fb_settings_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const [app_id, app_secret_present, verify_token, default_user_id, default_source, default_status_id] = await Promise.all([
    db.getConfig('META_APP_ID', ''),
    db.getConfig('META_APP_SECRET', '').then(v => !!(v && v.length)),
    db.getConfig('META_VERIFY_TOKEN', ''),
    db.getConfig('META_DEFAULT_USER_ID', ''),
    db.getConfig('META_DEFAULT_SOURCE', 'Facebook'),
    db.getConfig('META_DEFAULT_STATUS_ID', '')
  ]);
  return {
    app_id,
    app_secret_present,         // never return the secret itself; just whether it's set
    verify_token,
    default_user_id, default_source, default_status_id
  };
}

async function api_fb_settings_set(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if ('app_id' in p) await db.setConfig('META_APP_ID', String(p.app_id || '').trim());
  if ('app_secret' in p && String(p.app_secret || '').trim()) {
    // Only overwrite the secret when a non-empty value is supplied — avoids
    // wiping it accidentally when the form re-submits with the masked field empty.
    await db.setConfig('META_APP_SECRET', String(p.app_secret).trim());
  }
  if ('verify_token' in p) await db.setConfig('META_VERIFY_TOKEN', String(p.verify_token || '').trim());
  if ('default_user_id' in p) await db.setConfig('META_DEFAULT_USER_ID', String(p.default_user_id || '').trim());
  if ('default_source' in p) await db.setConfig('META_DEFAULT_SOURCE', String(p.default_source || '').trim());
  if ('default_status_id' in p) await db.setConfig('META_DEFAULT_STATUS_ID', String(p.default_status_id || '').trim());
  return { ok: true };
}

// ---------- API: Connect (FB Login) ----------

async function api_fb_connect(token, shortToken) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!shortToken) throw new Error('Facebook token missing');

  const { app_id, app_secret } = await _appCreds();
  if (!app_id || !app_secret) {
    throw new Error('Set the Facebook Application ID and Secret first.');
  }

  // 1. Long-lived user token
  const longToken = await _longLived(shortToken);

  // 2. Fetch the full list of pages the user has access to
  const pagesResp = await _gget(`${GRAPH}/me/accounts?access_token=${longToken}&fields=id,name,access_token,category&limit=200`);
  const pages = pagesResp.data || [];
  if (!pages.length) throw new Error('No Facebook pages returned. Make sure you granted page access on the Login dialog.');

  // 3. Merge with existing list — preserve is_monitored state for pages the
  //    admin already chose, refresh access_token for everyone (FB rotates them).
  const existing = await _readPagesList();
  const merged = pages.map(p => {
    const prev = existing.find(e => String(e.page_id) === String(p.id));
    return {
      page_id: String(p.id),
      page_name: p.name || '',
      category: p.category || '',
      access_token: p.access_token || '',
      is_monitored: prev ? !!prev.is_monitored : false,
      added_at: prev?.added_at || db.nowIso(),
      last_seen_at: db.nowIso()
    };
  });
  await _writePagesList(merged);

  // 4. Persist the long-lived USER token so we can refresh later without re-login.
  await db.setConfig('META_USER_TOKEN', longToken);
  await db.setConfig('META_CONNECTED_AT', db.nowIso());

  return { ok: true, pages_count: merged.length };
}

async function api_fb_disconnect(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Unsubscribe every monitored page so we stop receiving webhooks.
  const list = await _readPagesList();
  for (const pg of list.filter(p => p.is_monitored)) {
    try { await _subscribePage(pg.page_id, pg.access_token, false); }
    catch (_) { /* best-effort */ }
  }
  await db.setConfig('META_USER_TOKEN', '');
  await db.setConfig('META_CONNECTED_AT', '');
  await _writePagesList([]);
  return { ok: true };
}

// ---------- API: Pages ----------

async function api_fb_pages_list(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const list = await _readPagesList();
  // Don't leak the access_token to the frontend.
  return list.map(({ access_token, ...rest }) => rest);
}

/** Re-fetch pages from Meta using the stored user token (refresh action). */
async function api_fb_pages_refetch(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const userToken = await db.getConfig('META_USER_TOKEN', '');
  if (!userToken) throw new Error('Connect with Facebook first.');
  const pagesResp = await _gget(`${GRAPH}/me/accounts?access_token=${userToken}&fields=id,name,access_token,category&limit=200`);
  const pages = pagesResp.data || [];
  const existing = await _readPagesList();
  const merged = pages.map(p => {
    const prev = existing.find(e => String(e.page_id) === String(p.id));
    return {
      page_id: String(p.id),
      page_name: p.name || '',
      category: p.category || '',
      access_token: p.access_token || '',
      is_monitored: prev ? !!prev.is_monitored : false,
      added_at: prev?.added_at || db.nowIso(),
      last_seen_at: db.nowIso()
    };
  });
  await _writePagesList(merged);
  return { ok: true, count: merged.length };
}

/** Toggle monitoring for one page. */
async function api_fb_pages_toggle(token, pageId, monitor) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const list = await _readPagesList();
  const pg = list.find(p => String(p.page_id) === String(pageId));
  if (!pg) throw new Error('Page not in list — refetch pages first.');

  // Subscribe / unsubscribe at Meta
  await _subscribePage(pg.page_id, pg.access_token, !!monitor);
  pg.is_monitored = !!monitor;
  pg.last_action_at = db.nowIso();
  await _writePagesList(list);
  return { ok: true, page: { page_id: pg.page_id, page_name: pg.page_name, is_monitored: pg.is_monitored } };
}

/** Status — used by the admin page header. */
async function api_fb_status(token) {
  await authUser(token);
  const userToken = await db.getConfig('META_USER_TOKEN', '');
  const at = await db.getConfig('META_CONNECTED_AT', '');
  const app_id = await db.getConfig('META_APP_ID', '');
  const list = await _readPagesList();
  const monitored = list.filter(p => p.is_monitored);
  return {
    connected: !!userToken,
    app_id,
    pages_total: list.length,
    pages_monitored: monitored.length,
    monitored_pages: monitored.map(p => ({ page_id: p.page_id, page_name: p.page_name })),
    connected_at: at || null
  };
}

/**
 * Internal helper used by the webhook handler — given a page_id, return
 * its access token and the configured defaults so the lead can be created
 * with the right assignee / source / status.
 */
async function _pageContextForWebhook(pageId) {
  const list = await _readPagesList();
  const pg = list.find(p => String(p.page_id) === String(pageId));
  const [defaultUserId, defaultSource, defaultStatusId] = await Promise.all([
    db.getConfig('META_DEFAULT_USER_ID', ''),
    db.getConfig('META_DEFAULT_SOURCE', 'Facebook'),
    db.getConfig('META_DEFAULT_STATUS_ID', '')
  ]);
  return {
    access_token: pg ? pg.access_token : '',
    page_name: pg ? pg.page_name : '',
    is_monitored: pg ? !!pg.is_monitored : false,
    default_user_id: defaultUserId ? Number(defaultUserId) : null,
    default_source: defaultSource || 'Facebook',
    default_status_id: defaultStatusId ? Number(defaultStatusId) : null
  };
}

module.exports = {
  api_fb_connect, api_fb_disconnect, api_fb_status,
  api_fb_settings_get, api_fb_settings_set,
  api_fb_pages_list, api_fb_pages_refetch, api_fb_pages_toggle,
  // exported for use inside webhooks.js
  _pageContextForWebhook
};
