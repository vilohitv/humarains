/**
 * routes/workflows.js — Workflow Builder API
 *
 * Mounts at /api/workflows (server.js already runs requireAuth +
 * attachLeadsUser before this router, same pattern as /api/leads).
 *
 *  GET    /api/workflows                 — list workflows for user
 *  POST   /api/workflows                 — create a workflow
 *  GET    /api/workflows/templates       — starter templates
 *  GET    /api/workflows/runs            — recent runs across all workflows
 *  GET    /api/workflows/:id             — get one workflow
 *  PUT    /api/workflows/:id             — update name/description/trigger/steps
 *  DELETE /api/workflows/:id             — delete a workflow
 *  POST   /api/workflows/:id/activate    — turn on (validates first)
 *  POST   /api/workflows/:id/pause       — turn off
 *  POST   /api/workflows/:id/test        — dry-run against a lead, no real sends
 *  GET    /api/workflows/:id/runs        — run history for one workflow
 *  GET    /api/workflows/runs/:runId     — run detail + step-by-step event log
 *  POST   /api/workflows/runs/:runId/cancel
 *  POST   /api/workflows/runs/:runId/retry
 */
'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');

const {
  genWorkflowId, validateWorkflow, getTemplates,
  startRun, testRun, retryRun, cancelRun,
  listRunsForWorkflow, listRunsForUser, listEventsForRun,
  rowToWorkflow,
} = require('../services/workflows/engine');
const { getPlan, isUnlimited: planIsUnlimited, stepsUseAdvancedFeatures } = require('../config/plans');

const router = express.Router();
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try { return new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch (_) { return null; }
}

const wfLimiter = rateLimit({
  windowMs: 60_000, max: 30,
  keyGenerator: req => req.user ? String(req.user.id) : req.ip,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

function parseJ(v) {
  if (v == null) return v;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

// ── Row → API shape mappers ───────────────────────────────────
function rowToApiWorkflow(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    status: row.status,
    trigger: { type: row.trigger_type, config: parseJ(row.trigger_config) || {} },
    steps: parseJ(row.steps) || [],
    runCount: row.run_count || 0,
    activeRuns: extra.activeRuns,
    lastTriggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApiRun(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    leadId: row.lead_id,
    leadName: row.customer_name || row.from_name || row.from_email || row.from_phone || 'Unknown lead',
    status: row.status,
    context: parseJ(row.context) || {},
    waitUntil: row.wait_until,
    waitReason: row.wait_reason,
    errorMessage: row.error_message,
    dryRun: !!row.dry_run,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToApiEvent(row) {
  return {
    id: row.id, stepId: row.step_id, stepType: row.step_type,
    status: row.status, summary: row.summary, detail: parseJ(row.detail),
    createdAt: row.created_at,
  };
}

// ══════════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════════

// ── GET /api/workflows — list ─────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await req._db.queryAll(
      `SELECT w.id, w.user_id, w.name, w.description, w.status, w.trigger_type, w.trigger_config, w.steps,
              w.run_count, w.last_triggered_at, w.created_at, w.updated_at,
              COUNT(r.id) FILTER (WHERE r.status IN ('running','waiting')) AS active_runs
         FROM workflows w
         LEFT JOIN workflow_runs r ON r.workflow_id = w.id
        WHERE w.user_id=$1
        GROUP BY w.id, w.user_id, w.name, w.description, w.status, w.trigger_type, w.trigger_config, w.steps,
                 w.run_count, w.last_triggered_at, w.created_at, w.updated_at
        ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    const workflows = rows.map(r => rowToApiWorkflow(r, { activeRuns: parseInt(r.active_runs || 0, 10) }));
    res.json({ success: true, workflows });
  } catch (e) {
    console.error('[workflows] list error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/workflows/templates ──────────────────────────────
// NOTE: must come before /:id so Express doesn't swallow it as an id.
router.get('/templates', async (req, res) => {
  res.json({ success: true, templates: getTemplates() });
});

// ── GET /api/workflows/runs — cross-workflow activity feed ────
router.get('/runs', async (req, res) => {
  try {
    const rows = await listRunsForUser(req._db, req.user.id, 100);
    res.json({ success: true, runs: rows.map(rowToApiRun) });
  } catch (e) {
    console.error('[workflows] runs list error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/workflows/runs/:runId — run detail + event log ───
router.get('/runs/:runId', async (req, res) => {
  try {
    const row = await req._db.queryOne(
      `SELECT wr.*, w.name as workflow_name, l.from_name, l.from_email, l.customer_name, l.from_phone
         FROM workflow_runs wr
         JOIN workflows w ON w.id = wr.workflow_id
         LEFT JOIN leads l ON l.id = wr.lead_id
        WHERE wr.id=$1 AND wr.user_id=$2`,
      [req.params.runId, req.user.id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Run not found.' });
    const events = await listEventsForRun(req._db, req.params.runId);
    res.json({ success: true, run: rowToApiRun(row), events: events.map(rowToApiEvent) });
  } catch (e) {
    console.error('[workflows] run detail error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/workflows/runs/:runId/cancel ────────────────────
router.post('/runs/:runId/cancel', async (req, res) => {
  try {
    const row = await req._db.queryOne('SELECT id FROM workflow_runs WHERE id=$1 AND user_id=$2', [req.params.runId, req.user.id]);
    if (!row) return res.status(404).json({ success: false, message: 'Run not found.' });
    await cancelRun(req._db, req.params.runId);
    res.json({ success: true });
  } catch (e) {
    console.error('[workflows] cancel run error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/workflows/runs/:runId/retry ─────────────────────
router.post('/runs/:runId/retry', wfLimiter, async (req, res) => {
  try {
    const row = await req._db.queryOne('SELECT * FROM workflow_runs WHERE id=$1 AND user_id=$2', [req.params.runId, req.user.id]);
    if (!row) return res.status(404).json({ success: false, message: 'Run not found.' });

    const { rowToLead, getSettings } = require('./leads');
    const leadRow = await req._db.queryOne('SELECT * FROM leads WHERE id=$1', [row.lead_id]);
    if (!leadRow) return res.status(400).json({ success: false, message: 'The lead for this run no longer exists.' });

    const lead = rowToLead(leadRow);
    const businessContext = await getSettings(req.user.id, req._db);
    const claude = getClaude();

    const run = await retryRun(req._db, req.params.runId, { lead, user: req.dbUser, businessContext, claude, model: MODEL });
    if (!run) return res.status(404).json({ success: false, message: 'Run or workflow not found.' });
    res.json({ success: true, run: rowToApiRun({ ...run, workflow_name: undefined }) });
  } catch (e) {
    console.error('[workflows] retry run error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/workflows — create ──────────────────────────────
router.post('/', wfLimiter, async (req, res) => {
  const planConf = getPlan((req.dbUser && req.dbUser.plan) || 'free');
  if (planConf.workflowsLimit === 0) {
    return res.status(403).json({
      success: false,
      needsUpgrade: true,
      message: 'Workflow automation requires the Starter plan or above. Upgrade to start building workflows.',
    });
  }

  const { name, description, trigger, steps } = req.body;
  const payload = { name, description, trigger, steps: steps || [] };
  const { valid, errors } = validateWorkflow(payload);
  if (!valid) return res.status(400).json({ success: false, message: errors.join(' '), errors });

  if (!planConf.workflowAdvancedSteps && stepsUseAdvancedFeatures(payload.steps)) {
    return res.status(403).json({
      success: false,
      needsUpgrade: true,
      message: 'Branching and AI-decision steps (condition, AI Decision, Wait for Reply, AI Extract) require the Growth plan or above. Your current plan supports basic steps only.',
    });
  }

  const id = genWorkflowId();
  try {
    await req._db.query(
      `INSERT INTO workflows (id, user_id, name, description, status, trigger_type, trigger_config, steps)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7)`,
      [id, req.user.id, String(name).trim(), description || null, trigger.type, JSON.stringify(trigger.config || {}), JSON.stringify(steps || [])]
    );
    const row = await req._db.queryOne('SELECT * FROM workflows WHERE id=$1', [id]);
    res.status(201).json({ success: true, workflow: rowToApiWorkflow(row) });
  } catch (e) {
    console.error('[workflows] create error:', e.message);
    res.status(500).json({ success: false, message: 'Failed to create workflow: ' + e.message });
  }
});

// ── GET /api/workflows/:id ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const row = await req._db.queryOne('SELECT * FROM workflows WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!row) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    res.json({ success: true, workflow: rowToApiWorkflow(row) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/workflows/:id — save edits ───────────────────────
router.put('/:id', async (req, res) => {
  try {
    const existing = await req._db.queryOne('SELECT * FROM workflows WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!existing) return res.status(404).json({ success: false, message: 'Workflow not found.' });

    const { name, description, trigger, steps } = req.body;
    const payload = {
      name:   name    !== undefined ? name    : existing.name,
      trigger: trigger !== undefined ? trigger : { type: existing.trigger_type, config: parseJ(existing.trigger_config) },
      steps:  steps   !== undefined ? steps   : parseJ(existing.steps),
    };
    const { valid, errors } = validateWorkflow(payload);
    if (!valid) return res.status(400).json({ success: false, message: errors.join(' '), errors });

    const planConf = getPlan((req.dbUser && req.dbUser.plan) || 'free');
    if (!planConf.workflowAdvancedSteps && stepsUseAdvancedFeatures(payload.steps)) {
      return res.status(403).json({
        success: false,
        needsUpgrade: true,
        message: 'Branching and AI-decision steps (condition, AI Decision, Wait for Reply, AI Extract) require the Growth plan or above. Your current plan supports basic steps only.',
      });
    }

    await req._db.query(
      `UPDATE workflows SET name=$1, description=$2, trigger_type=$3, trigger_config=$4, steps=$5, updated_at=NOW() WHERE id=$6`,
      [
        String(payload.name).trim(),
        description !== undefined ? description : existing.description,
        payload.trigger.type,
        JSON.stringify(payload.trigger.config || {}),
        JSON.stringify(payload.steps || []),
        req.params.id,
      ]
    );
    const row = await req._db.queryOne('SELECT * FROM workflows WHERE id=$1', [req.params.id]);
    res.json({ success: true, workflow: rowToApiWorkflow(row) });
  } catch (e) {
    console.error('[workflows] update error:', e.message);
    res.status(500).json({ success: false, message: 'Failed to save workflow: ' + e.message });
  }
});

// ── DELETE /api/workflows/:id ──────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await req._db.query('DELETE FROM workflows WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/workflows/:id/activate ───────────────────────────
router.post('/:id/activate', async (req, res) => {
  try {
    const row = await req._db.queryOne('SELECT * FROM workflows WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!row) return res.status(404).json({ success: false, message: 'Workflow not found.' });

    const planConf = getPlan((req.dbUser && req.dbUser.plan) || 'free');
    const steps = parseJ(row.steps);

    if (!planConf.workflowAdvancedSteps && stepsUseAdvancedFeatures(steps)) {
      return res.status(403).json({
        success: false,
        needsUpgrade: true,
        message: 'This workflow uses branching/AI-decision steps, which require the Growth plan or above.',
      });
    }

    if (!planIsUnlimited(planConf.workflowsLimit)) {
      const { count } = await req._db.queryOne(
        `SELECT COUNT(*)::int AS count FROM workflows WHERE user_id=$1 AND status='active' AND trigger_type<>'manual' AND id != $2`,
        [req.user.id, req.params.id]
      );
      if (count >= planConf.workflowsLimit) {
        const nextPlan = planConf.key === 'free' ? 'Starter' : planConf.key === 'starter' ? 'Growth' : 'Pro';
        return res.status(403).json({
          success: false,
          needsUpgrade: true,
          message: `Your ${planConf.name} plan allows ${planConf.workflowsLimit} active workflow${planConf.workflowsLimit === 1 ? '' : 's'} at a time. Pause another workflow, or upgrade to ${nextPlan} for more.`,
        });
      }
    }

    const { valid, errors } = validateWorkflow({
      name: row.name,
      trigger: { type: row.trigger_type, config: parseJ(row.trigger_config) },
      steps,
    });
    if (!valid) return res.status(400).json({ success: false, message: 'Cannot activate — fix these issues first: ' + errors.join(' '), errors });
    if (!steps || !steps.length) {
      return res.status(400).json({ success: false, message: 'Add at least one step before activating.' });
    }

    await req._db.query(`UPDATE workflows SET status='active', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    const updated = await req._db.queryOne('SELECT * FROM workflows WHERE id=$1', [req.params.id]);
    res.json({ success: true, workflow: rowToApiWorkflow(updated) });
  } catch (e) {
    console.error('[workflows] activate error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/workflows/:id/pause ──────────────────────────────
router.post('/:id/pause', async (req, res) => {
  try {
    const result = await req._db.query(`UPDATE workflows SET status='paused', updated_at=NOW() WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    const updated = await req._db.queryOne('SELECT * FROM workflows WHERE id=$1', [req.params.id]);
    if (!updated) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    res.json({ success: true, workflow: rowToApiWorkflow(updated) });
  } catch (e) {
    console.error('[workflows] pause error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/workflows/:id/test — dry run, no real sends ─────
router.post('/:id/test', wfLimiter, async (req, res) => {
  try {
    const wfRow = await req._db.queryOne('SELECT * FROM workflows WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!wfRow) return res.status(404).json({ success: false, message: 'Workflow not found.' });

    const { rowToLead, getSettings } = require('./leads');
    let leadRow;
    if (req.body && req.body.leadId) {
      leadRow = await req._db.queryOne('SELECT * FROM leads WHERE id=$1 AND user_id=$2', [req.body.leadId, req.user.id]);
    } else {
      leadRow = await req._db.queryOne('SELECT * FROM leads WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.id]);
    }
    if (!leadRow) return res.status(400).json({ success: false, message: 'No lead available to test against — add a lead first.' });

    const lead = rowToLead(leadRow);
    const businessContext = await getSettings(req.user.id, req._db);
    const claude = getClaude();
    const workflow = rowToWorkflow(wfRow);

    const run = await testRun(req._db, { workflow, lead, user: req.dbUser, businessContext, claude, model: MODEL });
    const events = await listEventsForRun(req._db, run.id);
    res.json({
      success: true,
      run: rowToApiRun({ ...run, workflow_name: wfRow.name, from_name: lead.fromName, from_email: lead.fromEmail, customer_name: lead.customerName, from_phone: lead.fromPhone }),
      events: events.map(rowToApiEvent),
    });
  } catch (e) {
    console.error('[workflows] test run error:', e.message);
    res.status(500).json({ success: false, message: 'Test run failed: ' + e.message });
  }
});

// ── GET /api/workflows/:id/runs — run history for one workflow ─
router.get('/:id/runs', async (req, res) => {
  try {
    const wfRow = await req._db.queryOne('SELECT id FROM workflows WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!wfRow) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const rows = await listRunsForWorkflow(req._db, req.params.id, 100);
    res.json({ success: true, runs: rows.map(rowToApiRun) });
  } catch (e) {
    console.error('[workflows] workflow runs error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Factory: create router with db injected ───────────────────
function createWorkflowsRouter(db) {
  const r = express.Router();
  r.use((req, res, next) => { req._db = db; next(); });
  r.use('/', router);
  return r;
}

module.exports = { createWorkflowsRouter };
