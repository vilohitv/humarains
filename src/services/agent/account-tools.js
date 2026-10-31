/**
 * services/agent/account-tools.js — destructive and account-level tools for the Agent.
 *
 * Factory (same pattern as services/agent/tools.js):
 *   const { TOOL_DEFS, HANDLERS } = require('./account-tools')(helpers);
 *
 * Safety model
 *  - Nothing destructive runs on the first call. The tool stores a pending
 *    action and returns a plain summary; the owner must confirm in a LATER
 *    message, and the Agent then calls confirm_pending_action.
 *  - confirm_pending_action refuses if the pending action was created in the
 *    same request (so the model cannot confirm on the owner's behalf) and if
 *    the owner's latest message is not an affirmative.
 *  - Passwords NEVER pass through the model. change_password only opens the
 *    secure account page.
 *  - Everything is scoped to ctx.userId.
 */
'use strict';

const crypto = require('crypto');

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_DELETE = 50;
// userId -> { id, kind, payload, summary, reqId, expires }
const pending = new Map();

// A reply counts as "yes" when it affirms and is not a refusal. Refusals are only matched when they lead the
// message or name the action ("don't delete"), so "yes, no more questions" or "yes but quickly" still confirm.
const AFFIRM = /(^|\b)(yes|yep|yeah|yup|ya|y|confirm(ed)?|go ahead|go for it|do it|proceed|continue|sure|ok|okay|absolutely|definitely|affirmative|correct|i'?m sure|that'?s right|(delete|remove|wipe|reset) (it|them|all|everything))\b/i;
const NEGATE = /^\s*(no|nope|nah|cancel|stop|wait|hold on|never ?mind|don'?t|do not|dont)\b|\b(cancel (it|that|this)|never ?mind|hold on|(don'?t|do not|dont) (delete|remove|reset|wipe|do|go))\b/i;
function isYes(msg) {
  const m = String(msg || '').trim();
  if (!m || !AFFIRM.test(m) || NEGATE.test(m)) return false;
  // A question ("are you sure?", "yes but what happens?") is not a go-ahead, unless it opens with a plain yes.
  if (m.includes('?') && !/^\s*(yes|yep|yeah|yup|confirm|do it|go ahead)\b[\s,.!]*$/i.test(m)) return false;
  return true;
}

function reqId(ctx) { return ctx._reqId || (ctx._reqId = crypto.randomBytes(6).toString('hex')); }
function sweep() { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k); }

module.exports = function createAccountTools(h) {
  const { clip, compactLead, loadLeads, resolveLead, ambiguity, leadsApi, scheduler } = h;

  const PROFILE_FIELDS = ['businessName', 'ownerName', 'phone', 'bookingUrl', 'website', 'address', 'description',
    'targetCustomer', 'responseTime', 'keyDifferentiators', 'paymentTerms',
    'quoteInfoNeeded', 'neverQuote', 'warrantyPolicy', 'paymentMethods', 'cancellationPolicy'];

  // Same request from the owner, however the model phrases the tool call: scope, or the resolved lead ids.
  const intentKey = (kind, payload, scope) => kind + ':' + (scope ? 'scope:' + scope : JSON.stringify(Array.isArray(payload.ids) ? [...payload.ids].sort() : [...(payload.scopes || [])].sort()));

  function stage(ctx, kind, payload, summary, scope) {
    sweep();
    const key = intentKey(kind, payload, scope);
    // The chat history the model sees is plain text, so after the owner says "yes" it often cannot recall the
    // confirmation id and prepares the same action again. If this is that same action, awaiting a yes that has
    // now arrived, carry it out instead of asking a second time.
    const prior = pending.get(ctx.userId);
    if (prior && prior.key === key && prior.reqId !== reqId(ctx) && prior.expires >= Date.now() && isYes(ctx.lastOwnerMessage)) {
      pending.delete(ctx.userId);
      return execute(ctx, prior);
    }
    const p = { id: 'pa_' + crypto.randomBytes(5).toString('hex'), key, kind, payload, summary, reqId: reqId(ctx), expires: Date.now() + PENDING_TTL_MS };
    pending.set(ctx.userId, p);
    ctx.waiting = true;
    return { ok: true, needsConfirmation: true, confirmationId: p.id, summary,
      message: 'NOTHING has been changed yet. Tell the owner exactly what will happen (' + summary + ') and ask them to reply yes to confirm. Do not call confirm_pending_action until they answer in their next message.' };
  }

  async function removeLead(ctx, lead) {
    try { await scheduler().cancelFollowUps(lead.id, ctx.db); } catch (_) {}
    await ctx.db.query("UPDATE workflow_runs SET status='cancelled', updated_at=NOW() WHERE lead_id=$1 AND user_id=$2 AND status IN ('running','waiting')", [lead.id, ctx.userId]).catch(() => {});
    await ctx.db.query('DELETE FROM lead_followup_jobs WHERE lead_id=$1 AND user_id=$2', [lead.id, ctx.userId]).catch(() => {});
    await ctx.db.query('DELETE FROM workflow_runs WHERE lead_id=$1 AND user_id=$2', [lead.id, ctx.userId]).catch(() => {});
    const r = await ctx.db.query('DELETE FROM leads WHERE id=$1 AND user_id=$2', [lead.id, ctx.userId]);
    return !r || r.rowCount === undefined || r.rowCount > 0;
  }

  async function execute(ctx, p) {
    if (p.kind === 'delete_leads') {
      let done = 0;
      for (const id of p.payload.ids) {
        const r = await resolveLead(ctx, { lead_id: id });
        if (r.lead && await removeLead(ctx, r.lead)) done++;
      }
      ctx.actions.push(`Deleted ${done} lead${done === 1 ? '' : 's'}`);
      return { ok: true, deleted: done };
    }

    if (p.kind === 'reset_account_data') {
      const { scopes } = p.payload;
      const patch = {};
      if (scopes.includes('business_profile')) {
        PROFILE_FIELDS.forEach(k => { patch[k] = ''; });
        patch.services = []; patch.onboardingComplete = false;
      }
      if (scopes.includes('agent_rules')) patch.specialInstructions = '';
      if (scopes.includes('settings_defaults')) {
        Object.assign(patch, { timezone: 'UTC', timezoneConfirmed: false, currency: 'USD', businessHoursStart: '09:00', businessHoursEnd: '17:00',
          businessHours: require('../../lib/business-hours').defaultSchedule(), businessDays: [1, 2, 3, 4, 5], defaultAppointmentDuration: 60, bufferTime: 15, noticePeriod: 24 });
      }
      if (Object.keys(patch).length) {
        await leadsApi().saveSettings(ctx.userId, { ...ctx.settings, ...patch }, ctx.db);
        Object.assign(ctx.settings, patch);
        ctx.profileUpdated = true;
      }
      if (scopes.includes('knowledge')) {
        const rows = await ctx.db.BusinessKnowledge.listByUser(ctx.userId).catch(() => []);
        for (const r of rows) await ctx.db.BusinessKnowledge.delete(r.id, ctx.userId).catch(() => {});
      }
      ctx.actions.push('Reset account data');
      return { ok: true, reset: scopes, note: scopes.includes('business_profile') ? 'The business profile is blank, so offer to set it up again now, one question at a time.' : undefined };
    }
    return { ok: false, error: 'Unknown action.' };
  }

  const TOOL_DEFS = [
    { name: 'delete_leads',
      description: 'Permanently delete leads and their conversation history. Step one of two: this only PREPARES the deletion and returns a summary; nothing is deleted until the owner confirms in their next message and you call confirm_pending_action. Use when the owner says delete, remove or get rid of a lead. Pick leads by id or name, or use scope "all_closed" / "all_lost" style bulk options. Max 50 at a time. Suggest set_do_not_contact instead if the owner only wants them to stop being messaged.',
      input_schema: { type: 'object', properties: {
        lead_id:   { type: 'string' },
        lead_name: { type: 'string', description: 'Name, email or phone fragment.' },
        lead_ids:  { type: 'array', items: { type: 'string' }, description: 'Several lead ids from a previous result.' },
        scope:     { type: 'string', enum: ['all_closed', 'all_leads'], description: 'Bulk: every closed lead, or every lead the owner has. all_leads only when the owner clearly asked to wipe all leads.' },
      } } },
    { name: 'reset_account_data',
      description: 'Reset parts of the owner\'s setup back to blank. Step one of two: only PREPARES the reset; nothing changes until the owner confirms next message and you call confirm_pending_action. Scopes: "business_profile" (name, owner, phone, links, description, services and prices; the interview restarts), "agent_rules" (all standing rules), "knowledge" (all saved business knowledge), "settings_defaults" (hours, timezone, currency, appointment settings back to defaults). Leads, billing and login are never touched.',
      input_schema: { type: 'object', properties: {
        scopes: { type: 'array', items: { type: 'string', enum: ['business_profile', 'agent_rules', 'knowledge', 'settings_defaults'] } },
      }, required: ['scopes'] } },
    { name: 'confirm_pending_action',
      description: 'Carry out the deletion or reset prepared earlier, ONLY after the owner replied with a clear yes to your summary in their latest message. Call it straight away when the owner says yes (the confirmationId is optional; do not prepare the action again and do not ask twice). If the owner said no or changed their mind, call cancel_pending_action instead.',
      input_schema: { type: 'object', properties: { confirmation_id: { type: 'string', description: 'Optional. Only the id from the prepare step if you still have it.' } } } },
    { name: 'cancel_pending_action',
      description: 'Drop a prepared deletion or reset because the owner said no or changed their mind.',
      input_schema: { type: 'object', properties: {} } },
    { name: 'change_password',
      description: 'Use when the owner wants to change or reset their password. Passwords must never be typed into this chat, so this opens the secure account page where they can do it. Never ask for, repeat or store a password.',
      input_schema: { type: 'object', properties: {} } },
    { name: 'update_account_name',
      description: 'Change the name on the owner\'s account (how they are greeted). Not the business name; use update_business_profile for that. Email address changes and password changes must be done on the account page, use open_page for those.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  ];

  const HANDLERS = {
    async delete_leads(ctx, input) {
      let leads = [];
      if (input.scope === 'all_closed' || input.scope === 'all_leads') {
        const all = await loadLeads(ctx);
        leads = input.scope === 'all_closed' ? all.filter(l => l.status === 'closed') : all;
      } else if (Array.isArray(input.lead_ids) && input.lead_ids.length) {
        for (const id of input.lead_ids.slice(0, MAX_DELETE)) {
          const r = await resolveLead(ctx, { lead_id: id });
          if (r.lead) leads.push(r.lead);
        }
      } else {
        const r = await resolveLead(ctx, input);
        const amb = ambiguity(r, input.lead_name); if (amb) return amb;
        leads = [r.lead];
      }
      if (!leads.length) return { ok: false, error: 'No matching leads to delete.' };
      if (leads.length > MAX_DELETE) return { ok: false, error: `That is ${leads.length} leads. I can delete up to ${MAX_DELETE} at a time. Ask the owner to narrow it down or confirm in batches.` };
      const names = leads.slice(0, 5).map(l => compactLead(l).name);
      const summary = leads.length === 1
        ? `permanently delete the lead ${names[0]} and their messages`
        : `permanently delete ${leads.length} leads (${names.join(', ')}${leads.length > 5 ? ', and more' : ''}) and their messages`;
      return stage(ctx, 'delete_leads', { ids: leads.map(l => l.id) }, summary, input.scope === 'all_closed' || input.scope === 'all_leads' ? input.scope : '');
    },

    async reset_account_data(ctx, input) {
      const valid = ['business_profile', 'agent_rules', 'knowledge', 'settings_defaults'];
      const scopes = [...new Set((input.scopes || []).filter(s => valid.includes(s)))];
      if (!scopes.length) return { ok: false, error: 'Say which part to reset: business profile, agent rules, knowledge or settings.' };
      const label = { business_profile: 'business profile and services', agent_rules: 'standing rules', knowledge: 'saved business knowledge', settings_defaults: 'hours and other settings' };
      return stage(ctx, 'reset_account_data', { scopes }, `reset your ${scopes.map(s => label[s]).join(', ')} to blank. Your leads, plan and login are not touched`);
    },

    async confirm_pending_action(ctx, input) {
      sweep();
      // The id is optional: an owner has at most one action waiting, and the model often cannot recall the id
      // across turns (the chat history it receives is plain text only).
      const p = pending.get(ctx.userId);
      if (!p) return { ok: false, error: 'There is nothing waiting for confirmation. Prepare the action again if the owner still wants it.' };
      if (p.reqId === reqId(ctx)) return { ok: false, error: 'The owner has not confirmed yet. Ask them first and wait for their next message.' };
      if (!isYes(ctx.lastOwnerMessage)) return { ok: false, error: 'The owner\'s latest message is not a clear yes. Ask again, or cancel_pending_action.' };
      pending.delete(ctx.userId);
      return execute(ctx, p);
    },

    async cancel_pending_action(ctx) {
      const had = pending.delete(ctx.userId);
      return { ok: true, cancelled: had };
    },

    async change_password(ctx) {
      ctx.ui.push({ type: 'open', page: 'account' });
      ctx.waiting = true;
      return { ok: true, opened: 'account',
        message: 'The account page is open. The owner changes their password there themselves. Say so in one short sentence and remind them never to type a password into this chat. If they forgot it, they can use Forgot password on the login screen.' };
    },

    async update_account_name(ctx, input) {
      const name = clip(input.name, 100);
      if (!name) return { ok: false, error: 'A name is needed.' };
      try { await ctx.db.query('UPDATE users SET name=$1 WHERE id=$2', [name, ctx.userId]); }
      catch (e) { return { ok: false, error: 'Could not update the name. Suggest the account page.' }; }
      ctx.user.name = name;
      ctx.actions.push('Updated your account name');
      return { ok: true, name };
    },
  };

  return { TOOL_DEFS, HANDLERS };
};
