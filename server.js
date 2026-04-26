/**
 * server.js — Lead CRM Node.js / Express entry point
 *
 * Two routes:
 *   POST /api            dispatches { fn, args } to the matching handler
 *   GET/POST /hook/:name   for Meta / WhatsApp / website webhooks
 *
 * Serves the SPA from /public.
 */
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const multer = require('multer');
const db = require('./db/pg');
const { authUser } = require('./utils/auth');
const { _findLeadByPhone } = require('./routes/recordings');

// Use memory storage so we can write the bytes straight into the
// lead_recordings.audio_bytes BYTEA column.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB max
});

const routes = {
  auth:        require('./routes/auth'),
  users:       require('./routes/users'),
  leads:       require('./routes/leads'),
  admin:       require('./routes/admin'),
  customFields:require('./routes/customFields'),
  tags:        require('./routes/tags'),
  tat:         require('./routes/tat'),
  whatsbot:    require('./routes/whatsbot'),
  sources:     require('./routes/sources'),
  products:    require('./routes/products'),
  statuses:    require('./routes/statuses'),
  rules:       require('./routes/rules'),
  notifications: require('./routes/notifications'),
  reports:     require('./routes/reports'),
  hr:          require('./routes/hr'),
  fb:          require('./routes/fb'),
  automations: require('./routes/automations'),
  whatsapp:    require('./routes/whatsapp'),
  permissions: require('./routes/permissions'),
  recordings:  require('./routes/recordings'),
  push:        require('./routes/push')
};
const webhooks = require('./routes/webhooks');

// Flatten the handlers into a single dispatch map keyed by API name
const API = {};
Object.values(routes).forEach(module => {
  Object.keys(module).forEach(name => {
    if (typeof module[name] === 'function' && name.startsWith('api_')) {
      API[name] = module[name];
    }
  });
});

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Unified API dispatcher: POST /api { fn, args }
app.post('/api', async (req, res) => {
  const { fn, args } = req.body || {};
  if (!fn || !API[fn]) return res.status(404).json({ error: 'Unknown function: ' + fn });
  try {
    // Pass request metadata to api_login so it can fingerprint the device
    // for the "new device login" notification.
    const finalArgs = (args || []).slice();
    if (fn === 'api_login') {
      finalArgs.push({
        ua: String(req.headers['user-agent'] || ''),
        ip: String(req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '').split(',')[0].trim()
      });
    }
    const result = await API[fn](...finalArgs);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[api]', fn, e.message, e.stack?.split('\n').slice(0, 5).join('\n'));
    res.status(400).json({ error: e.message || String(e) });
  }
});

// -----------------------------------------------------------------
// Call recordings: multipart upload + audio streaming
// -----------------------------------------------------------------
function _tokenFrom(req) {
  return (req.headers['x-auth-token'] ||
          req.query.token ||
          (req.body && req.body.token) || '').toString();
}

// POST /api/recordings
// multipart/form-data fields:
//   audio:       the .m4a file
//   phone:       called number
//   direction:   'out' | 'in' | 'missed'
//   duration_s:  numeric seconds
//   lead_id:     optional — if missing we look up by phone
//   device_path: original path on device (kept as a hint)
//   started_at:  ISO timestamp of when the call started
app.post('/api/recordings', upload.single('audio'), async (req, res) => {
  try {
    const token = _tokenFrom(req);
    const me = await authUser(token);
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const phone = (req.body.phone || '').toString();
    let leadId = Number(req.body.lead_id) || null;
    if (!leadId) {
      const lead = await _findLeadByPhone(phone);
      if (lead) leadId = lead.id;
    }
    const id = await db.insert('lead_recordings', {
      lead_id: leadId,
      user_id: me.id,
      phone,
      direction: req.body.direction || 'out',
      duration_s: Number(req.body.duration_s) || 0,
      device_path: (req.body.device_path || '').toString(),
      mime_type: req.file.mimetype || 'audio/m4a',
      size_bytes: req.file.size || 0,
      audio_bytes: req.file.buffer,
      started_at: req.body.started_at || db.nowIso(),
      created_at: db.nowIso()
    });
    // Link into the call_events timeline
    await db.insert('call_events', {
      lead_id: leadId,
      user_id: me.id,
      phone,
      direction: req.body.direction || 'out',
      event: 'recording_saved',
      duration_s: Number(req.body.duration_s) || 0,
      recording_id: id,
      created_at: db.nowIso()
    });
    res.json({ ok: true, id, lead_id: leadId });
  } catch (e) {
    console.error('[/api/recordings]', e.message);
    res.status(400).json({ error: e.message });
  }
});

// GET /api/recordings/:id/audio  — streams audio bytes (token required)
app.get('/api/recordings/:id/audio', async (req, res) => {
  try {
    const token = _tokenFrom(req);
    await authUser(token);
    const id = Number(req.params.id);
    const { rows } = await db.query(
      'SELECT mime_type, audio_bytes, size_bytes FROM lead_recordings WHERE id = $1',
      [id]
    );
    if (!rows[0] || !rows[0].audio_bytes) return res.status(404).end();
    res.setHeader('Content-Type', rows[0].mime_type || 'audio/m4a');
    res.setHeader('Content-Length', rows[0].audio_bytes.length);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('Accept-Ranges', 'none');
    res.end(rows[0].audio_bytes);
  } catch (e) {
    console.error('[/api/recordings/:id/audio]', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Webhooks
app.get('/hook/meta',      webhooks.metaVerify);
app.post('/hook/meta',     webhooks.metaEvent);
app.get('/hook/whatsapp',  webhooks.whatsappVerify);
app.post('/hook/whatsapp', webhooks.whatsappEvent);
// New full-featured WhatsBot webhook (used by Meta when configured via the UI)
app.get('/hook/whatsapp_webhook',  routes.whatsbot.expressVerify);
app.post('/hook/whatsapp_webhook', routes.whatsbot.expressEvent);
app.post('/hook/website',  webhooks.websiteHook);
app.post('/hook/other',    webhooks.otherHook);

// Facebook OAuth callback — server-side flow that bypasses the JS SDK.
// User clicks Connect → redirected here with code → we fetch pages → redirect back.
app.get('/fb/auth/callback', routes.fb.expressOAuthCallback);

// Lead sample CSV + website API docs
app.get('/api/docs', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  res.json({
    website_endpoint: `${host}/hook/website`,
    method: 'POST',
    headers: { 'x-api-key': '<your WEBSITE_API_KEY>', 'Content-Type': 'application/json' },
    body_example: {
      name: 'John Doe', phone: '+911234567890', email: 'john@example.com',
      source: 'Website Contact Form', product: 'Basic Plan', notes: 'Lead from landing page',
      city: 'Mumbai', tags: 'hot,vip', meta: { utm_campaign: 'facebook-ad', landing_page: '/pricing' }
    },
    sample_csv_url: `${host}/api/sample.csv`
  });
});

// Direct download links for the signed APK + AAB
app.get('/LeadCRM.apk', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="LeadCRM.apk"');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.sendFile(path.join(__dirname, 'public', 'LeadCRM.apk'));
});
app.get('/LeadCRM.aab', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="LeadCRM.aab"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(path.join(__dirname, 'public', 'LeadCRM.aab'));
});
// Pretty "get the app" page
app.get('/install', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  res.type('html').send(`<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Install Lead CRM on Android</title>
  <style>
    body{margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:linear-gradient(135deg,#6366f1,#8b5cf6,#ec4899);min-height:100vh;color:#fff;display:flex;align-items:center;justify-content:center;padding:1rem}
    .box{background:#fff;color:#0f172a;border-radius:20px;max-width:480px;width:100%;padding:2rem;box-shadow:0 20px 60px rgba(0,0,0,.25)}
    h1{margin:0 0 .5rem}
    .app{display:flex;gap:1rem;align-items:center;margin:1.2rem 0 1.5rem}
    .icon{width:72px;height:72px;border-radius:18px;background:linear-gradient(135deg,#6366f1,#ec4899);display:grid;place-items:center;font-size:2.2rem;color:#fff}
    a.btn{display:block;text-align:center;background:#6366f1;color:#fff;padding:1rem;border-radius:10px;text-decoration:none;font-weight:700;margin:.5rem 0;font-size:1.05rem}
    a.btn.alt{background:#fff;color:#6366f1;border:2px solid #6366f1}
    ol{padding-left:1.2rem;line-height:1.7;color:#475569}
    .muted{color:#94a3b8;font-size:.85rem}
  </style></head><body>
  <div class="box">
    <div class="app">
      <div class="icon">🎯</div>
      <div>
        <h1>Lead CRM</h1>
        <div class="muted">Android app · 2.9 MB · v3 (in-app dialer + recordings)</div>
      </div>
    </div>
    <a class="btn" href="/LeadCRM.apk" download>⬇️ Download APK</a>
    <a class="btn alt" href="/" style="margin-bottom:1rem">Open web version</a>
    <h3 style="margin-top:1.5rem">How to install</h3>
    <ol>
      <li>Tap the <b>Download APK</b> button above.</li>
      <li>When the file finishes downloading, tap it to open.</li>
      <li>Android will ask "Install from unknown sources" — tap <b>Settings → Allow</b>.</li>
      <li>Tap <b>Install</b>. The "Lead CRM" app icon appears on your home screen.</li>
    </ol>
    <p class="muted">The app is signed and safe. It opens <b>${host}</b> full-screen. Content auto-updates — you won't need to re-install when we ship features.</p>
  </div></body></html>`);
});

// Public API documentation page
app.get('/api-docs', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  res.type('html').send(apiDocsHtml(host));
});

app.get('/api/sample.csv', (req, res) => {
  const csv = [
    'name,phone,email,whatsapp,source,product,city,tags,notes,next_followup_at,assigned_to',
    // assigned_to accepts an employee email OR full name. Leave blank to use assignment rules.
    'John Doe,+911234567890,john@example.com,+911234567890,Website,Basic Plan,Mumbai,"hot,vip","Demo requested",2026-05-01 10:00,sales1@yourcompany.com',
    'Jane Smith,+919876543210,jane@example.com,+919876543210,Facebook Lead Ad,Premium,Delhi,vip,"Referred by John",,Rajesh Kumar',
    'Alex Kumar,+917777777777,,,WhatsApp,,Bangalore,cold,,,'
  ].join('\n');
  res.type('text/csv').attachment('lead-crm-sample.csv').send(csv);
});

// Config for the frontend (non-secret; used to pre-populate CRM.webAppUrl etc.).
// Reads from the config table so updates to brand name/logo show up immediately
// without restarting the server.
app.get('/config.json', async (req, res) => {
  let cfg = {};
  try {
    const rows = await db.getAll('config');
    rows.forEach(r => { cfg[r.key] = r.value; });
  } catch (_) { /* DB unavailable — fall through to env defaults */ }
  res.json({
    company_name:     cfg.COMPANY_NAME     || process.env.COMPANY_NAME     || 'Lead CRM',
    company_logo_url: cfg.COMPANY_LOGO_URL || process.env.COMPANY_LOGO_URL || '',
    base_url: (req.protocol + '://' + req.get('host'))
  });
});

// Setup / migration endpoint (creates all sheet tabs + seeds admin user)
app.post('/setup', async (req, res) => {
  try {
    const setup = require('./routes/setup');
    const out = await setup.run();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fallback: serve SPA for any unknown path (HTML5 routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Optional bootstrap: apply schema + seed defaults on first boot.
// Set SKIP_BOOTSTRAP=1 to disable.
async function bootstrap() {
  if (String(process.env.SKIP_BOOTSTRAP || '') === '1') {
    console.log('[boot] SKIP_BOOTSTRAP=1 — skipping schema+seed.');
    return;
  }
  try {
    console.log('[boot] applying schema...');
    const fs = require('fs');
    const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await db.query(sql);
    console.log('[boot] schema applied.');

    console.log('[boot] seeding defaults...');
    const bcrypt = require('bcryptjs');
    const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@crm.local';
    const adminPass  = process.env.SEED_ADMIN_PASSWORD || 'admin123';
    const adminName  = process.env.SEED_ADMIN_NAME || 'Admin';
    const existing = await db.findOneBy('users', 'email', adminEmail).catch(() => null);
    if (!existing) {
      await db.insert('users', {
        name: adminName, email: adminEmail, role: 'admin',
        password_hash: bcrypt.hashSync(adminPass, 10),
        is_active: 1, created_at: db.nowIso()
      });
      console.log(`[boot] admin user created: ${adminEmail} / ${adminPass}`);
    } else {
      console.log(`[boot] admin user exists (${adminEmail}) — skipping.`);
    }

    const statusCount = (await db.getAll('statuses')).length;
    if (statusCount === 0) {
      const defaults = [
        { name: 'New',         color: '#3b82f6', sort_order: 10,  is_final: 0 },
        { name: 'Contacted',   color: '#06b6d4', sort_order: 20,  is_final: 0 },
        { name: 'Qualified',   color: '#8b5cf6', sort_order: 30,  is_final: 0 },
        { name: 'Proposal',    color: '#f59e0b', sort_order: 40,  is_final: 0 },
        { name: 'Negotiation', color: '#ef4444', sort_order: 50,  is_final: 0 },
        { name: 'Won',         color: '#10b981', sort_order: 90,  is_final: 1 },
        { name: 'Lost',        color: '#6b7280', sort_order: 100, is_final: 1 }
      ];
      for (const s of defaults) await db.insert('statuses', s);
      console.log(`[boot] inserted ${defaults.length} default statuses.`);
    }

    const sourceCount = (await db.getAll('sources')).length;
    if (sourceCount === 0) {
      const defaults = ['Website', 'Facebook Lead Ad', 'Instagram Lead Ad',
                        'WhatsApp', 'Referral', 'Cold Call', 'Walk-in', 'Other'];
      for (const n of defaults) await db.insert('sources', { name: n, is_active: 1 });
      console.log(`[boot] inserted ${defaults.length} default sources.`);
    }

    // Auto-generate a Website API key on first boot if none exists.
    // Format: leadcrm_<32 hex chars>. Stored in the config table.
    const existingKey = await db.findOneBy('config', 'key', 'WEBSITE_API_KEY').catch(() => null);
    if (!existingKey || !existingKey.value) {
      const crypto = require('crypto');
      const key = 'leadcrm_' + crypto.randomBytes(16).toString('hex');
      await db.setConfig('WEBSITE_API_KEY', key);
      process.env.WEBSITE_API_KEY = key;
      console.log(`[boot] generated WEBSITE_API_KEY: ${key}`);
    } else if (!process.env.WEBSITE_API_KEY) {
      // Make sure the in-process env mirrors the DB value so /hook/website works
      process.env.WEBSITE_API_KEY = existingKey.value;
      console.log('[boot] loaded WEBSITE_API_KEY from config table');
    }
  } catch (e) {
    console.error('[boot] bootstrap error:', e.message);
    console.error(e.stack);
    // Don't crash — start the server anyway so /config.json responds and we
    // get useful error messages via /api or the UI.
  }
}

function apiDocsHtml(host) {
  const endpoint = host + '/hook/website';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Lead CRM — API Documentation</title>
<style>
  :root { --bg:#0f172a; --card:#fff; --soft:#f8fafc; --text:#0f172a; --muted:#64748b; --brand:#6366f1; --brand2:#ec4899; --code:#0f172a; --codetext:#a5f3fc; --border:#e5e7eb; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:#f3f4f6; color:var(--text); line-height:1.6; }
  header { background:linear-gradient(135deg,var(--brand),#8b5cf6,var(--brand2)); color:#fff; padding:2.5rem 1.5rem 2rem; }
  header h1 { margin:0 0 .35rem; font-size:1.9rem; }
  header p { margin:0; opacity:.9; }
  main { max-width:920px; margin:-1.5rem auto 3rem; padding:0 1rem; }
  .card { background:var(--card); border-radius:14px; padding:1.5rem 1.75rem; margin-bottom:1.1rem; box-shadow:0 4px 14px rgba(15,23,42,.08); }
  h2 { margin:0 0 .85rem; font-size:1.25rem; border-left:4px solid var(--brand); padding-left:.7rem; }
  h3 { margin:1.4rem 0 .5rem; font-size:1.05rem; color:var(--text); }
  code, pre { font-family:"SF Mono",Menlo,Monaco,Consolas,monospace; }
  pre { background:var(--code); color:var(--codetext); padding:1rem 1.1rem; border-radius:10px; overflow-x:auto; font-size:.83rem; line-height:1.5; }
  pre .k { color:#7dd3fc; }
  pre .s { color:#fcd34d; }
  pre .c { color:#94a3b8; font-style:italic; }
  table { width:100%; border-collapse:collapse; margin:.5rem 0 1rem; font-size:.92rem; }
  th, td { text-align:left; padding:.55rem .6rem; border-bottom:1px solid var(--border); vertical-align:top; }
  th { background:var(--soft); font-weight:600; font-size:.82rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  td.field code { background:var(--soft); padding:2px 6px; border-radius:4px; color:var(--brand); font-weight:600; }
  .req { color:#dc2626; font-weight:600; }
  .opt { color:#94a3b8; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:.72rem; font-weight:600; vertical-align:middle; }
  .pill-post { background:#10b981; color:#fff; }
  .url { background:var(--soft); padding:.65rem .85rem; border-radius:8px; font-family:monospace; font-size:.95rem; word-break:break-all; display:flex; gap:.5rem; align-items:center; }
  .copy-btn { background:var(--brand); color:#fff; border:none; padding:.35rem .75rem; border-radius:6px; cursor:pointer; font-size:.8rem; }
  .copy-btn:active { transform:scale(.95); }
  ul { padding-left:1.4rem; }
  li { margin-bottom:.3rem; }
  .tabs { display:flex; gap:.4rem; border-bottom:2px solid var(--border); margin-bottom:0; flex-wrap:wrap; }
  .tab { padding:.65rem 1rem; cursor:pointer; border:none; background:transparent; color:var(--muted); font-weight:500; font-size:.9rem; border-bottom:2px solid transparent; margin-bottom:-2px; }
  .tab.active { color:var(--brand); border-bottom-color:var(--brand); }
  .tab-body { display:none; }
  .tab-body.active { display:block; }
  .nav-back { display:inline-block; color:#fff; text-decoration:none; opacity:.85; margin-bottom:.5rem; font-size:.85rem; }
  .nav-back:hover { opacity:1; }
  .alert { background:#fef3c7; border-left:4px solid #f59e0b; padding:.75rem 1rem; border-radius:6px; margin:1rem 0; font-size:.9rem; }
</style>
</head><body>
<header>
  <a class="nav-back" href="/">← Back to CRM</a>
  <h1>📚 Lead CRM — API Documentation</h1>
  <p>Send leads from your website, landing page, ad platform or any external system into the CRM.</p>
</header>
<main>

<div class="card">
  <h2>1. Endpoint</h2>
  <p><span class="pill pill-post">POST</span> Send leads to:</p>
  <div class="url">
    <code id="endpoint">${endpoint}</code>
    <button class="copy-btn" onclick="copyText('${endpoint}', this)">Copy</button>
  </div>
  <p style="margin-top:1rem">Every successful POST creates a new lead, applies your assignment rules, and triggers any matching automations (email/WhatsApp).</p>
</div>

<div class="card">
  <h2>2. Authentication</h2>
  <p>All requests must include your API key in the <code>x-api-key</code> header.</p>
  <pre><span class="k">x-api-key</span>: leadcrm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</pre>
  <p>Get your key from <a href="/">CRM</a> → Settings → API tab. Click <b>🔄 Regenerate</b> if it ever leaks.</p>
  <div class="alert">⚠️ Keep your key secret. Don't put it in client-side JavaScript or a public GitHub repo. Use a server-side proxy if your form is on a static site.</div>
</div>

<div class="card">
  <h2>3. Request body</h2>
  <p>Send a JSON body with these fields (all optional except <code>name</code> + at least one of <code>phone</code>/<code>email</code>):</p>
  <table>
    <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td class="field"><code>name</code> <span class="req">*</span></td><td>string</td><td>Lead's full name</td></tr>
      <tr><td class="field"><code>phone</code></td><td>string</td><td>Phone with country code, e.g. <code>+919876543210</code>. Aliases: <code>mobile</code></td></tr>
      <tr><td class="field"><code>whatsapp</code></td><td>string</td><td>WhatsApp number. Falls back to <code>phone</code> if omitted.</td></tr>
      <tr><td class="field"><code>email</code></td><td>string</td><td>Email address</td></tr>
      <tr><td class="field"><code>source</code></td><td>string</td><td>Where the lead came from. e.g. <code>Website</code>, <code>Facebook Lead Ad</code>, <code>Landing Page</code>. Default: <code>Website</code></td></tr>
      <tr><td class="field"><code>product</code></td><td>string</td><td>Product or plan they're interested in</td></tr>
      <tr><td class="field"><code>notes</code></td><td>string</td><td>Free-form notes / their message. Alias: <code>message</code></td></tr>
      <tr><td class="field"><code>tags</code> <span style="color:#10b981;font-weight:600">★</span></td><td>string OR array</td><td><b>Labels.</b> Use comma-separated string <code>"hot,vip,priority"</code> or JSON array <code>["hot","vip"]</code>. Alias: <code>labels</code></td></tr>
      <tr><td class="field"><code>company</code></td><td>string</td><td>Company name</td></tr>
      <tr><td class="field"><code>city</code></td><td>string</td><td>City</td></tr>
      <tr><td class="field"><code>state</code></td><td>string</td><td>State / province</td></tr>
      <tr><td class="field"><code>country</code></td><td>string</td><td>Country</td></tr>
      <tr><td class="field"><code>pincode</code></td><td>string</td><td>Postal/ZIP. Alias: <code>zip</code></td></tr>
      <tr><td class="field"><code>address</code></td><td>string</td><td>Street address</td></tr>
      <tr><td class="field"><code>value</code></td><td>number</td><td>Estimated deal value</td></tr>
      <tr><td class="field"><code>currency</code></td><td>string</td><td>e.g. <code>INR</code>, <code>USD</code></td></tr>
      <tr><td class="field"><code>next_followup_at</code></td><td>ISO datetime</td><td>e.g. <code>2026-05-01T10:00:00Z</code></td></tr>
      <tr><td class="field"><code>source_ref</code></td><td>string</td><td>External reference — campaign ID, ad ID. Alias: <code>utm_campaign</code></td></tr>
      <tr><td class="field"><code>utm_source</code> / <code>utm_medium</code> / <code>utm_campaign</code> / <code>utm_term</code> / <code>utm_content</code></td><td>string</td><td>UTM parameters — auto-stored in lead's <code>meta_json</code> for reporting</td></tr>
      <tr><td class="field"><code>landing_page</code></td><td>string</td><td>URL the lead submitted from</td></tr>
      <tr><td class="field"><code>meta</code></td><td>object</td><td>Any additional structured data (kept on the lead)</td></tr>
    </tbody>
  </table>
</div>

<div class="card">
  <h2>4. Code samples</h2>
  <p>Click each tab to see how to call the API from your stack:</p>
  <div class="tabs">
    <button class="tab active" data-tab="curl">cURL</button>
    <button class="tab" data-tab="js">JavaScript (Node)</button>
    <button class="tab" data-tab="js-form">HTML form (browser)</button>
    <button class="tab" data-tab="php">PHP</button>
    <button class="tab" data-tab="python">Python</button>
    <button class="tab" data-tab="wp">WordPress</button>
  </div>

  <div class="tab-body active" data-tab="curl">
<pre><span class="c"># Replace YOUR_API_KEY below</span>
curl -X POST <span class="s">'${endpoint}'</span> \\
  -H <span class="s">"x-api-key: YOUR_API_KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{
    "name": "Rajesh Kumar",
    "phone": "+919876543210",
    "email": "rajesh@example.com",
    "source": "Website Contact Form",
    "product": "Premium Plan",
    "notes": "Wants a demo this week",
    "tags": "hot,demo-requested,enterprise",
    "city": "Mumbai",
    "value": 50000,
    "currency": "INR",
    "utm_source": "google",
    "utm_campaign": "summer-sale"
  }'</span></pre>
  </div>

  <div class="tab-body" data-tab="js">
<pre><span class="c">// Node.js / Next.js / any backend</span>
<span class="k">const</span> response = <span class="k">await</span> fetch(<span class="s">'${endpoint}'</span>, {
  method: <span class="s">'POST'</span>,
  headers: {
    <span class="s">'x-api-key'</span>: process.env.LEADCRM_API_KEY,
    <span class="s">'Content-Type'</span>: <span class="s">'application/json'</span>
  },
  body: JSON.stringify({
    name: <span class="s">'Rajesh Kumar'</span>,
    phone: <span class="s">'+919876543210'</span>,
    email: <span class="s">'rajesh@example.com'</span>,
    source: <span class="s">'Website'</span>,
    tags: [<span class="s">'hot'</span>, <span class="s">'demo-requested'</span>],   <span class="c">// ← labels as array</span>
    notes: <span class="s">'Wants a demo this week'</span>,
    utm_source: <span class="s">'google'</span>,
    utm_campaign: <span class="s">'summer-sale'</span>
  })
});
<span class="k">const</span> data = <span class="k">await</span> response.json();
console.log(data); <span class="c">// { ok: true, lead_id: 1234, assigned_to: 5 }</span></pre>
  </div>

  <div class="tab-body" data-tab="js-form">
<pre>&lt;<span class="k">form</span> id=<span class="s">"lead-form"</span>&gt;
  &lt;<span class="k">input</span> name=<span class="s">"name"</span> required /&gt;
  &lt;<span class="k">input</span> name=<span class="s">"phone"</span> required /&gt;
  &lt;<span class="k">input</span> name=<span class="s">"email"</span> /&gt;
  &lt;<span class="k">textarea</span> name=<span class="s">"message"</span>&gt;&lt;/textarea&gt;
  &lt;<span class="k">button</span>&gt;Submit&lt;/button&gt;
&lt;/<span class="k">form</span>&gt;

&lt;<span class="k">script</span>&gt;
document.getElementById(<span class="s">'lead-form'</span>).addEventListener(<span class="s">'submit'</span>, <span class="k">async</span> (e) =&gt; {
  e.preventDefault();
  <span class="k">const</span> data = Object.fromEntries(<span class="k">new</span> FormData(e.target));
  data.source = <span class="s">'Landing Page'</span>;
  data.tags = [<span class="s">'website-form'</span>, <span class="s">'auto-captured'</span>];
  <span class="k">const</span> r = <span class="k">await</span> fetch(<span class="s">'${endpoint}'</span>, {
    method: <span class="s">'POST'</span>,
    headers: { <span class="s">'x-api-key'</span>: <span class="s">'YOUR_KEY'</span>, <span class="s">'Content-Type'</span>: <span class="s">'application/json'</span> },
    body: JSON.stringify(data)
  });
  alert(r.ok ? <span class="s">'Thanks — we will reach out!'</span> : <span class="s">'Something went wrong'</span>);
});
&lt;/<span class="k">script</span>&gt;</pre>
    <div class="alert">⚠️ For static sites, route the call through your own backend. Don't put the API key directly in browser JS.</div>
  </div>

  <div class="tab-body" data-tab="php">
<pre>&lt;?<span class="k">php</span>
$data = [
    <span class="s">'name'</span>     =&gt; <span class="s">'Rajesh Kumar'</span>,
    <span class="s">'phone'</span>    =&gt; <span class="s">'+919876543210'</span>,
    <span class="s">'email'</span>    =&gt; <span class="s">'rajesh@example.com'</span>,
    <span class="s">'source'</span>   =&gt; <span class="s">'Website'</span>,
    <span class="s">'tags'</span>     =&gt; <span class="s">'hot,demo-requested'</span>,   <span class="c">// or as JSON array</span>
    <span class="s">'notes'</span>    =&gt; <span class="s">'Wants a demo'</span>,
];
$ch = curl_init(<span class="s">'${endpoint}'</span>);
curl_setopt_array($ch, [
    CURLOPT_POST           =&gt; <span class="k">true</span>,
    CURLOPT_RETURNTRANSFER =&gt; <span class="k">true</span>,
    CURLOPT_HTTPHEADER     =&gt; [
        <span class="s">'x-api-key: '</span> . getenv(<span class="s">'LEADCRM_API_KEY'</span>),
        <span class="s">'Content-Type: application/json'</span>,
    ],
    CURLOPT_POSTFIELDS     =&gt; json_encode($data),
]);
$response = curl_exec($ch);
$result = json_decode($response, <span class="k">true</span>);
curl_close($ch);
?&gt;</pre>
  </div>

  <div class="tab-body" data-tab="python">
<pre><span class="k">import</span> requests, os

response = requests.post(
    <span class="s">"${endpoint}"</span>,
    headers={
        <span class="s">"x-api-key"</span>: os.environ[<span class="s">"LEADCRM_API_KEY"</span>],
        <span class="s">"Content-Type"</span>: <span class="s">"application/json"</span>,
    },
    json={
        <span class="s">"name"</span>: <span class="s">"Rajesh Kumar"</span>,
        <span class="s">"phone"</span>: <span class="s">"+919876543210"</span>,
        <span class="s">"email"</span>: <span class="s">"rajesh@example.com"</span>,
        <span class="s">"source"</span>: <span class="s">"Website"</span>,
        <span class="s">"tags"</span>: [<span class="s">"hot"</span>, <span class="s">"demo-requested"</span>],
        <span class="s">"notes"</span>: <span class="s">"Wants a demo"</span>,
        <span class="s">"utm_source"</span>: <span class="s">"google"</span>,
    },
    timeout=10,
)
<span class="k">print</span>(response.json())</pre>
  </div>

  <div class="tab-body" data-tab="wp">
<pre><span class="c">// Add to your theme's functions.php — sends every Contact Form 7 submission to CRM</span>
add_action(<span class="s">'wpcf7_mail_sent'</span>, <span class="k">function</span>($contact_form) {
    $submission = WPCF7_Submission::get_instance();
    <span class="k">if</span> (!$submission) <span class="k">return</span>;
    $data = $submission-&gt;get_posted_data();

    wp_remote_post(<span class="s">'${endpoint}'</span>, [
        <span class="s">'headers'</span> =&gt; [
            <span class="s">'x-api-key'</span>   =&gt; <span class="s">'YOUR_API_KEY'</span>,
            <span class="s">'Content-Type'</span> =&gt; <span class="s">'application/json'</span>,
        ],
        <span class="s">'body'</span> =&gt; wp_json_encode([
            <span class="s">'name'</span>    =&gt; $data[<span class="s">'your-name'</span>] ?? <span class="s">''</span>,
            <span class="s">'email'</span>   =&gt; $data[<span class="s">'your-email'</span>] ?? <span class="s">''</span>,
            <span class="s">'phone'</span>   =&gt; $data[<span class="s">'your-phone'</span>] ?? <span class="s">''</span>,
            <span class="s">'notes'</span>   =&gt; $data[<span class="s">'your-message'</span>] ?? <span class="s">''</span>,
            <span class="s">'source'</span>  =&gt; <span class="s">'WordPress CF7'</span>,
            <span class="s">'tags'</span>    =&gt; <span class="s">'cf7,wordpress'</span>,
        ]),
    ]);
}, 10, 1);</pre>
  </div>
</div>

<div class="card">
  <h2>5. Adding labels (tags)</h2>
  <p>Labels group leads in the CRM — you can filter by label, route them to specific salespeople via assignment rules, and trigger automations on labels.</p>
  <h3>Two ways to send labels:</h3>
  <p><b>As an array (preferred):</b></p>
<pre>{
  <span class="s">"name"</span>: <span class="s">"Rajesh"</span>,
  <span class="s">"tags"</span>: [<span class="s">"hot"</span>, <span class="s">"enterprise"</span>, <span class="s">"demo-requested"</span>]
}</pre>
  <p><b>As a comma-separated string:</b></p>
<pre>{
  <span class="s">"name"</span>: <span class="s">"Rajesh"</span>,
  <span class="s">"tags"</span>: <span class="s">"hot,enterprise,demo-requested"</span>
}</pre>
  <p>Both forms produce identical results. The field name <code>labels</code> works as a synonym for <code>tags</code>.</p>
  <h3>Common label patterns</h3>
  <ul>
    <li><code>hot</code>, <code>warm</code>, <code>cold</code> — temperature</li>
    <li><code>vip</code>, <code>enterprise</code>, <code>smb</code> — segment</li>
    <li><code>demo-requested</code>, <code>pricing-page</code>, <code>contact-form</code> — intent signal</li>
    <li><code>fb-ad-{campaign-id}</code>, <code>google-ad-{ad-id}</code> — ad source</li>
    <li><code>retargeting</code>, <code>newsletter</code>, <code>partner</code> — channel</li>
  </ul>
  <p>You can then build assignment rules like "if tag contains <b>vip</b> → assign to senior sales rep" or automations like "if tag contains <b>demo-requested</b> → send WhatsApp template <i>demo_confirmation</i>".</p>
</div>

<div class="card">
  <h2>6. Response</h2>
  <p>On success the API returns:</p>
<pre>{
  <span class="s">"ok"</span>: <span class="k">true</span>,
  <span class="s">"lead_id"</span>: 1234,
  <span class="s">"assigned_to"</span>: 5,
  <span class="s">"is_duplicate"</span>: <span class="k">false</span>
}</pre>
  <p>If <code>is_duplicate</code> is <code>true</code>, the existing lead's ID is returned (the duplicate policy from CRM Settings decides whether to create a new lead, update the existing one, or merge).</p>
  <p>On error:</p>
<pre>{ <span class="s">"error"</span>: <span class="s">"Invalid API key"</span> }</pre>
  <table>
    <thead><tr><th>HTTP code</th><th>Meaning</th></tr></thead>
    <tbody>
      <tr><td><code>200</code></td><td>Lead created (or duplicate detected — check <code>is_duplicate</code>)</td></tr>
      <tr><td><code>400</code></td><td>Invalid request body</td></tr>
      <tr><td><code>401</code></td><td>Missing or wrong API key</td></tr>
      <tr><td><code>500</code></td><td>Server error</td></tr>
    </tbody>
  </table>
</div>

<div class="card">
  <h2>7. CSV bulk upload</h2>
  <p>For one-time imports use the CSV uploader instead of the API:</p>
  <ul>
    <li>Download the <a href="/api/sample.csv" download>sample CSV template</a></li>
    <li>Open the CRM → Leads → ⬆️ Upload CSV</li>
    <li>Drag your filled-in CSV file in</li>
  </ul>
</div>

</main>
<script>
function copyText(t, btn) {
  navigator.clipboard.writeText(t).then(() => {
    const o = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = o, 1500);
  });
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-body').forEach(t => t.classList.remove('active'));
  b.classList.add('active');
  document.querySelector('.tab-body[data-tab="' + b.dataset.tab + '"]').classList.add('active');
}));
</script>
</body></html>`;
}

(async () => {
  console.log(`[boot] starting Lead CRM on ${HOST}:${PORT} (node ${process.version})`);
  console.log(`[boot] DATABASE_URL set: ${!!process.env.DATABASE_URL}`);
  console.log(`[boot] JWT_SECRET set: ${!!process.env.JWT_SECRET}`);
  await bootstrap();
  try { require('./utils/reminders').start(); }
  catch (e) { console.error('[boot] reminders start failed:', e.message); }
  try { require('./routes/tat').startTatWorker(); }
  catch (e) { console.error('[boot] tat worker start failed:', e.message); }
  try { require('./routes/whatsbot').startCampaignWorker(); }
  catch (e) { console.error('[boot] wb campaign worker start failed:', e.message); }
  app.listen(PORT, HOST, () => {
    console.log('================================================');
    console.log(`Lead CRM running on http://${HOST}:${PORT}`);
    console.log('API dispatcher methods:', Object.keys(API).length);
    console.log('================================================');
  });
})();
