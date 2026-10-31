/**
 * routes/autonomy.js — /api/autonomy/*: what the Agent may do on its own.
 *
 *   GET    /                        the policy, the catalogue of actions, what each is really allowed to do on this plan,
 *                                   today's usage against the owner's limits
 *   PUT    /                        change it: { preset } and/or { actions, limits, paused } (partial; validated)
 *   POST   /pause   /resume         the master switch
 *   GET    /activity                what the Agent did on its own, newest first, with 30-day totals
 *   POST   /activity/:id/cancel     stop a queued action (a text-back that has not gone out)
 *   GET    /whatsapp-calling        whether Calling is switched on for the connected WhatsApp number
 *   POST   /whatsapp-calling        switch Calling on or off for it ({ enabled })
 *
 * Validation, plan limits and the log all live in services/agent/autonomy.js, the same code the onboarding step and the
 * Agent's chat tools use, so every way of changing the policy follows the same rules.
 */
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const autonomy = require('../services/agent/autonomy');

const limiter = rateLimit({
  windowMs: 60_000, max: 60,
  keyGenerator: req => (req.user ? String(req.user.id) : req.ip),
  message: { success: false, message: 'Too many requests. Please try again in a moment.' },
});

const parseJ = v => { if (v == null) return v; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } };

function createAutonomyRouter(db) {
  const router = express.Router();
  router.use(limiter);

  const leadsApi = () => require('./leads');
  const user = req => req.dbUser || { id: req.user.id, plan: 'free' };

  /** Everything the Settings page and the onboarding step need in one object. */
  async function state(req) {
    const u = user(req);
    const [policy, settings] = await Promise.all([autonomy.getPolicy(db, u.id), leadsApi().getSettings(u.id, db).catch(() => ({}))]);
    const intg = parseJ(u.integrations) || {};
    const { getPlan } = require('../config/plans');
    const plan = getPlan(u.plan || 'free');
    const used = await autonomy.sentToday(db, u.id);
    const offered = policy.actions.discount.monthlyBudget > 0 ? await autonomy.discountOfferedThisMonth(db, u.id) : 0;
    const actions = autonomy.ACTION_KEYS.map(key => ({
      key, label: autonomy.ACTIONS[key].label, help: autonomy.ACTIONS[key].help, channel: autonomy.ACTIONS[key].channel,
      modes: autonomy.ACTIONS[key].modes, mode: policy.actions[key].mode, effectiveMode: autonomy.effectiveMode(policy, key, u),
      lock: autonomy.lockReason(policy, key, u), settings: policy.actions[key],
    }));
    return {
      success: true, policy, actions,
      presets: Object.entries(autonomy.PRESETS).map(([key, p]) => ({ key, label: p.label, help: p.help,
        modes: Object.fromEntries(Object.entries(p.actions).map(([k, v]) => [k, v.mode])) })),
      bounds: autonomy.BOUNDS, callFields: autonomy.CALL_FIELDS,
      defaults: { callMessage: autonomy.DEFAULT_CALL_MESSAGE, callMessageClosed: autonomy.DEFAULT_CALL_MESSAGE_CLOSED },
      plan: { key: plan.key, name: plan.name, autonomousMode: !!plan.autonomousMode, whatsapp: !!plan.whatsapp },
      channels: { email: !!(intg.pipeline_email || intg.lead_email), whatsapp: !!(intg.whatsapp && intg.whatsapp.phoneNumberId) },
      currency: settings.currency || 'USD', timezone: settings.timezone || 'UTC', aiDiscountCeiling: Number(settings.maxDiscountPercent) || 0,
      usage: { sentToday: used, dailyMessages: policy.limits.dailyMessages, discountOffered30d: Math.round(offered) },
      configured: !!policy.configuredAt,
    };
  }

  router.get('/', async (req, res) => {
    try { res.json(await state(req)); }
    catch (e) { console.error('[autonomy] get failed:', e.message); res.status(500).json({ success: false, message: 'Could not load these settings.' }); }
  });

  router.put('/', async (req, res) => {
    try {
      const u = user(req), body = req.body || {};
      let cur = await autonomy.getPolicy(db, u.id);
      if (body.preset !== undefined) {
        const applied = autonomy.applyPreset(String(body.preset), cur);
        if (!applied) return res.status(400).json({ success: false, message: 'Unknown preset.' });
        cur = applied;
      }
      const patch = {};
      for (const k of ['actions', 'limits', 'paused']) if (body[k] !== undefined) patch[k] = body[k];
      let notes = [];
      if (Object.keys(patch).length) {
        const v = autonomy.validatePatch(patch, cur);
        if (!v.ok) return res.status(400).json({ success: false, message: v.error });
        cur = v.policy; notes = v.notes;
      }
      // The discount ceiling in Quote Rules is the owner's AI-wide limit; say so when it is lower than what was asked.
      const settings = await leadsApi().getSettings(u.id, db).catch(() => ({}));
      const ceiling = Number(settings.maxDiscountPercent) || 0;
      if (ceiling > 0 && cur.actions.discount.mode !== 'off' && cur.actions.discount.percent > ceiling) {
        notes.push(`Your Quote Rules cap AI discounts at ${ceiling}%, so offers will be ${ceiling}% at most. Raise that cap in Business Settings to offer more.`);
      }
      await autonomy.savePolicy(db, u.id, cur);
      res.json({ ...(await state(req)), notes });
    } catch (e) { console.error('[autonomy] save failed:', e.message); res.status(500).json({ success: false, message: 'Could not save. Nothing was changed.' }); }
  });

  for (const [path, paused] of [['/pause', true], ['/resume', false]]) {
    router.post(path, async (req, res) => {
      try {
        const u = user(req);
        const cur = await autonomy.getPolicy(db, u.id);
        await autonomy.savePolicy(db, u.id, { ...cur, paused }, { markConfigured: false });
        res.json(await state(req));
      } catch (e) { res.status(500).json({ success: false, message: 'Could not change that.' }); }
    });
  }

  router.get('/activity', async (req, res) => {
    try {
      const u = user(req);
      const limit = parseInt(req.query.limit, 10) || 30;
      const [items, summary] = await Promise.all([autonomy.listActivity(db, u.id, { limit }), autonomy.activitySummary(db, u.id)]);
      res.json({ success: true, items, summary });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load the activity.' }); }
  });

  router.post('/activity/:id/cancel', async (req, res) => {
    try {
      const ok = await autonomy.cancelQueued(db, user(req).id, req.params.id);
      res.json({ success: ok, message: ok ? 'Stopped.' : 'That one has already gone out or been handled.' });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not stop that.' }); }
  });

  // ── WhatsApp calling: the Calling API must be on for Meta to tell us about calls ──
  function waCreds(req) {
    const intg = parseJ(user(req).integrations) || {};
    const wa = intg.whatsapp || {};
    return wa.phoneNumberId && wa.accessToken ? { phoneNumberId: wa.phoneNumberId, accessToken: wa.accessToken } : null;
  }
  router.get('/whatsapp-calling', async (req, res) => {
    const creds = waCreds(req);
    if (!creds) return res.json({ success: true, connected: false, status: null });
    try { res.json({ success: true, connected: true, status: await require('../services/whatsapp').getCallingStatus(creds) }); }
    catch (e) { res.json({ success: true, connected: true, status: null, message: 'Could not check with WhatsApp: ' + e.message }); }
  });
  router.post('/whatsapp-calling', async (req, res) => {
    const creds = waCreds(req);
    if (!creds) return res.status(400).json({ success: false, message: 'Connect WhatsApp first.' });
    try {
      const enabled = !!(req.body && req.body.enabled);
      await require('../services/whatsapp').setCallingEnabled({ ...creds, enabled });
      res.json({ success: true, status: enabled ? 'ENABLED' : 'DISABLED' });
    } catch (e) { res.status(502).json({ success: false, message: 'WhatsApp would not change that: ' + e.message }); }
  });

  return router;
}

module.exports = { createAutonomyRouter };
