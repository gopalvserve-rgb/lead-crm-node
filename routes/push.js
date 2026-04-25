/**
 * routes/push.js — Web Push notifications via the standard W3C Push API.
 *
 * Gives the CRM SMS-style notifications: the user's phone shows a banner
 * + plays the OS sound + vibrates EVEN WHEN THE APP IS CLOSED, as long as
 * the browser/PWA is installed and has been granted notification permission.
 *
 * Mechanism:
 *   1. On boot the server ensures a VAPID keypair exists. Read from env
 *      (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) if present, otherwise
 *      generate-and-persist into the `config` table on first boot. The
 *      same keypair is used for the lifetime of the deployment so existing
 *      subscriptions stay valid.
 *   2. Frontend pulls the public key via api_push_publicKey, asks the
 *      browser to register a Push Manager subscription, and sends the
 *      resulting subscription object back via api_push_subscribe — we
 *      store {user_id, endpoint, p256dh, auth} in the push_subscriptions
 *      table.
 *   3. When the server has news for a user (new lead assigned, follow-up
 *      reminder due) it calls sendPushToUser(userId, payload), which
 *      iterates that user's subscriptions and POSTs to the browser's push
 *      endpoint.
 *
 * If web-push isn't installed (e.g. local dev forgot npm install) the
 * helpers all silently no-op — they never throw.
 */

let webpush = null;
try { webpush = require('web-push'); }
catch (e) { console.warn('[push] web-push not installed yet — push notifications disabled'); }

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ---- VAPID keypair lifecycle ----------------------------------------

let _vapid = null;
async function ensureVapid() {
  if (_vapid) return _vapid;
  const envPub  = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) {
    _vapid = { publicKey: envPub, privateKey: envPriv, source: 'env' };
  } else {
    // Try config table next.
    const cfgPub  = await db.getConfig('VAPID_PUBLIC_KEY', '');
    const cfgPriv = await db.getConfig('VAPID_PRIVATE_KEY', '');
    if (cfgPub && cfgPriv) {
      _vapid = { publicKey: cfgPub, privateKey: cfgPriv, source: 'db' };
    } else if (webpush) {
      // First ever boot — generate a fresh pair, persist it.
      const k = webpush.generateVAPIDKeys();
      await db.setConfig('VAPID_PUBLIC_KEY', k.publicKey);
      await db.setConfig('VAPID_PRIVATE_KEY', k.privateKey);
      _vapid = { publicKey: k.publicKey, privateKey: k.privateKey, source: 'generated' };
      console.log('[push] generated new VAPID keypair and persisted to config table');
    }
  }
  if (_vapid && webpush) {
    const subject = process.env.VAPID_SUBJECT || (process.env.BASE_URL || 'mailto:gopalvserve@gmail.com');
    webpush.setVapidDetails(
      subject.startsWith('http') || subject.startsWith('mailto:') ? subject : ('mailto:' + subject),
      _vapid.publicKey,
      _vapid.privateKey
    );
  }
  return _vapid;
}

// Ensure subscriptions table exists on boot. Runs once at module load.
async function ensureSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        ua TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (endpoint)
      )
    `);
  } catch (e) {
    console.warn('[push] could not ensure push_subscriptions table:', e.message);
  }
}
ensureSchema();
ensureVapid().catch(e => console.warn('[push] vapid init failed:', e.message));

// ---- API endpoints --------------------------------------------------

async function api_push_publicKey(token) {
  await authUser(token);
  const v = await ensureVapid();
  if (!v) return { publicKey: '' };
  return { publicKey: v.publicKey };
}

async function api_push_subscribe(token, subscription, ua) {
  const me = await authUser(token);
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Invalid subscription payload');
  }
  const endpoint = String(subscription.endpoint);
  const p256dh = String(subscription.keys.p256dh || '');
  const auth   = String(subscription.keys.auth || '');
  if (!p256dh || !auth) throw new Error('Subscription missing keys');

  // Upsert by endpoint — same browser re-subscribing should refresh the row,
  // not duplicate. Different users / browsers each get their own row.
  await db.query(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        ua = EXCLUDED.ua
  `, [me.id, endpoint, p256dh, auth, String(ua || '').slice(0, 250)]);
  return { ok: true };
}

async function api_push_unsubscribe(token, endpoint) {
  await authUser(token);
  if (!endpoint) return { ok: true };
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [String(endpoint)]);
  return { ok: true };
}

/**
 * Admin/debug — send a test push to the current user. Helps confirm the
 * subscription works end-to-end. Available to any logged-in user for their
 * own device(s).
 */
async function api_push_test(token, payload) {
  const me = await authUser(token);
  const body = (payload && typeof payload === 'object') ? payload : {};
  const out = await sendPushToUser(me.id, {
    title: body.title || '🔔 Test notification',
    body:  body.body  || 'If you see this on your phone, push notifications are working.',
    url:   body.url   || '/'
  });
  return out;
}

// ---- Push sender ---------------------------------------------------

/**
 * Send a Web Push to every subscription registered for `userId`.
 * Payload should be { title, body, url, tag?, icon? }.
 * Returns { sent: N, failed: N }.
 * Bad subscriptions (404 / 410 / 401) are deleted automatically.
 */
async function sendPushToUser(userId, payload) {
  if (!webpush) return { sent: 0, failed: 0, skipped: 'web-push not installed' };
  await ensureVapid();
  if (!_vapid) return { sent: 0, failed: 0, skipped: 'vapid keys missing' };

  const { rows } = await db.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [Number(userId)]
  );
  if (!rows.length) return { sent: 0, failed: 0 };

  const json = JSON.stringify({
    title: String(payload.title || 'Lead CRM'),
    body:  String(payload.body  || ''),
    url:   String(payload.url   || '/'),
    tag:   payload.tag || undefined,
    icon:  payload.icon || '/icon-192.png'
  });

  let sent = 0, failed = 0;
  await Promise.all(rows.map(async row => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(sub, json, { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      failed++;
      // 404/410 = subscription gone / unsubscribed; safe to delete BUT only if
      // the row is at least 60s old — fresh subscriptions can briefly return
      // 410 while FCM propagates. 401 means our auth is wrong, not the
      // subscription's fault, so don't delete on 401.
      const code = (e && e.statusCode) || 0;
      if (code === 404 || code === 410) {
        try {
          const { rows: ageRows } = await db.query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_s FROM push_subscriptions WHERE id = $1`,
            [row.id]
          );
          const ageS = Number(ageRows[0]?.age_s || 0);
          if (ageS > 60) {
            await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.id]);
          } else {
            console.warn('[push] new subscription returned ' + code + ', keeping (age ' + Math.round(ageS) + 's)');
          }
        } catch (_) {}
      } else {
        console.warn('[push] send failed:', code, e.message);
      }
    }
  }));
  return { sent, failed };
}

module.exports = {
  api_push_publicKey, api_push_subscribe, api_push_unsubscribe, api_push_test,
  sendPushToUser
};
