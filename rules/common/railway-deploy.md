# Railway Deploy

## Overview
Both repos deploy automatically to Railway on every push to `main`. No manual steps required.

| Service | Repo | Railway project | URL |
|---------|------|-----------------|-----|
| Celeste CRM | `lead-crm-node` | `celeste-crm` | `crm.celesteabode.com` |
| Stockbox CRM | `lead-crm-node` | `stockbox-crm` | **(Stockbox URL)** |
| SmartCRM SaaS | `smartcrm-saas` | `smartcrm-saas` | `app.smartcrmsolution.com` |

## Deploy Process
1. Push to `main` â GitHub Actions CI runs (syntax checks, APK build).
2. Railway detects the push via GitHub integration â runs `npm install` â starts `node server.js`.
3. On startup, `bootstrap()` applies `db/schema.sql` (all `IF NOT EXISTS` â safe to run every deploy).
4. Server starts on `$PORT` (set by Railway automatically).

## Environment Variables
These must be set in Railway's **Variables** tab for each service. Never commit them.

### Required (all services)
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (set automatically by Railway Postgres addon) |
| `JWT_SECRET` | Long random string for signing auth tokens â never change after deploy |
| `SEED_ADMIN_EMAIL` | Initial admin user email (only used on first boot) |
| `SEED_ADMIN_PASSWORD` | Initial admin password (only used on first boot) |

### WhatsApp / Forwarder (Celeste + Stockbox)
| Variable | Description |
|----------|-------------|
| `FORWARDER_REGISTER_URL` | `https://smartcrmsolution.com/whatsbot_register.php` |
| `FORWARDER_REGISTER_SECRET` | Must match `REGISTER_SECRET` in `whatsbot_register.php` |
| `BASE_URL` | Public URL of this Railway service (e.g. `https://crm.celesteabode.com`) |

### Optional
| Variable | Description |
|----------|-------------|
| `SKIP_BOOTSTRAP` | Set to `1` to skip schema migration on boot (not recommended) |
| `COMPANY_NAME` | Overrides the name shown in the UI |
| `COMPANY_LOGO_URL` | URL for the logo |
| `OPENAI_API_KEY` | For AI call summary feature |
| `WEBSITE_API_KEY` | Auto-generated on first boot if not set |

## Checking Deploy Status
1. Go to Railway dashboard â select project â **Deployments** tab.
2. Click the latest deployment â **Logs** tab.
3. Look for:
   ```
   [boot] schema applied.
   [boot] admin user exists (admin@crm.local) â skipping.
   Lead CRM running on http://0.0.0.0:PORT
   API dispatcher methods: N
   ```
4. If `API dispatcher methods` is lower than expected, a route file may have a syntax error.

## Rollback
1. Railway dashboard â Deployments â find the last good deploy â **Redeploy**.
2. Or: `git revert HEAD && git push` â triggers a new deploy with the revert.

## Adding a New Railway Service (new tenant)
1. Fork or reuse `lead-crm-node` on GitHub.
2. Create a new Railway project â connect the repo â add PostgreSQL addon.
3. Set all required env vars (especially `JWT_SECRET` â generate a new one per tenant).
4. Set `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` for the first admin.
5. Add a custom domain in Railway â update DINS CNAME.
6. After first boot, log in and go to Settings â WhatsBot â connect WhatsApp account.
7. The `_registerWithCentralForwarder` call during sign-in will auto-register the `phone_number_id` in the PHP forwarder.

## Railway Postgres Limits (Hobby plan)
- Storage: 1 GB included. Call recordings (BYTEA) can grow fast â monitor in Railway â Database â Storage.
- Max connections: 25. The Node pool handles this automatically.
- Backups: Manual only on Hobby. Set up a cron job or use Railway's Pro plan for automatic backups.
