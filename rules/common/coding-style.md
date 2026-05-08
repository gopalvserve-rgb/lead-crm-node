# Coding Style

## Language & Runtime
- Node.js (ES2020+). No TypeScript. Use `require()` â `import/export`.
- Async/await everywhere. Never `.then()` chains in new code.
- `const` by default. `let` only when reassignment is needed. Never `var`.

## Naming
- Files: `camelCase.js` (e.g. `recordings.js`, `knowledgeBase.js`)
- Functions: `camelCase`. Public API handlers prefixed with `api_` (e.g. `api_leads_list`).
- Internal helpers prefixed with `_` (e.g. `_findLeadByPhone`, `_cfg`).
- DB columns: `snake_case`. JS objects mirror DB column names exactly.
- Constants: `UPPER_SNAKE_CASE` for env vars (e.g. `process.env.JWT_SECRET`).

## API Handler Signature
Every exported `api_*` function must follow this pattern:
```js
async function api_example(token, arg1, arg2) {
  const me = await authUser(token);   // always first â throws on invalid token
  // ... logic ...
  return { ok: true, ... };           // always return a plain object
}
```
- First arg is always `token` (JWT string from the frontend).
- Throw `new Error('message')` for user-visible errors â the dispatcher returns `{ error: 'message' }`.
- Never return `null` or `undefined` â always return a plain object.

## Error Handling
- `try/catch` every DB call in non-trivial paths. Log with `console.error('[context]', e.message)`.
- Degrade gracefully: missing optional tables (e.g. `customers`, `tat_thresholds`) should catch and return `[]` or `{}`.
- Never swallow errors silently in primary code paths â at least `console.warn`.

## Database Access
- Use `db.query(sql, params)` for raw queries (parameterised â never string-interpolate user input).
- Use `db.insert(table, obj)` / `db.update(table, id, obj)` / `db.findById(table, id)` for simple ops.
- Use `db.nowIso()` for timestamps, not `new Date().toISOString()`.
- Always add `created_at: db.nowIso()` on INSERT. Always add `updated_at: db.nowIso()` on UPDATE.

## Code Size
- Keep functions under 80 lines. Split into private helpers (`_helperName`) if longer.
- No dead code, no commented-out blocks in commits.
- Avoid magic numbers â use a named constant or a brief comment explaining the value.

## Comments
- Comment the *why*, not the *what*. Code should be self-documenting for the *what*.
- JSDoc-style block comment on every `api_*` function explaining inputs, outputs, and key behaviour.
- Use `// TODO:` and `// FIXME:` tags â never leave silent hacks without a note.
