/**
 * routes/knowledge.js — Company Knowledge AI API
 *
 * Mounts at /api/knowledge (server.js already runs requireAuth +
 * attachLeadsUser before this router, same pattern as /api/workflows).
 *
 * Businesses add documents in six categories — pricing, FAQs, product info,
 * service info, competitor info, and internal processes. routes/leads.js's
 * getSettings() compiles every entry into businessContext.knowledgeBase,
 * which services/leads/engine.js and services/workflows/engine.js inject into the AI's reply
 * prompts so it answers using the business's own material instead of
 * guessing.
 *
 * There's no file-parsing pipeline (no S3/blob storage exists anywhere in
 * this codebase — everything persists to Postgres) — "upload" means typing
 * or pasting content directly into the Company Knowledge modal.
 *
 *  GET    /api/knowledge          — list all entries for the user
 *  POST   /api/knowledge          — create an entry
 *  PUT    /api/knowledge/:id      — update an entry
 *  DELETE /api/knowledge/:id      — delete an entry
 */
'use strict';

const express      = require('express');
const crypto       = require('crypto');

const router = express.Router();

const CATEGORIES = ['pricing', 'faq', 'product', 'service', 'competitor', 'process'];
const MAX_ENTRIES = 200;          // per account — keeps compileKnowledge() bounded
const MAX_CONTENT_LENGTH = 20000; // characters per entry
const MAX_TITLE_LENGTH = 200;

function generateId() { return 'kb_' + crypto.randomBytes(12).toString('hex'); }

function sanitize(row) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    fileName: row.file_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── GET /api/knowledge — list, grouped is left to the client ───────────────
router.get('/', async (req, res) => {
  try {
    const rows = await req._db.BusinessKnowledge.listByUser(req.user.id);
    res.json({ success: true, entries: rows.map(sanitize), categories: CATEGORIES });
  } catch (e) {
    console.error('[knowledge] list error:', e.message);
    res.status(500).json({ success: false, message: 'Could not load knowledge base.' });
  }
});

// ── POST /api/knowledge — create ────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { category, title, content, fileName } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ success: false, message: 'Title is required.' });
  if (!content || !String(content).trim()) return res.status(400).json({ success: false, message: 'Content is required.' });
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ success: false, message: `Category must be one of: ${CATEGORIES.join(', ')}.` });
  }
  if (String(title).length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ success: false, message: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` });
  }
  if (String(content).length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({ success: false, message: `Content must be ${MAX_CONTENT_LENGTH.toLocaleString()} characters or fewer — split large documents into a few shorter entries.` });
  }
  try {
    const existing = await req._db.BusinessKnowledge.countByUser(req.user.id);
    if (existing >= MAX_ENTRIES) {
      return res.status(403).json({ success: false, message: `You've reached the ${MAX_ENTRIES}-document limit. Delete an old entry to add a new one.` });
    }
    const entry = await req._db.BusinessKnowledge.create({
      id: generateId(), userId: req.user.id, category,
      title: String(title).trim(), content: String(content).trim(),
      fileName: fileName ? String(fileName).slice(0, 200) : null,
    });
    res.status(201).json({ success: true, entry: sanitize(entry) });
  } catch (e) {
    console.error('[knowledge] create error:', e.message);
    res.status(500).json({ success: false, message: 'Could not save document.' });
  }
});

// ── PUT /api/knowledge/:id — update ─────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { category, title, content, fileName } = req.body || {};
  if (category !== undefined && !CATEGORIES.includes(category)) {
    return res.status(400).json({ success: false, message: `Category must be one of: ${CATEGORIES.join(', ')}.` });
  }
  if (title !== undefined && !String(title).trim()) return res.status(400).json({ success: false, message: 'Title is required.' });
  if (content !== undefined && !String(content).trim()) return res.status(400).json({ success: false, message: 'Content is required.' });
  if (title !== undefined && String(title).length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ success: false, message: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` });
  }
  if (content !== undefined && String(content).length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({ success: false, message: `Content must be ${MAX_CONTENT_LENGTH.toLocaleString()} characters or fewer.` });
  }
  try {
    const existing = await req._db.BusinessKnowledge.findById(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Document not found.' });
    const entry = await req._db.BusinessKnowledge.update(req.params.id, req.user.id, {
      category, title: title !== undefined ? String(title).trim() : undefined,
      content: content !== undefined ? String(content).trim() : undefined,
      file_name: fileName !== undefined ? String(fileName).slice(0, 200) : undefined,
    });
    res.json({ success: true, entry: sanitize(entry) });
  } catch (e) {
    console.error('[knowledge] update error:', e.message);
    res.status(500).json({ success: false, message: 'Could not update document.' });
  }
});

// ── DELETE /api/knowledge/:id ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const existing = await req._db.BusinessKnowledge.findById(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Document not found.' });
    await req._db.BusinessKnowledge.delete(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[knowledge] delete error:', e.message);
    res.status(500).json({ success: false, message: 'Could not delete document.' });
  }
});

// ── Factory: create router with db injected (mirrors routes/workflows.js) ───
function createKnowledgeRouter(db) {
  const r = express.Router();
  r.use((req, res, next) => { req._db = db; next(); });
  r.use('/', router);
  return r;
}

module.exports = { createKnowledgeRouter, CATEGORIES };
