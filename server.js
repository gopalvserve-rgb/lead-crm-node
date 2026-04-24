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
  fb:          require('./routes/fb')
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
app.listen(PORT, () => {
  console.log('================================================');
  console.log(`Lead CRM running on http://localhost:${PORT}`);
  console.log('API dispatcher methods:', Object.keys(API).length);
  console.log('================================================');
});
