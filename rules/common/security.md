# Security

## Authentication
- Every `api_*` function must call `await authUser(token)` as its **first line**. No exceptions.
- `authUser` verifies the JWT signature using `JWT_SECRET` and returns the user object or throws.
- Tokens are short-lived (set in `utils/auth.js` â default 7 days). Admins can force-expire by rotating `JWT_SECRET` (invalidates all sessions).
- Never log tokens, passwords, or `JWT_SECRET` â not even in error messages.

## Authorisation
- Role hierarchy: `admin > manager > team_leader > sales > employee`
- Admin-only operations must check: `if (me.role !== 'admin') throw new Error('Admin only');`
- Lead visibility: use `getVisibleUserIds(me)` to filter â never return leads the user isn't allowed to see.
- Cross-tenant: the tenant's DB is isolated at the connection level (separate `DATABASE_URL` per service). Never accept a `tenant_id` param from untrusted input to switch DB context.

## API Key (Website Webhook)
- The `WEBSITE_API_KEY` is checked via the `x-api-key` header on `/hook/website`.
- Auto-generated on first boot as `leadcrm_<32 hex chars>`. Stored in the `config` table AND `process.env`.
- Admins can regenerate via Settings â API tab. Old key is invalidated immediately.
- Never put the API key in client-side JavaScript. Always server-side proxy.

## WhatsApp Token & Phone ID
- Stored in the `config` table (`WB_TOKEN`, `WB_PHONE_ID`, `WB_WABA_ID`).
- Displayed in Settings â WhatsBot (masked). Never logged in full.
- Cross-tenant guard: `expressEvent` checks `phone_number_id` from the incoming payload against `_myCfg.phoneId`. Mismatch = drop silently. This prevents Stockbox payloads from polluting Celeste.

## Input Validation
- All user input in SQL queries must be parameterised (`$1`, `$2`, ...). Never string-interpolate.
- Phone numbers: strip non-digits before use in queries (`String(phone).replace(/\D/g, '')`).
- File uploads (recordings): mime type checked, size capped at 25 MB (multer limit in server.js).
- Never trust `req.body.lead_id` as authorisation â verify the user can see the lead before returning data.

## Secrets Management
| Secret | Where stored | How to rotate |
|--------|-------------|---------------|
| `JWT_SECRET` | Railway env var | Change in Railway â all sessions invalidated |
| `WEBSITE_API_KEY` | Railway env var + config table | Settings â API tab â Regenerate |
| `WB_TOKEN` | config table | Settings â WhatsBot â Reconnect account |
| `FORWARDER_REGISTER_SECRET` | Railway env var + PHP server file | Change both simultaneously |
| `DATABASE_URL` | Railway env var (set by Railway) | Managed by Railway |

## HTTPS
- All Railway services are HTTPS-only (Railway enforces this via its proxy).
- The PHP forwarder (`smartcrmsolution.com`) must also be HTTPS â Meta requires HTTPS webhook URLs.
- Never accept webhook payloads over HTTP in production.

## Rate Limiting
- No explicit rate limiter is implemented yet. Railway's proxy provides basic DDoS protection.
- The `/hook/website` endpoint (lead ingestion) is protected by API key â effectively rate-limited to trusted callers.
- TODO: add `express-rate-limit` on `/api/login` to prevent brute-force attacks.

## Android APK
- The APK is signed with a keystore stored in GitHub Actions secrets (`KEYSTORE_FILE`, `KEY_ALIAS`, `KEY_PASSWORD`, `STORE_PASSWORD`).
- Never commit the keystore file to the repo.
- The APK is served from the Railway server at `/LeadCRM.apk` â it's public (no auth required to download, since it's a sideload install page).
- The APK communicates with the CRM only over HTTPS using JWT tokens. No hardcoded credentials in the APK.
