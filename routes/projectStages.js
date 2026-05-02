const db = require('../db/pg');
const { authUser } = require('../utils/auth');

/**
 * Post-sale project stages — admin defines a delivery workflow once,
 * reps advance leads through it after the sale. Each transition logs a
 * remark on the lead so the team has a paper trail.
 *
 * Examples (Celeste — real estate):
 *   Token received → Agreement signed → Loan sanctioned →
 *   Demand letters → Registry → Possession → Handover
 */
async function api_projectStages_list(token) {
  await authUser(token);
  const rows = await db.getAll('project_stages');
  return rows
    .filter(r => Number(r.is_active) === 1)
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
    .map(r => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      sort_order: Number(r.sort_order) || 10,
      expected_days: Number(r.expected_days) || 7,
      assignee_role: r.assignee_role || ''
    }));
}

async function api_projectStages_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if (!p.name) throw new Error('Stage name is required');
  const data = {
    name:          String(p.name).trim(),
    description:   p.description || '',
    sort_order:    Number(p.sort_order) || 10,
    expected_days: Number(p.expected_days) || 7,
    assignee_role: p.assignee_role || '',
    is_active:     p.is_active === 0 ? 0 : 1
  };
  if (p.id) {
    await db.update('project_stages', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  const id = await db.insert('project_stages', data);
  return { id, ok: true };
}

async function api_projectStages_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Soft delete
  await db.update('project_stages', id, { is_active: 0 });
  return { ok: true };
}

/**
 * Set the lead's project stage (or start the tracker by setting the first
 * stage). Logs a remark "🚚 Project: <stage_name> · <notes>" so the
 * timeline shows every transition.
 */
async function api_projectStages_setForLead(token, leadId, stageId, notes) {
  const me = await authUser(token);
  const lead = await db.findOneBy('leads', 'id', leadId);
  if (!lead) throw new Error('Lead not found');
  const stage = await db.findOneBy('project_stages', 'id', stageId);
  if (!stage) throw new Error('Stage not found');
  await db.update('leads', leadId, {
    project_stage_id: Number(stageId),
    project_stage_started_at: db.nowIso(),
    updated_at: db.nowIso()
  });
  await db.insert('remarks', {
    lead_id: leadId, user_id: me.id,
    remark: '🚚 Project stage → ' + stage.name +
            (notes ? ' · ' + String(notes).slice(0, 200) : ''),
    status_id: ''
  });
  return { ok: true, stage_id: Number(stageId), stage_name: stage.name };
}

/**
 * Move the lead to the NEXT stage (by sort_order). If no current stage,
 * sets the first one. If already on the last stage, no-op with a clear
 * error so the rep doesn't get a silent failure.
 */
async function api_projectStages_advanceLead(token, leadId, notes) {
  await authUser(token);
  const lead = await db.findOneBy('leads', 'id', leadId);
  if (!lead) throw new Error('Lead not found');
  const all = (await db.getAll('project_stages'))
    .filter(s => Number(s.is_active) === 1)
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  if (!all.length) throw new Error('No project stages defined yet — admin needs to create them under Settings → Project stages.');
  let nextStage;
  if (!lead.project_stage_id) {
    nextStage = all[0];
  } else {
    const idx = all.findIndex(s => Number(s.id) === Number(lead.project_stage_id));
    if (idx < 0) nextStage = all[0];
    else if (idx === all.length - 1) throw new Error('Lead is already on the final stage (' + all[idx].name + ').');
    else nextStage = all[idx + 1];
  }
  return api_projectStages_setForLead(token, leadId, nextStage.id, notes);
}

module.exports = {
  api_projectStages_list,
  api_projectStages_save,
  api_projectStages_delete,
  api_projectStages_setForLead,
  api_projectStages_advanceLead
};
