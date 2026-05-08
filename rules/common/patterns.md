# Patterns

## API Dispatcher Pattern
All `api_*` functions are auto-registered. Any function exported from a file in `routes/` that starts with `api_` becomes a callable endpoint via `POST /api { fn: "api_name", args: [...] }`.

```js
// In any routes/*.js file:
async function api_example(token, payload) {
  const me = await authUser(token);
  // ... logic
  return { ok: true };
}
module.exports = { api_example };
// â automatically callable as POST /api { fn: "api_example", args: [token, payload] }
```

## Auth Pattern
```js
const me = await authUser(token);
// me = { id, name, email, role, ... }
// Roles: 'admin' | 'manager' | 'team_leader' | 'sales' | 'employee'
// Always check role AFTER authUser â never before (token must be valid first)
if (me.role !== 'admin') throw new Error('Admin only');
```

## DB Helper Patterns
```js
// Simple insert â returns the new row's id
const id = await db.insert('table_name', { col1: val1, col2: val2 });

// Simple update by id
await db.update('table_name', rowId, { col: newVal, updated_at: db.nowIso() });

// Find by primary key
const row = await db.findById('table_name', id);  // returns row or null

// Find first match on a single column
const row = await db.findOneBy('table_name', 'column', value);

// Raw parameterised query
const { rows } = await db.query('SELECT ... WHERE id = $1', [id]);

// Get all rows (use sparingly â only for small config tables)
const rows = await db.getAll('statuses');
```

## Phone Normalisation Pattern
Phones arrive in many formats. Always normalise to last-10 digits for matching:
```js
const digits = String(phone || '').replace(/\D/g, '');
const tail   = digits.slice(-10);
// Match in SQL:
// regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%' || tail
```

## Tenant Isolation Pattern (smartcrm-saas)
Each tenant has its own PostgreSQL database named `tenant_<slug>`.
The multi-tenant server selects the correct DB connection by reading the slug from the URL path (`/t/<slug>`) or JWT claim. Never share a connection pool across tenants.

## WhatsApp Webhook Routing
1. Meta sends all webhooks to one endpoint (`/hook/whatsapp_webhook` on each Railway service, or the PHP central forwarder at `smartcrmsolution.com`).
2. The PHP forwarder reads `phone_number_id` from the payload and routes to the correct CRM instance.
3. The Node handler (`routes/whatsbot.js â expressEvent`) validates `phone_number_id` again â drops silently if it doesn't match this tenant's configured phone.

**Always guard against cross-tenant webhook pollution:**
```js
if (_myCfg.phoneId && _incomingPhoneId !== String(_myCfg.phoneId)) {
  return; // Drop silently â not for this tenant
}
```

## Config Pattern
Tenant-level config is stored in the `config` table as key-value pairs:
```js
// Read a config value
const val = await db.findOneBy('config', 'key', 'MY_KEY').then(r => r && r.value);
// Write a config value
await db.setConfig('MY_KEY', 'value');
// Or use the full loader (loads everything at once)
const cfg = await _cfg(); // returns object: { token, phoneId, wabaId, ... }
```

## Activity Log Pattern
Log all significant API calls (especially WhatsApp) to `activity_log` for debugging:
```js
await _logActivity({
  category: 'webhook_in',
  name: 'message_received',
  response_code: 200,
  request: { from, type },
  response: { lead_id, auto_created }
});
```

## Auto-Create Lead Pattern
When an inbound event (call, WhatsApp message) arrives from an unknown number:
1. Check if `WB_AUTOLEAD_ON = '1'` (for WA) or if call duration â¥ 5s (for calls).
2. Create lead with `source = 'Inbound Call'` or `'WhatsApp'`.
3. Assign to the current user (`me.id`).
4. Add an initial remark explaining the auto-creation.
5. Return `{ auto_created: true, lead_id }` so the frontend can show a toast + open the lead.
