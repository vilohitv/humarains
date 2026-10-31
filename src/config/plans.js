/**
 * plans.js — Single source of truth for plan tiers, usage limits, and feature gates.
 *
 * Every place in the codebase that needs to know "what does this plan include"
 * should import from here instead of hardcoding limits — that's what caused
 * the original free/pro/max sprawl across server.js, routes/leads.js, and
 * the front-end JS.
 *
 * DB integer columns store UNLIMITED (-1) to mean "no cap" — Postgres ints
 * can't hold Infinity, so -1 is the sentinel everywhere a limit is persisted.
 *
 * NOTE: the 'business' plan is displayed to users as "Pro" (name field below).
 * The internal key stays 'business' everywhere else (DB plan column, Stripe
 * env vars like STRIPE_BUSINESS_PRICE_ID, API payloads) — only the customer-
 * facing label changed. Don't rename the key without a DB change + Stripe
 * env var rename.
 *
 * 2026 REPRICE: went from 4 paid tiers (Starter/Growth/Business/Enterprise)
 * to 3 (Starter/Growth/Pro). The old 'enterprise' plan (displayed as "Max",
 * $3,999) was retired and folded into 'business' (displayed as "Pro"), which
 * dropped from $1,999 -> $999 (later repriced to $599) and picked up every feature that used to be
 * Enterprise-exclusive (unlimited sends).
 * 'enterprise' is kept as a deprecated ALIAS (see PLAN_ALIASES) so existing
 * DB rows / Stripe subscriptions on the old key don't break — getPlan('enterprise') resolves to
 * the same config as 'business'. Do not sell 'enterprise' going forward:
 * it's excluded from PLAN_ORDER and PAID_PLAN_KEYS.
 */
'use strict';

const UNLIMITED = -1;

const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    price: 0,
    // AI-handled inbound lead replies per calendar month
    leadSendsLimit: 10,
    // Max workflows that can be ACTIVE at once. 0 = can view/build drafts
    // and templates, but can never turn one on.
    workflowsLimit: 0,
    // condition / ai_decision / wait_for_reply / ai_extract steps (branching + AI logic)
    workflowAdvancedSteps: false,
    whatsapp: false,
    whatsappLimit: 0,
    calendar: false,
    // If false, agentMode is locked to 'consent' (every AI reply needs manual approval)
    autonomousMode: false,
    autoFollowUp: false,
    // AI Deal Insights (per-lead stall reason / objections / next action,
    // and the rolled-up "needs attention" feed in the AI Sales Manager) —
    // Pro only. AI lead scoring is Pro only too.
    dealInsights: false,
    leadScoring: false,
    // Agent: people per playbook per 24h on Autopilot, and recipients per one-off campaign
    autopilotDailyCap: 0,
    campaignMax: 0,
  },
  starter: {
    key: 'starter',
    name: 'Starter',
    price: 199,
    leadSendsLimit: 75,
    workflowsLimit: 1,
    workflowAdvancedSteps: false,
    // Starter gets WhatsApp, but capped lower than Growth (500); only Pro is unlimited
    whatsapp: true,
    whatsappLimit: 50,
    calendar: false,
    autonomousMode: false,
    autoFollowUp: false,
    dealInsights: false,
    leadScoring: false,
    autopilotDailyCap: 0,      // Autopilot needs autonomous mode (Growth+)
    campaignMax: 25,
  },
  growth: {
    key: 'growth',
    name: 'Growth',
    price: 399,
    leadSendsLimit: 400,
    // Growth is capped on purpose: the gap to Pro is volume (no caps) plus the
    // AI sales-intelligence suite (lead scoring + deal insights), which is Pro-only.
    workflowsLimit: 5,
    workflowAdvancedSteps: true,
    whatsapp: true,
    whatsappLimit: 500,
    calendar: true,
    autonomousMode: true,
    autoFollowUp: true,
    dealInsights: false,
    leadScoring: false,
    autopilotDailyCap: 10,
    campaignMax: 100,
  },
  business: {
    key: 'business',
    name: 'Pro',
    price: 599,
    // Merged tier: this used to be two plans (Business $1,999 / Enterprise
    // $3,999). Pro now carries the full former-Enterprise feature set —
    // unlimited sends — at a lower price, so it is the "no-limits" plan.
    // There is no tier above this one.
    // Pro-only on top of Growth: no caps on replies / WhatsApp /
    // workflows, plus the sales-intelligence suite (lead scoring + deal insights).
    leadSendsLimit: UNLIMITED,
    workflowsLimit: UNLIMITED,
    workflowAdvancedSteps: true,
    whatsapp: true,
    whatsappLimit: UNLIMITED,
    calendar: true,
    autonomousMode: true,
    autoFollowUp: true,
    dealInsights: true,
    leadScoring: true,
    // Pro runs the Agent at 5x the Growth pace: Autopilot and campaigns reach many more people per day
    autopilotDailyCap: 50,
    campaignMax: 500,
  },
};

// 'enterprise' is retired as a sellable plan (folded into 'business'/"Pro")
// but old DB rows / Stripe subscriptions may still carry the key until the
// the accounts are updated. Route lookups through PLAN_ALIASES so
// those accounts keep working — they land on the same config as 'business'.
const PLAN_ALIASES = {
  enterprise: 'business',
};

const PLAN_ORDER = ['free', 'starter', 'growth', 'business'];
const PAID_PLAN_KEYS = ['starter', 'growth', 'business'];

function getPlan(key) {
  const resolvedKey = PLAN_ALIASES[key] || key;
  return PLANS[resolvedKey] || PLANS.free;
}

function isValidPlan(key) {
  return Object.prototype.hasOwnProperty.call(PLANS, key) || Object.prototype.hasOwnProperty.call(PLAN_ALIASES, key);
}

function isUnlimited(n) {
  return n === UNLIMITED || n === Infinity;
}

// True if `used` has not yet reached `limit` (unlimited limits always pass)
function withinLimit(used, limit) {
  return isUnlimited(limit) || (used || 0) < limit;
}

// Workflow step types that count as "advanced" — branching and/or AI logic.
// Starter is restricted to plain send_message / wait / update_status / notify_owner.
const ADVANCED_STEP_TYPES = ['condition', 'ai_decision', 'wait_for_reply', 'ai_extract'];

function stepsUseAdvancedFeatures(steps) {
  if (!Array.isArray(steps)) return false;
  for (const s of steps) {
    if (!s) continue;
    if (ADVANCED_STEP_TYPES.includes(s.type) || (s.branches && s.branches.length)) return true;
    if (Array.isArray(s.branches)) {
      for (const b of s.branches) {
        if (stepsUseAdvancedFeatures(b.steps || [])) return true;
      }
    }
  }
  return false;
}

// Friendly upgrade target — first plan (in order) that satisfies `predicate`.
function cheapestPlanWhere(predicate) {
  for (const key of PLAN_ORDER) {
    if (predicate(PLANS[key])) return PLANS[key];
  }
  return null;
}

module.exports = {
  UNLIMITED,
  PLANS,
  PLAN_ALIASES,
  PLAN_ORDER,
  PAID_PLAN_KEYS,
  ADVANCED_STEP_TYPES,
  getPlan,
  isValidPlan,
  isUnlimited,
  withinLimit,
  stepsUseAdvancedFeatures,
  cheapestPlanWhere,
};
