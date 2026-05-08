# Agents (AI Coding Rules)

Rules for Claude and any AI agent working on this project.

## Before Making Any Code Change
1. **Read the file first** â always read the current file from GitHub (raw URL) before editing. The local workspace may be behind.
2. **Check both repos** â changes often need to be mirrored in both `lead-crm-node` and `smartcrm-saas` (they share the same backend architecture). Confirm which repo is relevant before editing.
3. **Search before implementing** â if adding a new `api_*` handler, search the repo first (`grep` or GitHub code search) to confirm it doesn't already exist.

## Editing Files on GitHub (via Browser)
Use the CM6 editor workflow:
1. Navigate to the file on GitHub (`/blob/main/routes/filename.js`).
2. Click the pencil âï¸ edit button.
3. Use the CM6 `EditorView.dispatch()` approach to insert/replace content precisely.
4. **Always verify** the `old` string exists in the file before attempting a replace â "pair NOT FOUND" means the file has changed since you read it.
5. Commit with a message following the `git-workflow.md` format.

## Em Dash Warning
GitHub's file editor stores em dashes as U+2014 (`â`). When building `old` strings for CM6 replacement, use `String.fromCharCode(8212)` for em dashes â plain `--` will not match.

## Module.exports
When adding a new `api_*` function to a route file, **always add it to `module.exports`**. The dispatcher only registers exported functions. Missing from exports = silently unreachable.

## Schema Changes
- New tables and columns go in `db/schema.sql` using `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Never write one-time migration scripts â schema.sql must be idempotent (safe to run on every deploy).
- After adding a schema change, also add the corresponding index if the column will be queried/filtered.

## Testing After Edits
After any server-side change:
1. Check Railway logs for the service â confirm `API dispatcher methods: N` increased (or stayed the same if no new handlers were added).
2. Use curl to call the new/changed handler with a real token.
3. For WhatsApp-related changes: send a test webhook payload and check Railway logs for the expected log lines.

## What Agents Must NOT Do
- **Never commit `.env` files or secrets.**
- **Never modify `db/schema.sql` with non-idempotent SQL** (e.g. `DROP TABLE`, `ALTER TABLE RENAME`).
- **Never change `JWT_SECRET` in env vars** â it invalidates all existing sessions for that tenant.
- **Never push directly to a client's production repo without confirming the change is tested.**
- **Never hardcode phone numbers, tenant slugs, or API keys** in source code.
- **Never use `eval()` or `new Function()`** anywhere in the codebase.

## Confirming Deployments
After pushing to `main`, always:
1. Wait ~60 seconds for Railway to redeploy.
2. Hit `GET /config.json` on the service URL to confirm it's responding.
3. Check Railway logs for `[boot]` lines â users/statuses initialised, API dispatcher methods = expected number.

## Context Window Discipline
This project has large files (`public/app.js` is ~14,000 lines). When reading or need to search:
- Use `grep` / line-number offsets rather than reading the full file.
- For GitHub edits, fetch the raw file URL and search for the relevant section.
- Store intermediate results in temp variables / bash outputs rather than re-reading large files.
