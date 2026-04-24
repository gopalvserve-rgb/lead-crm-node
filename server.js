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
const db = require('./db/pg');

const routes = {
  auth:        require('./routes/auth'),
  users:       require('./routes/users'),
  leads:       require('./routes/leads'),
  admin:       require('./routes/admin'),
  customFields:require('./routes/customFields'),
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
  permissions: require('./routes/permissions')
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
    const result = await API[fn](...(args || []));
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[api]', fn, e.message, e.stack?.split('\n').slice(0, 5).join('\n'));
    res.status(400).json({ error: e.message || String(e) });
  }
});

// Webhooks
app.get('/hook/meta',      webhooks.metaVerify);
app.post('/hook/meta',     webhooks.metaEvent);
app.get('/hook/whatsapp',  webhooks.whatsappVerify);
app.post('/hook/whatsapp', webhooks.whatsappEvent);
app.post('/hook/website',  webhooks.websiteHook);
app.post('/hook/other',    webhooks.otherHook);

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
        <div class="muted">Android app · 873 KB · v1.0</div>
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

app.get('/api/sample.csv', (req, res) => {
  const csv = [
    'name,phone,email,whatsapp,source,product,city,tags,notes,next_followup_at',
    'John Doe,+911234567890,john@example.com,+911234567890,Website,Basic Plan,Mumbai,"hot,vip","Demo requested",2026-05-01 10:00',
    'Jane Smith,+919876543210,jane@example.com,+919876543210,Facebook Lead Ad,Premium,Delhi,vip,"Referred by John",',
    'Alex Kumar,+917777777777,,,WhatsApp,,Bangalore,cold,,'
  ].join('\n');
  res.type('text/csv').attachment('lead-crm-sample.csv').send(csv);
});

// Config for the frontend (non-secret; used to pre-populate CRM.webAppUrl etc.)
app.get('/config.json', (req, res) => {
  res.json({
    company_name: process.env.COMPANY_NAME || 'Lead CRM',
    company_logo_url: process.env.COMPANY_LOGO_URL || '',
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
  } catch (e) {
    console.error('[boot] bootstrap error:', e.message);
    console.error(e.stack);
    // Don't crash — start the server anyway so /config.json responds and we
    // get useful error messages via /api or the UI.
  }
}

(async () => {
  console.log(`[boot] starting Lead CRM on ${HOST}:${PORT} (node ${process.version})`);
  console.log(`[boot] DATABASE_URL set: ${!!process.env.DATABASE_URL}`);
  console.log(`[boot] JWT_SECRET set: ${!!process.env.JWT_SECRET}`);
  await bootstrap();
  try { require('./utils/reminders').start(); }
  catch (e) { console.error('[boot] reminders start failed:', e.message); }
  app.listen(PORT, HOST, () => {
    console.log('================================================');
    console.log(`Lead CRM running on http://${HOST}:${PORT}`);
    console.log('API dispatcher methods:', Object.keys(API).length);
    console.log('================================================');
  });
})();
