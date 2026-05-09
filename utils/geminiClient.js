/**
 * utils/geminiClient.js — single-tenant edition.
 *
 * Wraps the Google Gemini API for lead-crm-node deployments
 * (Stockbox / Celeste). Mirrors the smartcrm-saas geminiClient API
 * surface so routes/aiBot.js can be ported with no behavioural change,
 * but resolves settings from THIS deployment's local config table
 * instead of a multi-tenant control DB.
 *
 * Key resolution order:
 *   1. config.GEMINI_API_KEY (set via Settings UI in the SPA)
 *   2. process.env.GEMINI_API_KEY (Railway env var)
 *
 * Pricing / markup are stored as plain config keys so the platform
 * operator can tune them without writing code:
 *   GEMINI_DEFAULT_MODEL          (default: gemini-2.5-flash-lite)
 *   GEMINI_PRICE_INPUT_USD_PER_M  (default: 0.10)
 *   GEMINI_PRICE_OUTPUT_USD_PER_M (default: 0.40)
 *   GEMINI_USD_INR_RATE           (default: 84)
 *   GEMINI_MARKUP_PCT             (default: 0)
 *
 * Caching: settings cached for 60 s.
 */
'use strict';

const db = require('../db/pg');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

let _settingsCache = null;
let _settingsCachedAt = 0;
const SETTINGS_TTL_MS = 60 * 1000;

async function loadSettings(force) {
  if (!force && _settingsCache && (Date.now() - _settingsCachedAt) < SETTINGS_TTL_MS) {
    return _settingsCache;
  }
  // Resolve key
  let apiKey = '';
  let keySource = null;
  try {
    const k = await db.getConfig('GEMINI_API_KEY', '');
    if (k && String(k).trim()) { apiKey = String(k).trim(); keySource = 'config_db'; }
  } catch (_) {}
  if (!apiKey && process.env.GEMINI_API_KEY) {
    apiKey = String(process.env.GEMINI_API_KEY).trim();
    if (apiKey) keySource = 'env';
  }
  if (!apiKey) return null;

  // Honour explicit disable flag
  let isActive = '1';
  try { isActive = await db.getConfig('GEMINI_AI_ENABLED', '1'); } catch (_) {}
  if (String(isActive) === '0') return null;

  const num = (k, def) => { try { const v = Number(k); return Number.isFinite(v) ? v : def; } catch (_) { return def; } };

  const defaultModel    = (await db.getConfig('GEMINI_DEFAULT_MODEL', '').catch(() => '')) || 'gemini-2.5-flash-lite';
  const priceIn         = num(await db.getConfig('GEMINI_PRICE_INPUT_USD_PER_M',  '0.10').catch(() => '0.10'), 0.10);
  const priceOut        = num(await db.getConfig('GEMINI_PRICE_OUTPUT_USD_PER_M', '0.40').catch(() => '0.40'), 0.40);
  const exchangeRateInr = num(await db.getConfig('GEMINI_USD_INR_RATE',           '84').catch(() => '84'),    84);
  const markupPct       = num(await db.getConfig('GEMINI_MARKUP_PCT',             '0').catch(() => '0'),       0);

  _settingsCache = {
    apiKey, keySource,
    defaultModel,
    embeddingModel: 'text-embedding-004',
    priceInputPerM:  priceIn,
    priceOutputPerM: priceOut,
    exchangeRateInr, markupPct,
  };
  _settingsCachedAt = Date.now();
  return _settingsCache;
}

function invalidateCache() { _settingsCache = null; _settingsCachedAt = 0; }

function computeCost(inTok, outTok, settings) {
  const usd = (inTok / 1e6) * settings.priceInputPerM + (outTok / 1e6) * settings.priceOutputPerM;
  const inrReal = usd * settings.exchangeRateInr;
  const inrBilled = inrReal * (1 + settings.markupPct / 100);
  return {
    cost_usd: Math.round(usd * 1e6) / 1e6,
    cost_inr_real: Math.round(inrReal * 100) / 100,
    cost_inr_billed: Math.round(inrBilled * 100) / 100,
  };
}

/**
 * Plain text generation (no tool-use).
 * args: { system, history, prompt, model, temperature, maxOutputTokens }
 * Returns { ok, text, model, input_tokens, output_tokens, cost_*, error }
 */
async function generate(args) {
  const settings = await loadSettings();
  if (!settings) {
    return { ok: false, text: '', model: '', input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             error: 'AI is not configured. Add GEMINI_API_KEY in Settings → AI Bot.' };
  }
  const model = String(args.model || settings.defaultModel);
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const contents = [];
  (args.history || []).forEach(h => {
    if (!h || !h.text) return;
    contents.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text) }] });
  });
  contents.push({ role: 'user', parts: [{ text: String(args.prompt || '') }] });
  const body = {
    contents,
    generationConfig: {
      temperature: args.temperature != null ? Number(args.temperature) : 0.3,
      maxOutputTokens: Number(args.maxOutputTokens || 800),
    }
  };
  if (args.system) body.systemInstruction = { role: 'system', parts: [{ text: String(args.system) }] };
  let resp, json;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    json = await resp.json();
  } catch (e) {
    return { ok: false, text: '', model, input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             error: 'Gemini network error: ' + e.message };
  }
  if (!resp.ok || json.error) {
    return { ok: false, text: '', model, input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             error: (json && json.error && json.error.message) || ('HTTP ' + resp.status) };
  }
  const cand = (json.candidates || [])[0] || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map(p => p.text || '').filter(Boolean).join('').trim();
  const usage = json.usageMetadata || {};
  const inTok = Number(usage.promptTokenCount || 0);
  const outTok = Number(usage.candidatesTokenCount || 0);
  const c = computeCost(inTok, outTok, settings);
  return {
    ok: true, text, model,
    input_tokens: inTok, output_tokens: outTok,
    cost_usd: c.cost_usd, cost_inr_real: c.cost_inr_real, cost_inr_billed: c.cost_inr_billed,
    finish_reason: cand.finishReason || null,
    error: null,
  };
}

/**
 * Append a row to ai_chat_log so the operator can see usage in Activity.
 * Best-effort — never throws.
 */
async function logUsage({ phone, lead_id, phone_number_id, draft_text, reply_text, mode_used, status, suppressed_reason, error_text, result }) {
  try {
    await db.query(
      `INSERT INTO ai_chat_log
        (phone, lead_id, phone_number_id, draft_text, reply_text, model,
         mode_used, input_tokens, output_tokens, cost_inr_billed,
         status, suppressed_reason, error_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        phone || '', lead_id || null, phone_number_id || null,
        (draft_text || '').slice(0, 8000), (reply_text || '').slice(0, 8000),
        (result && result.model) || '',
        mode_used || 'auto',
        (result && result.input_tokens) || 0, (result && result.output_tokens) || 0,
        (result && result.cost_inr_billed) || 0,
        status || ((result && result.ok) ? 'sent' : 'error'),
        suppressed_reason || null, error_text || (result && result.error) || null
      ]
    );
  } catch (e) { console.warn('[gemini] logUsage failed:', e.message); }
}

/**
 * Function-calling version. Loops up to maxTurns.
 * args: { system, history, prompt, tools, runTool, model, maxTurns, maxOutputTokens, temperature }
 */
async function generateWithTools(args) {
  const settings = await loadSettings();
  if (!settings) {
    return { ok: false, text: '', model: '', input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             tools_called: [], error: 'AI is not configured.' };
  }
  const model = String(args.model || settings.defaultModel);
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const tools = (args.tools && args.tools.length) ? [{ functionDeclarations: args.tools }] : undefined;

  const contents = [];
  (args.history || []).forEach(h => {
    if (!h || !h.text) return;
    contents.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text) }] });
  });
  contents.push({ role: 'user', parts: [{ text: String(args.prompt || '') }] });

  let inTok = 0, outTok = 0;
  const toolsCalled = [];
  const maxTurns = Math.max(1, Math.min(10, Number(args.maxTurns || 6)));
  let lastText = '';
  let lastFinish = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    const body = {
      contents,
      generationConfig: {
        temperature: args.temperature != null ? Number(args.temperature) : 0.3,
        maxOutputTokens: Number(args.maxOutputTokens || 1500),
      }
    };
    if (args.system) body.systemInstruction = { role: 'system', parts: [{ text: String(args.system) }] };
    if (tools) body.tools = tools;
    let resp, json;
    try {
      resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      json = await resp.json();
    } catch (e) {
      return { ok: false, text: '', model, input_tokens: inTok, output_tokens: outTok,
               cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
               tools_called: toolsCalled, error: 'Gemini network error: ' + e.message };
    }
    if (!resp.ok || json.error) {
      return { ok: false, text: '', model, input_tokens: inTok, output_tokens: outTok,
               cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
               tools_called: toolsCalled, error: (json && json.error && json.error.message) || ('HTTP ' + resp.status) };
    }
    const cand = (json.candidates || [])[0] || {};
    lastFinish = cand.finishReason || null;
    const usage = json.usageMetadata || {};
    inTok  += Number(usage.promptTokenCount || 0);
    outTok += Number(usage.candidatesTokenCount || 0);

    const parts = (cand.content && cand.content.parts) || [];
    const fnCalls = parts.filter(p => p.functionCall && p.functionCall.name).map(p => p.functionCall);
    if (fnCalls.length) {
      contents.push({ role: 'model', parts: parts.filter(p => p.functionCall) });
      const fnResponses = [];
      for (const fc of fnCalls) {
        const name = String(fc.name);
        const a = (fc.args && typeof fc.args === 'object') ? fc.args : {};
        let result;
        try { result = await args.runTool(name, a); }
        catch (e) { result = { error: e.message }; }
        toolsCalled.push({ name, args: a, result });
        fnResponses.push({ functionResponse: { name, response: { content: result } } });
      }
      contents.push({ role: 'user', parts: fnResponses });
      continue;
    }
    lastText = parts.map(p => p.text || '').filter(Boolean).join('').trim();
    break;
  }

  const c = computeCost(inTok, outTok, settings);
  return {
    ok: true, text: lastText, model,
    input_tokens: inTok, output_tokens: outTok,
    cost_usd: c.cost_usd, cost_inr_real: c.cost_inr_real, cost_inr_billed: c.cost_inr_billed,
    tools_called: toolsCalled, finish_reason: lastFinish, error: null,
  };
}

module.exports = { loadSettings, invalidateCache, generate, generateWithTools, logUsage, computeCost };
