/**
 * utils/r2.js — Cloudflare R2 object storage for blob offload.
 *
 * When R2_OFFLOAD=on, file blobs (call recordings) are stored in R2 instead of
 * Postgres BYTEA columns. A row keeps an `r2_key` pointing at the object; the
 * old BYTEA is left NULL. Reads prefer the BYTEA (legacy rows) and fall back to
 * R2 when only r2_key is present.
 *
 * Config (env):
 *   R2_OFFLOAD=on
 *   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   R2_BUCKET   (default smartcrm-recordings)
 *   R2_PREFIX   (default celeste/)   — keeps this project's objects in one folder
 */
'use strict';

const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const BUCKET = process.env.R2_BUCKET || 'smartcrm-recordings';
const PREFIX = process.env.R2_PREFIX || 'celeste/';

function enabled() {
  return String(process.env.R2_OFFLOAD || '').toLowerCase() === 'on'
    && !!process.env.R2_ENDPOINT
    && !!process.env.R2_ACCESS_KEY_ID
    && !!process.env.R2_SECRET_ACCESS_KEY;
}

let _client = null;
function client() {
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });
  }
  return _client;
}

function key(kind, idPart, filename) {
  const safe = String(filename || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${PREFIX}${kind}/${idPart}-${Date.now()}-${rnd}-${safe}`;
}

async function put(k, buffer, contentType) {
  await client().send(new PutObjectCommand({
    Bucket: BUCKET, Key: k, Body: buffer,
    ContentType: contentType || 'application/octet-stream'
  }));
  return k;
}

async function getBuffer(k) {
  const r = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: k }));
  const chunks = [];
  for await (const c of r.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

async function del(k) {
  try { await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })); }
  catch (_) { /* best-effort */ }
}

module.exports = { enabled, put, getBuffer, del, key, BUCKET, PREFIX };
