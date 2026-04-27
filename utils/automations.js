/**
 * utils/automations.js — event dispatcher for email / WhatsApp automations.
 *
 * fire(event, context) is called from routes/leads.js (and reminders, webhooks).
 * It loads active automations, filters by event + condition, and sends via the
 * configured channel.
 *
 * Supported events:
 *   lead_created       — ctx: { lead, user }
 *   status_changed     — ctx: { lead, user, new_status }
 *   lead_assigned      — ctx: { lead, user }
 *   followup_due       — ctx: { lead, followup }
 *
 * Template syntax: {{lead.name}}, {{lead.phone}}, {{lead.status_name}}, {{user.name}}, {{new_status.name}}, {{link}}, {{date}}
 *
 * Channels:
 *   email    — via nodemailer (requires SMTP config)
 *   whatsapp — via WhatsApp Cloud API (requires WHATSAPP_* env)
 *   webhook  — POST JSON to the configured URL (template is the URL)
 */
const db = require('../db/pg');

async function fire(event, ctx) {
  try {
    const automations = (await db.getAll('automations')).filter(a =>
      a.event === event && Number(a.is_active) === 1
    );
    if (!automations.length) return;
    for (const a of automations) {
      try {
        if (!_matchesCondition(a.condition, ctx)) {
          await _log(a, ctx, 'skipped', 'condition not met');
          continue;
        }
        const recipient = await _resolveRecipient(a, ctx);
        if (!recipient) {
          await _log(a, ctx, 'skipped', 'no recipient');
          continue;
        }
        const rendered = _render(a.template, ctx);
        const subject  = _render(a.subject || '', ctx);
        let result;
        if (a.channel === 'email')        result = await _sendEmail(recipient, subject, rendered);
        else if (a.channel === 'whatsapp') result = await _sendWhatsApp(recipient, rendered, ctx, a);
        else if (a.channel === 'webhook')  result = await _sendWebhook(rendered, ctx);
        else                               result = { ok: false, error: 'unknown channel: ' + a.channel };

        await _log(a, ctx, result.ok ? 'sent' : 'failed', result.detail || result.error || '');
      } catch (e) {
        await _log(a, ctx, 'failed', e.message);
      }
    }
  } catch (e) {
    console.error('[automations] fire error:', e.message);
  }
}

function _matchesCondition(cond, ctx) {
  if (!cond) return true;
  const c = String(cond).trim();
  if (!c) return true;
  // Simple syntax: field=value or field:value; multiple conditions joined by &&
  const parts = c.split(/\s*&&\s*/);
  for (const p of parts) {
    const [lhs, rhs] = p.split(/=|:/).map(s => s && s.trim());
    if (!lhs) continue;
    if (lhs.startsWith('tag')) {
      const tags = String(ctx.lead?.tags || '').toLowerCase().split(',').map(s => s.trim());
      if (!tags.includes(String(rhs || '').toLowerCase())) return false;
    } else if (lhs === 'status' || lhs === 'status_name') {
      if (String(ctx.new_status?.name || ctx.lead?.status_name || '').toLowerCase() !== String(rhs || '').toLowerCase()) return false;
    } else if (lhs === 'source') {
      if (String(ctx.lead?.source || '').toLowerCase() !== String(rhs || '').toLowerCase()) return false;
    } else if (lhs === 'product') {
      if (String(ctx.lead?.product_name || ctx.lead?.product || '').toLowerCase() !== String(rhs || '').toLowerCase()) return false;
    } else {
      // Generic: lead[field]
      const v = ctx.lead?.[lhs];
      if (String(v || '').toLowerCase() !== String(rhs || '').toLowerCase()) return false;
    }
  }
  return true;
}

async function _resolveRecipient(a, ctx) {
  const r = String(a.recipient || 'lead').toLowerCase();
  const lead = ctx.lead || {};
  if (r === 'lead') return a.channel === 'email' ? lead.email : lead.phone || lead.whatsapp;
  if (r === 'assignee') {
    if (!lead.assigned_to) return null;
    const u = await db.findById('users', lead.assigned_to);
    if (!u) return null;
    return a.channel === 'email' ? u.email : u.phone;
  }
  if (r === 'admin') {
    const admin = await db.findOneBy('users', 'role', 'admin');
    return admin ? (a.channel === 'email' ? admin.email : admin.phone) : null;
  }
  return r; // literal email or phone
}

function _render(tpl, ctx) {
  return String(tpl || '').replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    key = key.trim();
    const [ns, field] = key.split('.');
    let v;
    if (field === undefined) {
      v = { date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString() }[ns];
    } else {
      v = ctx[ns] && ctx[ns][field];
    }
    return v == null ? '' : String(v);
  });
}

async function _sendEmail(to, subject, html) {
  if (String(process.env.EMAIL_NOTIFY_ENABLED || '') !== '1') return { ok: false, error: 'SMTP disabled' };
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    });
    await t.sendMail({
      from: process.env.EMAIL_NOTIFY_FROM || 'Lead CRM <noreply@localhost>',
      to, subject, html
    });
    return { ok: true, detail: 'sent to ' + to };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function _sendWhatsApp(to, body, ctx, automation) {
  const phoneId = await db.getConfig('WHATSAPP_PHONE_NUMBER_ID', process.env.WHATSAPP_PHONE_NUMBER_ID);
  const token   = await db.getConfig('WHATSAPP_ACCESS_TOKEN', process.env.WHATSAPP_ACCESS_TOKEN);
  if (!phoneId || !token) return { ok: false, error: 'WhatsApp not configured' };

  // If the automation.subject starts with "template:" we send a Meta-approved template
  // Format:  subject="template:my_template_name:en_US"  template="{{lead.name}}|{{lead.phone}}"
  //                                                                 ↑ pipe-separated body params
  try {
    const fetch = require('node-fetch');
    const phone = String(to).replace(/\D/g, '');
    let payload;
    const subj = String(automation?.subject || '');
    if (subj.startsWith('template:')) {
      const parts = subj.split(':');
      const name = parts[1];
      const lang = parts[2] || 'en_US';

      // Look up the template metadata so we know how many body params Meta
      // actually expects. The cached row was populated by api_wb_templates_sync
      // and stores `body_params` (count of {{N}} placeholders in the body) +
      // `header_type` ('TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null). This is
      // the source of truth — without it we were sending whatever the user
      // pipe-typed, which produced (#132000) "Number of parameters does not
      // match the expected number" whenever a lead was missing a field.
      let expectedBodyParams = null;
      let headerType = null;
      let headerHasVar = false;
      try {
        const tpl = await db.findOneBy('wa_templates', 'name', name);
        if (tpl) {
          expectedBodyParams = Number(tpl.body_params) || 0;
          headerType = tpl.header_type || null;
          // If the header is TEXT and contains a {{N}} placeholder, we need a
          // header component too (otherwise Meta also returns 132000).
          try {
            const comps = typeof tpl.components_json === 'string'
              ? JSON.parse(tpl.components_json) : (tpl.components_json || []);
            const head = (comps || []).find(c => String(c.type).toUpperCase() === 'HEADER');
            if (head && head.format === 'TEXT' && /\{\{\d+\}\}/.test(head.text || '')) {
              headerHasVar = true;
            }
          } catch (_) {}
        }
      } catch (_) {}

      // Render the pipe-separated body params. Crucially we DO NOT filter out
      // empty strings — empties get replaced with a single em-dash so Meta still
      // sees a non-empty param at the expected position. Then we pad/truncate
      // to match the template's actual `body_params` count.
      const FALLBACK = '—';
      const splitParams = String(_render(body || '', ctx)).split('|').map(s => {
        const v = (s || '').trim();
        return v === '' ? FALLBACK : v;
      });
      let bodyParams = splitParams;
      if (expectedBodyParams !== null) {
        if (bodyParams.length < expectedBodyParams) {
          // Pad with em-dash so we always send the right count.
          while (bodyParams.length < expectedBodyParams) bodyParams.push(FALLBACK);
        } else if (bodyParams.length > expectedBodyParams) {
          bodyParams = bodyParams.slice(0, expectedBodyParams);
        }
      }

      const components = [];
      // Header component — required only when the header has a TEXT variable.
      // For IMAGE/VIDEO/DOCUMENT headers the automation flow doesn't yet
      // support attaching media, so we surface a clearer error than Meta's.
      if (headerHasVar) {
        components.push({
          type: 'header',
          parameters: [{ type: 'text', text: bodyParams[0] || FALLBACK }]
        });
      } else if (headerType && headerType !== 'TEXT') {
        return {
          ok: false,
          error: `Template "${name}" has a ${headerType} header — automations don't support media headers yet. Use a template with a TEXT or no header.`
        };
      }
      if (bodyParams.length > 0) {
        components.push({
          type: 'body',
          parameters: bodyParams.map(text => ({ type: 'text', text }))
        });
      }
      payload = {
        messaging_product: 'whatsapp', to: phone, type: 'template',
        template: { name, language: { code: lang }, components }
      };
    } else {
      payload = {
        messaging_product: 'whatsapp', to: phone, type: 'text',
        text: { body: String(body) }
      };
    }
    const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (j.error) {
      // Friendlier error for 132000 — the most common automation failure.
      if (Number(j.error.code) === 132000) {
        const tplName = (subj.startsWith('template:') && subj.split(':')[1]) || 'unknown';
        return {
          ok: false,
          error: `Template "${tplName}" param count mismatch. Re-sync templates and re-check the pipe-separated values in the automation. (${j.error.message})`
        };
      }
      return { ok: false, error: j.error.message };
    }
    return { ok: true, detail: 'wa_message_id=' + (j.messages?.[0]?.id || '?') };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function _sendWebhook(url, ctx) {
  if (!/^https?:/.test(url)) return { ok: false, error: 'template should be a URL for webhook channel' };
  try {
    const fetch = require('node-fetch');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: ctx.event, lead: ctx.lead, user: ctx.user })
    });
    return { ok: r.ok, detail: 'status ' + r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function _log(a, ctx, status, detail) {
  try {
    await db.insert('automation_log', {
      automation_id: a.id,
      lead_id: ctx.lead?.id || null,
      event: a.event,
      channel: a.channel,
      recipient: null,
      status, detail,
      created_at: db.nowIso()
    });
  } catch (_) {}
}

module.exports = { fire };
