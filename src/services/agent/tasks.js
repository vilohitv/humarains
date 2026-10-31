/**
 * services/agent/tasks.js — temporary automations created by the Agent.
 *
 * When the owner asks the Agent to RUN something (a campaign, a one-off
 * message, "send this to everyone who asked about roofs"), the Agent builds a
 * workflow to do the job — but it is TEMPORARY: it is marked
 * trigger_config.temporary = true and removed automatically once the work is
 * done. Standing automations ("whenever a new lead arrives…") are permanent
 * and are never touched here.
 *
 * Before a temporary workflow is deleted its outcome is copied into
 * agent_tasks, because deleting a workflow cascades to its runs and events.
 * That row is what "how did the campaign do?" reads afterwards, and what the
 * Agent uses to tell the owner "finished — sent 14, 2 skipped".
 *
 * A temporary workflow is considered finished when:
 *   one-off job (trigger 'manual'): it was launched, the launch loop finished
 *     starting every run (or 30 min passed — the server restarted mid-launch),
 *     and no run is still running or waiting (waits, replies, approvals).
 *   event-driven temporary (trigger_config.expiresAt / maxRuns): the time or
 *     run budget is used up, it has been switched off, and no run is active.
 *   never launched (owner never pressed Launch): discarded after 7 days.
 *
 * sweepAll() is called from the poller each cycle; sweepForUser() is called
 * when the owner talks to the Agent so results are always fresh.
 */
'use strict';

const crypto = require('crypto');

const STALE_UNLAUNCHED_MS = 7 * 86400000;
const LAUNCH_STALL_MS     = 30 * 60000;

const genTaskId = () => 'tk_' + crypto.randomBytes(8).toString('hex');

function parseCfg(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { const p = JSON.parse(v); return typeof p === 'object' && p ? p : {}; } catch (_) { return {}; }
}

// ── results of a workflow's sends ────────────────────────────────
async function workflowStats(db, workflowId, userId) {
  const runs = await db.queryAll(
    'SELECT status, COUNT(*)::int AS c FROM workflow_runs WHERE workflow_id=$1 AND user_id=$2 AND dry_run=false GROUP BY status',
    [workflowId, userId]).catch(() => []);
  const runsByStatus = {}; let leadsStarted = 0;
  for (const r of runs) { runsByStatus[r.status] = r.c; leadsStarted += r.c; }

  const evs = await db.queryAll(
    `SELECT e.status AS st,
            CASE WHEN e.summary LIKE 'Sent via%' THEN 'sent'
                 WHEN e.summary LIKE '%queued for manual approval%' THEN 'queued'
                 ELSE 'other' END AS kind,
            COUNT(*)::int AS c
       FROM workflow_run_events e JOIN workflow_runs r ON r.id = e.run_id
      WHERE r.workflow_id=$1 AND r.user_id=$2 AND r.dry_run=false AND e.step_type='send_message'
      GROUP BY 1, 2`, [workflowId, userId]).catch(() => []);
  const messages = { sent: 0, queuedForApproval: 0, skipped: 0, failed: 0 };
  for (const e of evs) {
    if (e.kind === 'sent') messages.sent += e.c;
    else if (e.kind === 'queued') messages.queuedForApproval += e.c;
    else if (e.st === 'error') messages.failed += e.c;
    else messages.skipped += e.c;
  }
  return { leadsStarted, runsByStatus, messages };
}

async function activeRunCount(db, workflowId) {
  const r = await db.queryOne(
    "SELECT COUNT(*)::int AS c FROM workflow_runs WHERE workflow_id=$1 AND status IN ('running','waiting')", [workflowId]).catch(() => null);
  return (r && r.c) || 0;
}

// ── task rows ────────────────────────────────────────────────────
async function createTask(db, { userId, workflowId, kind, name, audienceLabel, recipients, preview }) {
  const id = genTaskId();
  await db.query(
    `INSERT INTO agent_tasks (id, user_id, workflow_id, kind, name, audience_label, recipients, message_preview, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',NULL)`,
    [id, userId, workflowId, kind || 'campaign', String(name).slice(0, 160), audienceLabel ? String(audienceLabel).slice(0, 160) : null,
     recipients || 0, preview ? String(preview).slice(0, 600) : null]);
  return id;
}

async function listTasks(db, userId, limit) {
  return db.queryAll(
    `SELECT id, workflow_id, kind, name, audience_label, recipients, message_preview, status,
            runs_started, sent, queued, skipped, failed, started_at, finished_at, created_at
       FROM agent_tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(30, limit || 10))]).catch(() => []);
}

async function getTask(db, userId, idOrWorkflowId) {
  return db.queryOne(
    'SELECT * FROM agent_tasks WHERE user_id=$1 AND (id=$2 OR workflow_id=$2) ORDER BY created_at DESC LIMIT 1',
    [userId, String(idOrWorkflowId)]).catch(() => null);
}

async function markStarted(db, userId, taskId) {
  if (!taskId) return;
  await db.query('UPDATE agent_tasks SET started_at=NOW() WHERE id=$1 AND user_id=$2 AND started_at IS NULL', [taskId, userId]).catch(() => {});
}

// Finished tasks the owner has not been told about yet (the Agent mentions
// them proactively), and the call that records they have been told.
async function unnotifiedFinished(db, userId) {
  return db.queryAll(
    `SELECT id, kind, name, status, recipients, runs_started, sent, queued, skipped, failed, finished_at
       FROM agent_tasks WHERE user_id=$1 AND notified_at IS NULL AND status <> 'running'
      ORDER BY finished_at DESC NULLS LAST LIMIT 5`, [userId]).catch(() => []);
}
async function ackTasks(db, userId, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).slice(0, 20);
  if (!list.length) return;
  await db.query('UPDATE agent_tasks SET notified_at=NOW() WHERE user_id=$1 AND id = ANY($2::text[])', [userId, list]).catch(() => {});
}

// ── finish a temporary workflow: record outcome, then delete it ──
async function finishAndDelete(db, row, status) {
  const cfg = parseCfg(row.trigger_config);
  const stats = await workflowStats(db, row.id, row.user_id);
  const m = stats.messages;
  const queued = m.queuedForApproval;

  let taskId = cfg.taskId || null;
  if (taskId) {
    await db.query(
      `UPDATE agent_tasks SET status=$1, runs_started=$2, sent=$3, queued=$4, skipped=$5, failed=$6,
              finished_at=NOW(), started_at=COALESCE(started_at, NOW())
        WHERE id=$7 AND user_id=$8`,
      [status, stats.leadsStarted, m.sent, queued, m.skipped, m.failed, taskId, row.user_id]);
  } else {
    taskId = genTaskId();
    await db.query(
      `INSERT INTO agent_tasks (id, user_id, workflow_id, kind, name, status, runs_started, sent, queued, skipped, failed, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      [taskId, row.user_id, row.id, row.trigger_type === 'manual' ? 'campaign' : 'automation', String(row.name).slice(0, 160),
       status, stats.leadsStarted, m.sent, queued, m.skipped, m.failed]);
  }
  // CASCADE removes the runs and events; the outcome is already saved above.
  await db.query('DELETE FROM workflows WHERE id=$1 AND user_id=$2', [row.id, row.user_id]);
  return { taskId, status, stats };
}

// Decide whether one temporary workflow is done. Returns a result when it was
// removed, otherwise null. Never touches a workflow that is not temporary.
async function sweepRow(db, row, now) {
  const cfg = parseCfg(row.trigger_config);
  if (cfg.temporary !== true) return null;
  const t = now || Date.now();
  const active = await activeRunCount(db, row.id);

  if (row.trigger_type === 'manual') {
    if (!cfg.launchedAt) {
      if (t - new Date(row.created_at).getTime() > STALE_UNLAUNCHED_MS) return finishAndDelete(db, row, 'cancelled');
      return null;
    }
    const loopDone = !!cfg.startedAllAt || (t - new Date(cfg.launchedAt).getTime() > LAUNCH_STALL_MS);
    if (loopDone && active === 0) return finishAndDelete(db, row, 'completed');
    return null;
  }

  // event-driven temporary automation
  const expired = cfg.expiresAt && t >= new Date(cfg.expiresAt).getTime();
  const spent   = cfg.maxRuns && (row.run_count || 0) >= cfg.maxRuns;
  if (!expired && !spent) return null;
  if (row.status === 'active') {
    await db.query("UPDATE workflows SET status='paused', updated_at=NOW() WHERE id=$1 AND user_id=$2", [row.id, row.user_id]);
  }
  if (active === 0) return finishAndDelete(db, row, expired ? 'expired' : 'completed');
  return null;
}

async function sweepWorkflow(db, workflowId, userId) {
  const row = await db.queryOne('SELECT * FROM workflows WHERE id=$1 AND user_id=$2', [workflowId, userId]).catch(() => null);
  return row ? sweepRow(db, row).catch(e => { console.error('[agent-tasks] sweep error:', e.message); return null; }) : null;
}

async function sweepForUser(db, userId) {
  const rows = await db.queryAll(
    "SELECT * FROM workflows WHERE user_id=$1 AND trigger_config->>'temporary' = 'true' LIMIT 100", [userId]).catch(() => []);
  let removed = 0;
  for (const row of rows) {
    try { if (await sweepRow(db, row)) removed++; } catch (e) { console.error('[agent-tasks] sweep error:', e.message); }
  }
  return removed;
}

async function sweepAll(db) {
  const rows = await db.queryAll(
    "SELECT * FROM workflows WHERE trigger_config->>'temporary' = 'true' ORDER BY updated_at ASC LIMIT 300").catch(() => []);
  let removed = 0;
  for (const row of rows) {
    try { if (await sweepRow(db, row)) removed++; } catch (e) { console.error('[agent-tasks] sweep error:', e.message); }
  }
  if (removed) console.log(`[agent-tasks] removed ${removed} finished temporary automation(s)`);
  return removed;
}

// Owner says "stop that campaign": cancel every active run, record it, delete it.
async function cancelTemporary(db, userId, workflowId) {
  const row = await db.queryOne('SELECT * FROM workflows WHERE id=$1 AND user_id=$2', [workflowId, userId]).catch(() => null);
  if (!row) return null;
  // Safety: this deletes the workflow, so it must never be used on a standing automation.
  if (parseCfg(row.trigger_config).temporary !== true) return { notTemporary: true };
  await db.query("UPDATE workflow_runs SET status='cancelled', updated_at=NOW() WHERE workflow_id=$1 AND status IN ('running','waiting')", [row.id]);
  return finishAndDelete(db, row, 'cancelled');
}

module.exports = {
  createTask, listTasks, getTask, markStarted, unnotifiedFinished, ackTasks,
  workflowStats, sweepRow, sweepWorkflow, sweepForUser, sweepAll, cancelTemporary, finishAndDelete,
  _internal: { parseCfg, STALE_UNLAUNCHED_MS, LAUNCH_STALL_MS },
};
