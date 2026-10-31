/**
 * services/agent/autonomy-tools.js — the owner can set up and check what the Agent does on its own, from chat.
 *
 *   get_autonomy_settings      each action, its mode, its numbers and limits, and whether the plan holds it back
 *   update_autonomy_settings   change modes, discount cap, delays, daily limits, quiet hours, or pause everything
 *   get_agent_activity         what the Agent did on its own recently
 *
 * All of it goes through services/agent/autonomy.js (validatePatch, applyPreset, savePolicy), the same rules the Settings page,
 * the onboarding step and /api/autonomy use, so chat and Settings can never disagree.
 */
'use strict';
const autonomy = require('./autonomy');

module.exports = function createAutonomyTools() {
  const view = (policy, user) => ({
    paused: policy.paused,
    actions: autonomy.ACTION_KEYS.map(key => {
      const a = policy.actions[key];
      return { action: key, what: autonomy.ACTIONS[key].label, mode: a.mode, actuallyRunsAs: autonomy.effectiveMode(policy, key, user),
        heldBackBecause: autonomy.lockReason(policy, key, user) || undefined, settings: { ...a, mode: undefined } };
    }),
    limits: policy.limits,
  });

  const MODE = { type: 'string', enum: ['off', 'ask', 'auto'], description: 'off = never, ask = prepare it and wait for the owner\'s approval, auto = do it on its own (missed_call has only off and auto).' };
  const TOOL_DEFS = [
    { name: 'get_autonomy_settings',
      description: 'Show what the Agent is allowed to do on its own: for each action (reengage = email quiet leads, discount = offer a discount on a stalled quote, missed_call = text back missed WhatsApp calls, review, winback) whether it is off, asks first, or runs automatically, plus the limits (messages per day, contacts per customer, quiet hours, discount cap). Call it before changing anything and when the owner asks what the Agent will do by itself.',
      input_schema: { type: 'object', properties: {} } },
    { name: 'update_autonomy_settings',
      description: 'Change what the Agent may do on its own. Only change what the owner asked for. Use mode "auto" only when the owner clearly wants it to act without asking. A discount needs the owner to say the percentage: never pick one for them. Quiet hours are local hours 0 to 23 (quiet_from 20, quiet_to 8 means silent from 8pm to 8am). Automatic mode needs the Growth plan; on a lower plan it asks first, and the result says so. Say plainly what is now on, and what the limits are.',
      input_schema: { type: 'object', properties: {
        preset: { type: 'string', enum: Object.keys(autonomy.PRESETS), description: 'Start from a preset: ask_first, balanced or hands_off. Other fields are applied after it.' },
        paused: { type: 'boolean', description: 'true stops everything running on its own until resumed.' },
        reengage: { type: 'object', properties: { mode: MODE, quote_after_days: { type: 'number' }, cold_after_days: { type: 'number' } } },
        discount: { type: 'object', properties: { mode: MODE, percent: { type: 'number', description: 'How much to take off, 1 to 50. This is also the most the Agent will ever offer.' }, after_days: { type: 'number', description: 'Days of silence after a quote before offering.' }, valid_days: { type: 'number', description: 'How long the offer stays open.' }, min_quote_value: { type: 'number', description: 'Only quotes at or above this value.' }, monthly_budget: { type: 'number', description: 'Most total discount to offer per 30 days; 0 = no budget limit.' } } },
        missed_call: { type: 'object', properties: { mode: { type: 'string', enum: ['off', 'auto'] }, delay_minutes: { type: 'number' }, message: { type: 'string', description: 'The text-back. Merge fields: {{customerName}}, {{businessName}}, {{ownerName}}, {{bookingUrl}}. Only use wording the owner gave.' }, after_hours_message: { type: 'string', description: 'Used when the business is closed; may also use {{opensWhen}}.' } } },
        review: { type: 'object', properties: { mode: MODE } },
        winback: { type: 'object', properties: { mode: MODE } },
        daily_messages: { type: 'number', description: 'Most messages the Agent starts on its own per day.' },
        max_contacts_per_customer: { type: 'number', description: 'Most times the Agent contacts one customer in 30 days.' },
        quiet_from: { type: 'number' }, quiet_to: { type: 'number' },
      } } },
    { name: 'get_agent_activity',
      description: 'What the Agent has done on its own recently: follow-ups, discounts offered, missed-call text-backs, and anything it held back and why. Use for "what has the Agent been doing" or "did you text that customer back".',
      input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  ];

  const pick = (o, map) => { const out = {}; for (const [from, to] of Object.entries(map)) if (o && o[from] !== undefined) out[to] = o[from]; return out; };

  const HANDLERS = {
    async get_autonomy_settings(ctx) {
      const policy = await autonomy.getPolicy(ctx.db, ctx.userId);
      return { ok: true, configured: !!policy.configuredAt, ...view(policy, ctx.user), plan: ctx.user.plan || 'free' };
    },

    async update_autonomy_settings(ctx, input) {
      let cur = await autonomy.getPolicy(ctx.db, ctx.userId);
      if (input.preset) {
        const applied = autonomy.applyPreset(input.preset, cur);
        if (!applied) return { ok: false, error: 'Unknown preset.' };
        cur = applied;
      }
      const patch = { actions: {}, limits: {} };
      if (input.paused !== undefined) patch.paused = !!input.paused;
      if (input.reengage) patch.actions.reengage = pick(input.reengage, { mode: 'mode', quote_after_days: 'quoteAfterDays', cold_after_days: 'coldAfterDays' });
      if (input.discount) patch.actions.discount = pick(input.discount, { mode: 'mode', percent: 'percent', after_days: 'afterDays', valid_days: 'validDays', min_quote_value: 'minQuoteValue', monthly_budget: 'monthlyBudget' });
      if (input.missed_call) patch.actions.missed_call = pick(input.missed_call, { mode: 'mode', delay_minutes: 'delayMinutes', message: 'message', after_hours_message: 'afterHoursMessage' });
      if (input.review) patch.actions.review = pick(input.review, { mode: 'mode' });
      if (input.winback) patch.actions.winback = pick(input.winback, { mode: 'mode' });
      Object.assign(patch.limits, pick(input, { daily_messages: 'dailyMessages', max_contacts_per_customer: 'maxTouchesPer30d', quiet_from: 'quietFrom', quiet_to: 'quietTo' }));
      const v = autonomy.validatePatch(patch, cur);
      if (!v.ok) return { ok: false, error: v.error };
      const saved = await autonomy.savePolicy(ctx.db, ctx.userId, v.policy);
      ctx.actions.push('Updated what the Agent can do on its own');
      return { ok: true, corrections: v.notes.length ? v.notes : undefined, ...view(saved, ctx.user) };
    },

    async get_agent_activity(ctx, input) {
      const [items, summary] = await Promise.all([autonomy.listActivity(ctx.db, ctx.userId, { limit: Math.min(30, Number(input && input.limit) || 15) }), autonomy.activitySummary(ctx.db, ctx.userId)]);
      return { ok: true, last30Days: summary, recent: items.map(i => ({ action: i.kind, channel: i.channel, status: i.status, customer: i.who, why: i.reason || undefined, when: i.at,
        discount: i.detail && i.detail.percent ? `${i.detail.percent}% off` : undefined })) };
    },
  };
  return { TOOL_DEFS, HANDLERS };
};
