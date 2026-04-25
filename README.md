# Lead CRM — Node.js / PostgreSQL edition

Self-hosted Lead CRM with Facebook Lead Ads integration, WhatsApp webhooks,
HR tooling (Attendance / Leaves / Tasks / Salary / Bank Details), role-based
visibility, duplicate-lead policy, assignment rules, and a lightweight SPA.

**Stack:** Node.js 18+ · Express · PostgreSQL · JWT · bcrypt · vanilla JS SPA.

> **Working with Claude on this repo?** Read the [`Working with Claude / AI agents`](#working-with-claude--ai-agents) section near the bottom — it's a complete onboarding for any AI agent that opens this repo without prior context.

---

## 1. What you get

- **Leads** with custom fields (text/textarea/number/date/select/multiselect/checkbox), kanban, pipeline, remarks, bulk edit, WhatsApp quick-send, duplicate-lead detection.
- **Follow-ups** (overdue / due today / upcoming) with in-app notifications.
- **Users** with parent-child hierarchy (admin → manager → team_leader → sales).
- **Reports** — totals, by user, by status, by source.
- **HR** — check-in/out (with optional GPS fence), leave requests & approvals, daily tasks, salary slips, bank details.
- **Webhooks**
  - `POST /hook/meta` — Meta Lead Ads (with embedded Facebook Login to auto-subscribe pages).
  - `POST /hook/whatsapp` — WhatsApp Cloud API inbound messages.
  - `POST /hook/website` — generic website form ingest (HMAC-style API key).
- **Settings page** — edit COMPANY_NAME, duplicate policy, SMTP, Meta / WhatsApp creds from the UI (persisted to the `config` table so they survive restarts).
- **One-click bootstrap** — visit `POST /setup` once on a fresh database and it applies the schema + creates the admin user.

---

## 2. Quick start (local dev)

```bash
git clone https://github.com/gopalvserve-rgb/lead-crm-node.git
cd lead-crm-node
npm install
cp .env.example .env          # then edit DATABASE_URL + JWT_SECRET
npm run migrate               # applies db/schema.sql
npm run seed                  # creates admin + default statuses + default sources
npm start                     # open http://localhost:3000
```

Default login: `admin@crm.local` / `admin123` — **change it on first login.**

---

## 3. Production deploy (Railway — current setup)

The live site is at `https://lead-crm-production-3628.up.railway.app/`. Deploy
flow:

1. Make code changes locally (or via a Cowork session).
2. Stage **only** the files you intend to ship — never `git add .`:
   ```bash
   git add public/app.js public/styles.css   # example
   git commit -m "fix(area): short message"
   git push
   ```
3. Railway picks up the commit on `main` and rebuilds in ~30s.
4. Verify the new code is live:
   ```bash
   curl -sL https://lead-crm-production-3628.up.railway.app/app.js | grep -c "<unique-string>"
   ```
5. Hard-refresh the browser (Ctrl+F5) — the PWA service worker caches assets.

> **Note:** the repo is configured with `branch.main.remote = <full URL>` rather than a named `origin` remote. Use plain `git push` — `git push origin main` will fail.

### Other host options

The repo also includes `render.yaml` (Render.com), a `Dockerfile`, and step-by-step instructions for VPS / Vercel / Supabase in the original docs. Don't deploy two production targets at once — the database is single-tenant.

---

## 4. Custom domain

Point your `A` record (or Railway/Render's provided `CNAME`) at your host. After DNS propagates:

1. Update `META_VERIFY_TOKEN` if you change it — you'll re-verify the webhook in the Meta dashboard.
2. In Meta → App → Webhooks → Edit the `Page` subscription:
   - Callback URL: `https://yourdomain.com/hook/meta`
   - Verify token: same as `META_VERIFY_TOKEN`
   - Subscribe to `leadgen`.
3. In Meta → App → Facebook Login for Business → **Valid OAuth Redirect URIs** and **Javascript SDK Host Domain**, add `yourdomain.com`.

---

## 5. Connecting Facebook (embedded login)

1. In the CRM, go to **Settings → Facebook / Meta**.
2. Paste `META_APP_ID` and `META_APP_SECRET` (from the Meta app dashboard) and save.
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

There is no traditional REST. Every call is `POST /api` with body
`{ "fn": "<fn>", "args": [<token>, ...] }`.

```js
fetch('/api', { method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({ fn:'api_login', args:['admin@crm.local','admin123'] }) })
fetch('/api', { method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({ fn:'api_leads_list', args:[token, { q:'john' }] }) })
```

The dispatcher is in `server.js`. Every `api_*` function exported from any
file in `routes/` is automatically callable.

---

## 8. File layout

```
lead-crm-node/
├── server.js                # Express entry + /api dispatcher (~720 lines)
├── package.json             # scripts: start, migrate, seed
├── railway.json             # Railway deploy config (Nixpacks)
├── render.yaml              # Render.com alternative
├── Dockerfile
├── README.md                # this file
├── APK-BUILD.md             # Capacitor / Android build instructions
├── db/
│   ├── pg.js                # PostgreSQL pool + query helper
│   ├── schema.sql           # Full schema (~378 lines)
│   ├── migrate.js           # Runs schema.sql (idempotent)
│   └── seed.js              # Admin + defaults
├── utils/
│   ├── auth.js              # JWT + bcrypt helpers
│   ├── automations.js       # Rule engine for auto-actions
│   ├── mailer.js            # Nodemailer SMTP transport
│   └── reminders.js         # Follow-up reminder cron
├── routes/                  # Each file exports api_* functions
│   ├── auth.js              users.js     leads.js
│   ├── customFields.js      statuses.js  sources.js   products.js
│   ├── rules.js             notifications.js   reports.js
│   ├── automations.js       permissions.js     recordings.js
│   ├── hr.js                # Attendance, Leaves, Tasks, Salary, Bank Details
│   ├── fb.js                # Facebook embedded-login connect/disconnect
│   ├── webhooks.js          # /hook/meta, /hook/whatsapp, /hook/website
│   ├── whatsapp.js          # WhatsApp outbound
│   ├── admin.js
│   └── setup.js             # POST /setup one-click bootstrap
├── public/                  # The entire frontend — no build step
│   ├── index.html           # SPA shell, login template, layout templates
│   ├── app.js               # ~4 240 lines of vanilla JS — all UI logic
│   ├── styles.css           # ~1 750 lines of CSS — :root vars at top
│   ├── sw.js                # Service worker (PWA caching)
│   ├── manifest.webmanifest
│   ├── icon-192.png · icon-512.png
│   ├── LeadCRM.apk · LeadCRM.aab     # Built Android wrappers
└── cap-app/                 # Capacitor wrapper for Android
```

### Key locator tips for `public/app.js`

| What you want | Search term |
|---|---|
| Lead-edit modal | `function openLeadModal` |
| Custom-field input renderer | `function customFieldInput` |
| Custom-field admin form | `function buildCustomFieldForm` |
| Bulk upload modal | `Bulk upload leads` |
| Kanban view | `function renderKanban` |
| Reports view | `function renderReports` |
| HR module | `function renderHr` |
| Toast helper | `function toast(` |

---

## 9. Security notes

- JWT secret rotation: change `JWT_SECRET`; every user re-logs in. Good.
- Sensitive config keys (`META_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `SMTP_PASSWORD`) are redacted as `••••••••` when the UI reads them back, but stored in plaintext in the `config` table. If that's a concern, put them in host env vars only and leave the DB config blank.
- Set `EMAIL_NOTIFY_ENABLED=0` until SMTP works — the app won't crash if it can't send, but it logs errors on every reminder.
- The `/setup` endpoint is gated by: (a) first-run (no users exist), OR (b) `?key=<SETUP_KEY>` matches the env var. Set `SETUP_KEY` after first-run.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Change didn't apply after deploy | Hard-refresh (Ctrl+F5). PWA service worker caches assets. Bump `CACHE_NAME` in `public/sw.js` for a strong invalidation. |
| `git push origin main` fails | Use plain `git push`. Origin isn't configured; `branch.main.remote` is the URL itself. |
| `ECONNREFUSED … :5432` | Check `DATABASE_URL`. Railway/Neon require `DB_SSL=1`. |
| `ssl/tls required` | Set `DB_SSL=1`. |
| `password authentication failed` | Wrong DATABASE_URL. |
| Blank page after login | Stale JWT — Logout and re-login. Or check Network for 4xx from `/api`. |
| Meta webhook verification fails | `META_VERIFY_TOKEN` must match exactly what's in the Meta app dashboard. |
| Facebook Login popup says "Can't load URL" | Add your domain to **Valid OAuth Redirect URIs** and JS SDK domain list in the Meta app. |
| Lead-edit popup body doesn't scroll | Already fixed (commit `fb1c299`). If recurring, set `overflow-y: auto` on `.modal.modal-lg`, sticky head + actions. |
| Custom dropdown options not visible | Same modal-scroll fix. Verify with `curl …/styles.css \| grep scrollbar-gutter`. |

---

## Working with Claude / AI agents

Any AI agent (Claude, Cursor, etc.) opening this repo can become productive in
under a minute by reading what follows.

### Onboarding paragraph

> You are working on a Lead CRM at `https://lead-crm-production-3628.up.railway.app/`.
> The source is in this repo. Stack: Node 18 + Express + PostgreSQL + a vanilla
> JS SPA in `public/`. There's no React, no build step, no traditional REST —
> the frontend calls `POST /api { fn, args }` and the backend dispatches by
> function name. Deploy: `git push` to `main` triggers a Railway redeploy in
> ~30s; the user must hard-refresh their browser to bypass the PWA cache.
> Working tree often has unstaged modifications from prior sessions — never
> `git add .`, always stage specific files. Use plain `git push` (no `origin`
> remote configured). Read this README's File layout section to find the right
> file before editing.

### Universal change recipe

1. Read `README.md` (this file) + the file map in §8.
2. Find the relevant file (`public/app.js` for frontend, `routes/*.js` for backend, `db/schema.sql` for data shape).
3. Edit with minimal diffs.
4. Sanity-check: `node --check <file>`.
5. Stage explicit files, commit, `git push`.
6. Wait ~30s, then `curl …/<file> | grep` for a unique string from your edit to confirm it deployed.
7. Tell the user to hard-refresh.

### Recipes for the most common changes

| Request | Edit |
|---|---|
| Frontend visual / layout / popup bug | `public/styles.css` and/or `public/app.js` |
| Add a new lead column | Use Admin → Custom fields UI; otherwise `db/schema.sql` + `routes/leads.js` + `public/app.js → openLeadModal` |
| New custom field type | `public/app.js → customFieldInput` (rendering) and `buildCustomFieldForm` (admin selector) |
| Lead-edit modal layout | `public/app.js → openLeadModal()` (line ~1500) |
| Brand colour | `:root` CSS variables in `public/styles.css` and `<meta name="theme-color">` in `public/index.html` |
| New API endpoint | Add `exports.api_<name>` in the appropriate `routes/<file>.js` |
| New DB table | `db/schema.sql` + `db/migrate.js` + `routes/<table>.js` + UI in `app.js` |
| Webhook tweak | `routes/webhooks.js` |
| Email send | `utils/mailer.js` |
| Cron / reminder | `utils/reminders.js` |

### Known-fixed bugs (don't re-diagnose)

- **Lead-edit modal scroll** — fixed at commit `fb1c299` (2026-04-25). `.modal.modal-lg` was `overflow: hidden` with no scroll child; clipped any content past 90vh. Fix: switched to `overflow-y: auto` with `position: sticky` head + actions.
- **Native multi-select unusable on phone** — fixed in same commit. `customFieldInput()` now renders multi-select as a checkbox grid (`.cf-multi-grid`).
- **Custom-column "Options" field always visible** — fixed in same commit. Now only shown for `select` / `multiselect`, with a textarea + chip preview.

### Companion skill

There's a Cowork-installable skill called `celeste-abode` that contains all of
this knowledge in a Claude-loadable format, plus deeper reference files. If
you're a human handing this codebase to an AI, install that skill instead of
pasting the onboarding paragraph each time.

---

## License

MIT.
