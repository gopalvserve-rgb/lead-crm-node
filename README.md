# Lead CRM — Node.js / PostgreSQL edition

Self-hosted Lead CRM with Facebook Lead Ads integration, WhatsApp webhooks,
HR tooling (Attendance / Leaves / Tasks / Salary / Bank Details), role-based
visibility, duplicate lead policy, assignment rules, and a lightweight SPA.

**Stack:** Node.js 18+ · Express · PostgreSQL · JWT · bcrypt · vanilla JS SPA.

---

## 1. What you get

- **Leads** with custom fields, kanban, pipeline, remarks, bulk edit, WhatsApp quick-send, duplicate-lead detection
- **Follow-ups** (overdue / due today / upcoming) with in-app notifications
- **Users** with parent-child hierarchy (admin → manager → team_leader → sales)
- **Reports** — totals, by user, by status, by source
- **HR** — check-in/out (with optional GPS fence), leave requests & approvals, daily tasks, salary slips, bank details
- **Webhooks**
  - `POST /hook/meta` — Meta Lead Ads (with embedded Facebook Login to auto-subscribe pages)
  - `POST /hook/whatsapp` — WhatsApp Cloud API inbound messages
  - `POST /hook/website` — generic website form ingest (HMAC-style API key)
- **Settings page** — edit COMPANY_NAME, duplicate policy, SMTP, Meta / WhatsApp creds from the UI (persisted to the `config` table so they survive restarts)
- **One-click bootstrap** — visit `POST /setup` once on a fresh database and it applies the schema + creates the admin user

---

## 2. Quick start (local dev)

```bash
git clone https://github.com/YOUR_USER/lead-crm-node.git
cd lead-crm-node
npm install
cp .env.example .env          # then edit DATABASE_URL + JWT_SECRET
npm run migrate               # applies db/schema.sql
npm run seed                  # creates admin + default statuses + default sources
npm start                     # open http://localhost:3000
```

Default login: `admin@crm.local` / `admin123` — **change it on first login.**

---

## 3. Hosting options

### A. Railway + Railway Postgres (recommended — zero-config)

1. Push this repo to GitHub.
2. On [railway.app](https://railway.app) → New Project → Deploy from GitHub repo.
3. In the same project, click **+ New → Database → PostgreSQL**.
4. In the web service settings → Variables, Railway auto-injects `DATABASE_URL` from the linked Postgres. Add:
   ```
   JWT_SECRET=<run: openssl rand -base64 48>
   DB_SSL=1
   SEED_ADMIN_EMAIL=you@yourco.com
   SEED_ADMIN_PASSWORD=<long random>
   ```
5. In **Deploy → Start Command**, set: `node db/migrate.js && node db/seed.js && node server.js`
   (Or just hit `POST /setup` once after deploy.)
6. Visit the public Railway URL.

### B. Render.com + Neon Postgres (free tier friendly)

1. Create a Neon project at [neon.tech](https://neon.tech) → copy the pooled connection string.
2. On Render → New → Web Service → connect this repo → use build `npm install` and start `npm start`.
3. Add env vars: `DATABASE_URL`, `DB_SSL=1`, `JWT_SECRET`.
4. Deploy → once live, `curl -X POST https://YOURAPP.onrender.com/setup`.

### C. Supabase Postgres + Vercel (note: Vercel is serverless)

Vercel works but its serverless model isn't ideal for a long-running Express app. Prefer Railway/Render/Fly.io. If you still want Vercel, wrap `server.js` with `@vercel/node` and shorten pool idle timeout.

### D. Your own VPS

```bash
sudo apt install nodejs postgresql
sudo -u postgres createdb leadcrm
# create a user, update DATABASE_URL in .env
npm install && npm run migrate && npm run seed
# Run under pm2 or systemd
pm2 start server.js --name leadcrm
pm2 save
```

---

## 4. Custom domain

Point your `A` record (or Railway/Render's provided `CNAME`) at your host. After DNS propagates:

1. Update `META_VERIFY_TOKEN` if you change it — you'll re-verify the webhook in the Meta dashboard.
2. In Meta → App → Webhooks → Edit the `Page` subscription:
   - Callback URL: `https://yourdomain.com/hook/meta`
   - Verify token: same as `META_VERIFY_TOKEN`
   - Subscribe to `leadgen`.
3. In Meta → App → Facebook Login for Business → **Valid OAuth Redirect URIs** and **Javascript SDK Host Domain**, add `yourdomain.com`. (This is the thing the Apps Script version couldn't do because Apps Script iframes use random hostnames.)

---

## 5. Connecting Facebook (embedded login)

1. In the CRM, go to **Settings → Facebook / Meta**.
2. Paste `META_APP_ID` and `META_APP_SECRET` (get these from the Meta app dashboard) and save.
3. Click **Connect with Facebook** → a native FB popup asks you to select the page you want leads from.
4. The server exchanges the short-lived token for a 60-day long-lived token, subscribes the page to `leadgen`, and stores page token + ID in the `config` table.
5. From here on, when someone submits your lead ad form, Meta posts to `/hook/meta`, we fetch the lead via the Graph API, apply assignment rules, run duplicate policy, and create the lead.

---

## 6. Webhook URLs to share

| Purpose | URL |
|---|---|
| Meta Lead Ads | `POST https://yourdomain.com/hook/meta` |
| WhatsApp Cloud API | `POST https://yourdomain.com/hook/whatsapp` |
| Website form | `POST https://yourdomain.com/hook/website` (header `x-api-key: <WEBSITE_API_KEY>`) |
| Generic | `POST https://yourdomain.com/hook/other` (same API key) |

Website form payload:

```json
{ "name": "...", "phone": "...", "email": "...", "source": "Website Contact Form", "product": "...", "notes": "..." }
```

---

## 7. API reference (for the SPA + scripts)

Every call is `POST /api` with body `{ "fn": "<fn>", "args": [<token>, ...] }`.

Examples:

```js
fetch('/api', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ fn:'api_login', args:['admin@crm.local','admin123'] }) })
fetch('/api', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ fn:'api_leads_list', args:[token, { q:'john' }] }) })
```

Leads · Users · HR · Reports · Follow-ups · Facebook · Admin — see `routes/` for the full list (every exported `api_*` function is callable).

---

## 8. Migration from the Apps Script edition

Two easy paths:

**A.** Export the Google Sheet tabs → CSV → `COPY … FROM '…' CSV HEADER` in psql.
**B.** Run a one-off script: `node scripts/import-from-sheets.js <SHEET_ID>` (see `scripts/`).

Column names match 1:1 with the Apps Script sheets (`users`, `leads`, `statuses`, etc.). The only new thing is timestamps are `TIMESTAMPTZ` rather than formatted strings.

---

## 9. File layout

```
lead-crm-node/
├── server.js                # Express entry + /api dispatcher
├── package.json
├── .env.example
├── db/
│   ├── pg.js                # PostgreSQL adapter (same API as the old sheets.js)
│   ├── schema.sql           # Full schema
│   ├── migrate.js           # Runs schema.sql
│   └── seed.js              # Admin + defaults
├── utils/auth.js            # JWT + bcrypt
├── routes/
│   ├── auth.js  users.js  leads.js  admin.js
│   ├── statuses.js  sources.js  products.js  customFields.js
│   ├── rules.js  notifications.js  reports.js
│   ├── hr.js                # Attendance, Leaves, Tasks, Salary, Bank Details
│   ├── fb.js                # Facebook embedded-login connect/disconnect
│   ├── webhooks.js          # Meta / WhatsApp / Website inbound
│   └── setup.js             # One-click bootstrap via POST /setup
└── public/
    ├── index.html
    ├── app.js               # Vanilla JS SPA
    └── styles.css
```

---

## 10. Security notes

- JWT secret rotation: change `JWT_SECRET`, every user will need to log in again. Good.
- Sensitive config keys (`META_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `SMTP_PASSWORD`) are redacted as `••••••••` when the UI reads them back, but still stored in plaintext in the `config` table. If that's a concern, put them in host env vars only and leave the DB config entry blank.
- Set `EMAIL_NOTIFY_ENABLED=0` until SMTP works — the app won't crash if it can't send, but it will log errors on every follow-up reminder.
- The `/setup` endpoint is gated by: (a) first-run (no users exist), OR (b) `?key=<SETUP_KEY>` matches the env var of the same name. Set `SETUP_KEY` after first-run so nobody can reset your schema.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED … :5432` | Check `DATABASE_URL`. Railway/Neon require `DB_SSL=1`. |
| `ssl/tls required` | Same as above. |
| `password authentication failed` | Wrong password in DATABASE_URL. |
| Blank page after login | Open devtools → Network → look for 4xx from `/api`. Usually a stale JWT — click **Logout** and re-login. |
| Meta webhook verification fails | `META_VERIFY_TOKEN` must match exactly what you entered in the Meta app dashboard. |
| Facebook Login popup returns "Can't load URL" | Add your deployed domain to **Valid OAuth Redirect URIs** and to the JavaScript SDK domain list in the Meta app. |

---

## License

MIT.
