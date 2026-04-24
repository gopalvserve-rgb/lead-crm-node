#!/usr/bin/env node
// Run schema.sql against DATABASE_URL.
// Usage:  node db/migrate.js        (or)   npm run migrate
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./pg');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('✓ Schema applied successfully.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('✗ Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
