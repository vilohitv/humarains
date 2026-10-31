/**
 * routes/support.js: the Support page.
 *
 *   createSupportRouter(db)       /api/support        signed-in owners: write to the admin, read the replies
 *   createSupportAdminRouter(db)  /api/admin/support  the admin panel: inbox, reply, status, private note
 *
 * One ticket per conversation, with a list of messages. Status moves on its own:
 *   owner writes or replies  -> open       (the admin has something to answer)
 *   admin replies            -> answered   (waiting on the owner)
 *   either side closes it    -> resolved   (an owner reply reopens it)
 * Email is best-effort on both sides: a failed send never fails the request.
 */
'use strict';
const express = require('express');
const crypto = require('crypto');
const mailer = require('../services/mailer');
const templates = require('../lib/email-templates');

const CATEGORIES = ['question', 'problem', 'billing', 'feature', 'other'];
const STATUSES = ['open', 'answered', 'resolved'];
const LIMITS = { subject: 200, message: 4000, note: 2000, newPerHour: 5, repliesPerHour: 30 };

const str = v => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '');

/** Validate a new ticket. Returns { error } or { value }. */
function cleanNewTicket(body) {
  const b = body || {};
  const subject = str(b.subject).replace(/\s+/g, ' ');
  const message = str(b.message);
  const category = CATEGORIES.includes(b.category) ? b.category : 'other';
  if (!subject) return { error: 'Add a subject so we know what this is about.' };
  if (subject.length > LIMITS.subject) return { error: `Keep the subject under ${LIMITS.subject} characters.` };
  if (!message) return { error: 'Write your message.' };
  if (message.length > LIMITS.message) return { error: `Keep the message under ${LIMITS.message} characters.` };
  return { value: { subject, message, category } };
}

/** Validate a reply from either side. */
function cleanReply(body) {
  const message = str((body || {}).message);
  if (!message) return { error: 'Write your reply.' };
  if (message.length > LIMITS.message) return { error: `Keep the message under ${LIMITS.message} characters.` };
  return { value: { message } };
}

/** Status after the owner writes: always back in the admin's inbox. */
const statusAfterUserMessage = () => 'open';
/** Status after the admin replies: waiting on the owner, unless the admin chose another. */
const statusAfterAdminReply = requested => (STATUSES.includes(requested) ? requested : 'answered');

const newId = () => crypto.randomBytes(16).toString('hex');
const appUrl = () => process.env.APP_URL || process.env.ALLOWED_ORIGIN || 'https://humarains.com';

function ticketOut(t) {
  return {
    id: t.id, subject: t.subject, category: t.category, status: t.status, unread: !!t.user_unread,
    createdAt: t.created_at, lastMessageAt: t.last_message_at,
  };
}
const messageOut = m => ({ id: Number(m.id), from: m.sender, body: m.body, createdAt: m.created_at });

async function fire(label, fn) {
  try { await fn(); } catch (e) { console.warn(`[support] ${label} email not sent:`, e.message); }
}

// ── Owner side ─────────────────────────────────────────────────
function createSupportRouter(db) {
  const router = express.Router();

  router.get('/tickets', async (req, res) => {
    try {
      const rows = await db.queryAll(
        'SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT 100', [req.user.id]);
      res.json({ success: true, tickets: rows.map(ticketOut), unread: rows.filter(r => r.user_unread).length });
    } catch (e) {
      console.error('[support] list:', e.message);
      res.status(500).json({ success: false, message: 'Could not load your messages.' });
    }
  });

  // Just the count, for the badge in the sidebar
  router.get('/unread', async (req, res) => {
    try {
      const r = await db.queryOne('SELECT count(*)::int AS n FROM support_tickets WHERE user_id = $1 AND user_unread', [req.user.id]);
      res.json({ success: true, unread: (r && r.n) || 0 });
    } catch (e) { res.json({ success: true, unread: 0 }); }
  });

  router.get('/tickets/:id', async (req, res) => {
    try {
      const t = await db.queryOne('SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!t) return res.status(404).json({ success: false, message: 'Message not found.' });
      const msgs = await db.queryAll('SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY id', [t.id]);
      if (t.user_unread) await db.query('UPDATE support_tickets SET user_unread = false WHERE id = $1', [t.id]);
      res.json({ success: true, ticket: { ...ticketOut(t), unread: false }, messages: msgs.map(messageOut) });
    } catch (e) {
      console.error('[support] read:', e.message);
      res.status(500).json({ success: false, message: 'Could not load this conversation.' });
    }
  });

  router.post('/tickets', async (req, res) => {
    const c = cleanNewTicket(req.body);
    if (c.error) return res.status(400).json({ success: false, message: c.error });
    try {
      const recent = await db.queryOne(
        `SELECT count(*)::int AS n FROM support_tickets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [req.user.id]);
      if (recent && recent.n >= LIMITS.newPerHour) {
        return res.status(429).json({ success: false, message: 'You have sent several messages in the last hour. Reply in an existing conversation, or try again later.' });
      }
      const id = newId();
      await db.query(
        `INSERT INTO support_tickets (id, user_id, subject, category, status, admin_unread, user_unread)
         VALUES ($1, $2, $3, $4, 'open', true, false)`, [id, req.user.id, c.value.subject, c.value.category]);
      await db.query(`INSERT INTO support_messages (ticket_id, sender, body) VALUES ($1, 'user', $2)`, [id, c.value.message]);
      notifyAdmin(db, req.user.id, { subject: c.value.subject, message: c.value.message, isNew: true });
      res.json({ success: true, id });
    } catch (e) {
      console.error('[support] create:', e.message);
      res.status(500).json({ success: false, message: 'Could not send your message. Please try again.' });
    }
  });

  router.post('/tickets/:id/messages', async (req, res) => {
    const c = cleanReply(req.body);
    if (c.error) return res.status(400).json({ success: false, message: c.error });
    try {
      const t = await db.queryOne('SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!t) return res.status(404).json({ success: false, message: 'Message not found.' });
      const recent = await db.queryOne(
        `SELECT count(*)::int AS n FROM support_messages m JOIN support_tickets t ON t.id = m.ticket_id
          WHERE t.user_id = $1 AND m.sender = 'user' AND m.created_at > now() - interval '1 hour'`, [req.user.id]);
      if (recent && recent.n >= LIMITS.repliesPerHour) {
        return res.status(429).json({ success: false, message: 'You are sending messages very quickly. Please wait a little.' });
      }
      await db.query(`INSERT INTO support_messages (ticket_id, sender, body) VALUES ($1, 'user', $2)`, [t.id, c.value.message]);
      await db.query(
        `UPDATE support_tickets SET status = $2, admin_unread = true, last_message_at = now() WHERE id = $1`,
        [t.id, statusAfterUserMessage()]);
      notifyAdmin(db, req.user.id, { subject: t.subject, message: c.value.message, isNew: false });
      res.json({ success: true });
    } catch (e) {
      console.error('[support] reply:', e.message);
      res.status(500).json({ success: false, message: 'Could not send your reply. Please try again.' });
    }
  });

  // The owner closes it (or reopens it) without writing anything
  router.post('/tickets/:id/status', async (req, res) => {
    const status = req.body && req.body.status;
    if (status !== 'resolved' && status !== 'open') return res.status(400).json({ success: false, message: 'Invalid status.' });
    try {
      const r = await db.query(
        `UPDATE support_tickets SET status = $3, admin_unread = $4 WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id, status, status === 'open']);
      if (!r.rowCount) return res.status(404).json({ success: false, message: 'Message not found.' });
      res.json({ success: true, status });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Could not update this conversation.' });
    }
  });

  return router;
}

// A short email to the admin when an owner writes. Only if ADMIN_EMAIL is set.
function notifyAdmin(db, userId, { subject, message, isNew }) {
  const to = process.env.ADMIN_EMAIL;
  if (!to) return;
  fire('admin', async () => {
    const u = await db.queryOne('SELECT name, email FROM users WHERE id = $1', [userId]);
    const e = templates.supportAdminNotice({ from: (u && (u.name || u.email)) || 'A user', email: u && u.email, subject, message, isNew, appUrl: appUrl() });
    await mailer.sendMail({ to, subject: e.subject, html: e.html });
  });
}

// ── Admin side ─────────────────────────────────────────────────
function createSupportAdminRouter(db) {
  const router = express.Router();

  const userCols = `u.name AS user_name, u.email AS user_email, u.plan AS user_plan, u.company AS user_company`;

  router.get('/', async (req, res) => {
    try {
      const status = String(req.query.status || '');
      const vals = [];
      let where = '';
      if (status === 'needs_reply') where = `WHERE t.status = 'open'`;
      else if (STATUSES.includes(status)) { vals.push(status); where = 'WHERE t.status = $1'; }
      const rows = await db.queryAll(
        `SELECT t.*, ${userCols}, (SELECT count(*)::int FROM support_messages m WHERE m.ticket_id = t.id) AS message_count
           FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
           ${where}
          ORDER BY (t.status = 'open') DESC, t.last_message_at DESC LIMIT 300`, vals);
      const counts = await db.queryOne(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE admin_unread)::int AS unread FROM support_tickets`);
      res.json({ success: true, tickets: rows, open: (counts && counts.open) || 0, unread: (counts && counts.unread) || 0 });
    } catch (e) {
      console.error('[support-admin] list:', e.message);
      res.status(500).json({ success: false, message: 'Failed to load support messages.' });
    }
  });

  router.get('/counts', async (req, res) => {
    try {
      const c = await db.queryOne(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE admin_unread)::int AS unread FROM support_tickets`);
      res.json({ success: true, open: (c && c.open) || 0, unread: (c && c.unread) || 0 });
    } catch (e) { res.json({ success: true, open: 0, unread: 0 }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const t = await db.queryOne(
        `SELECT t.*, ${userCols} FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [req.params.id]);
      if (!t) return res.status(404).json({ success: false, message: 'Not found.' });
      const msgs = await db.queryAll('SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY id', [t.id]);
      if (t.admin_unread) await db.query('UPDATE support_tickets SET admin_unread = false WHERE id = $1', [t.id]);
      res.json({ success: true, ticket: { ...t, admin_unread: false }, messages: msgs.map(messageOut) });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to load this conversation.' });
    }
  });

  router.post('/:id/reply', async (req, res) => {
    const c = cleanReply(req.body);
    if (c.error) return res.status(400).json({ success: false, message: c.error });
    try {
      const t = await db.queryOne(
        `SELECT t.*, u.name AS user_name, u.email AS user_email FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [req.params.id]);
      if (!t) return res.status(404).json({ success: false, message: 'Not found.' });
      const status = statusAfterAdminReply(req.body && req.body.status);
      await db.query(`INSERT INTO support_messages (ticket_id, sender, body) VALUES ($1, 'admin', $2)`, [t.id, c.value.message]);
      await db.query(
        `UPDATE support_tickets SET status = $2, admin_unread = false, user_unread = true, last_message_at = now() WHERE id = $1`, [t.id, status]);
      let emailed = false;
      if (t.user_email) {
        try {
          const e = templates.supportReply({ name: t.user_name || 'there', subject: t.subject, message: c.value.message, appUrl: appUrl() });
          await mailer.sendMail({ to: t.user_email, subject: e.subject, html: e.html });
          emailed = true;
        } catch (err) { console.warn('[support] reply email not sent:', err.message); }
      }
      res.json({ success: true, status, emailed });
    } catch (e) {
      console.error('[support-admin] reply:', e.message);
      res.status(500).json({ success: false, message: 'Failed to send the reply.' });
    }
  });

  router.post('/:id', async (req, res) => {
    const { status, admin_note } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
    const sets = [], vals = [];
    if (status !== undefined)     { vals.push(status);                                  sets.push(`status = $${vals.length}`); }
    if (admin_note !== undefined) { vals.push(str(admin_note).slice(0, LIMITS.note));   sets.push(`admin_note = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update.' });
    try {
      vals.push(req.params.id);
      const r = await db.query(`UPDATE support_tickets SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      if (!r.rowCount) return res.status(404).json({ success: false, message: 'Not found.' });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to update.' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM support_tickets WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to delete.' });
    }
  });

  return router;
}

module.exports = {
  createSupportRouter, createSupportAdminRouter,
  _internal: { cleanNewTicket, cleanReply, statusAfterUserMessage, statusAfterAdminReply, CATEGORIES, STATUSES, LIMITS },
};
