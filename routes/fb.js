/**
 * routes/fb.js — Facebook / Meta integration
 * Handles the embedded Login flow: takes the short-lived user token from
 * Facebook Login for Business, exchanges it, picks a page, subscribes
 * leadgen webhooks.
 */
const fetch = require('node-fetch');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const GRAPH = 'https://graph.facebook.com/v19.0';

function _appCreds() {
  return {
    app_id: process.env.META_APP_ID,
    app_secret: process.env.META_APP_SECRET
  };
}

async function _gget(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error('Meta: ' + (j.error.message || j.error));
  return j;
}

/**
 * Exchange short-lived user token for long-lived (60-day) token.
 */
async function _longLived(token) {
  const { app_id, app_secret } = _appCreds();
  const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${app_id}&client_secret=${app_secret}&fb_exchange_token=${token}`;
  const j = await _gget(url);
  return j.access_token;
}

/**
 * Called by the frontend after FB.login succeeds.
 * shortToken = the accessToken from authResponse.
 * selectedPageId (optional) = specific page to subscribe.
 */
async function api_fb_connect(token, shortToken, selectedPageId) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!shortToken) throw new Error('Facebook token missing');

  const { app_id, app_secret } = _appCreds();
  if (!app_id || !app_secret) {
    throw new Error('META_APP_ID and META_APP_SECRET must be configured in env');
  }

  // 1. Exchange for long-lived user token
  const longToken = await _longLived(shortToken);

  // 2. Fetch accounts (pages)
  const pagesResp = await _gget(`${GRAPH}/me/accounts?access_token=${longToken}`);
  const pages = pagesResp.data || [];
  if (!pages.length) throw new Error('No Facebook pages returned. Make sure you granted page access.');

  const chosen = selectedPageId
    ? pages.find(p => String(p.id) === String(selectedPageId))
    : pages[0];
  if (!chosen) throw new Error('Selected page not found in granted list.');

  // 3. Subscribe page to leadgen webhook
  const sub = await fetch(`${GRAPH}/${chosen.id}/subscribed_apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `subscribed_fields=leadgen&access_token=${encodeURIComponent(chosen.access_token)}`
  });
  const subJson = await sub.json();
  if (subJson.error) throw new Error('Subscribe failed: ' + subJson.error.message);

  // 4. Persist config
  await db.setConfig('META_PAGE_ID', chosen.id);
  await db.setConfig('META_PAGE_ACCESS_TOKEN', chosen.access_token);
  await db.setConfig('META_USER_TOKEN', longToken);
  await db.setConfig('META_CONNECTED_AT', db.nowIso());
  await db.setConfig('META_CONNECTED_PAGE_NAME', chosen.name || '');

  return {
    ok: true,
    page_id: chosen.id,
    page_name: chosen.name,
    pages: pages.map(p => ({ id: p.id, name: p.name }))
  };
}

async function api_fb_status(token) {
  await authUser(token);
  const page_id = await db.getConfig('META_PAGE_ID');
  const page_name = await db.getConfig('META_CONNECTED_PAGE_NAME');
  const at = await db.getConfig('META_CONNECTED_AT');
  const app_id = process.env.META_APP_ID || '';
  return {
    connected: !!page_id,
    page_id: page_id || null,
    page_name: page_name || null,
    connected_at: at || null,
    app_id
  };
}

async function api_fb_disconnect(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.setConfig('META_PAGE_ID', '');
  await db.setConfig('META_PAGE_ACCESS_TOKEN', '');
  await db.setConfig('META_USER_TOKEN', '');
  await db.setConfig('META_CONNECTED_AT', '');
  await db.setConfig('META_CONNECTED_PAGE_NAME', '');
  return { ok: true };
}

module.exports = { api_fb_connect, api_fb_status, api_fb_disconnect };
