/**
 * media-library.js — photos the owner uploads once and the platform reuses.
 *
 * Photos can be (1) attached to a marketing campaign, and (2) sent
 * automatically when a customer asks to see photos / examples / past work.
 *
 *   POST   /api/media            { fileName, mime?, dataBase64, caption?, tags? }
 *   GET    /api/media            → list (no bytes)
 *   GET    /api/media/:id/file   → the image (owner only, cookie auth)
 *   PATCH  /api/media/:id        { caption?, tags? }
 *   DELETE /api/media/:id
 *
 * Safety
 *  - Type is decided by the file's magic bytes, never by the name or the
 *    client-supplied mime. Only JPEG, PNG and WebP are accepted (no SVG: it
 *    can carry script).
 *  - Every query is scoped to the authenticated user id.
 *  - Files are served with nosniff and a download-safe content type.
 */
'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');

const MAX_BYTES        = 4 * 1024 * 1024;   // per image
const MAX_PER_USER     = 40;
const MAX_PER_MESSAGE  = 4;                 // photos attached to one message
const MAX_CAPTION      = 200;
const MAX_TAGS         = 200;

const mediaLimiter = rateLimit({
  windowMs: 60_000, max: 40,
  keyGenerator: req => (req.user ? String(req.user.id) : req.ip),
  message: { success: false, message: 'Too many uploads — try again in a minute.' },
});

// ── helpers ──────────────────────────────────────────────────────
function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function cleanText(s, n) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

function safeFileName(name, ext) {
  const base = cleanText(name, 80).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'photo';
  return `${base}.${ext}`;
}

function genMediaId() { return 'md_' + crypto.randomBytes(10).toString('hex'); }

function publicRow(r) {
  return {
    id: r.id, fileName: r.file_name, mime: r.mime, size: r.size_bytes,
    caption: r.caption || '', tags: r.tags || '', createdAt: r.created_at,
    url: `/api/media/${r.id}/file`,
  };
}

// ── storage ──────────────────────────────────────────────────────
async function saveImage(db, userId, { fileName, dataBase64, caption, tags }) {
  const b64 = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!b64) return { ok: false, status: 400, message: 'No image data received.' };
  // Reject oversize BEFORE decoding so a huge string cannot balloon memory.
  if (b64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) return { ok: false, status: 413, message: 'That photo is over 4 MB. Please use a smaller one.' };
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return { ok: false, status: 400, message: 'The image could not be read.' }; }
  if (buf.length > MAX_BYTES) return { ok: false, status: 413, message: 'That photo is over 4 MB. Please use a smaller one.' };
  const kind = detectImage(buf);
  if (!kind) return { ok: false, status: 415, message: 'Only JPEG, PNG or WebP photos are supported.' };

  const count = await db.queryOne('SELECT COUNT(*)::int AS n FROM agent_media WHERE user_id=$1', [userId]);
  if (count && count.n >= MAX_PER_USER) return { ok: false, status: 400, message: `Your photo library is full (${MAX_PER_USER}). Delete a few to add more.` };

  const id = genMediaId();
  const name = safeFileName(fileName, kind.ext);
  await db.query(
    `INSERT INTO agent_media (id, user_id, file_name, mime, size_bytes, caption, tags, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, userId, name, kind.mime, buf.length, cleanText(caption, MAX_CAPTION) || null, cleanText(tags, MAX_TAGS) || null, buf]
  );
  const row = await db.queryOne('SELECT id, file_name, mime, size_bytes, caption, tags, created_at FROM agent_media WHERE id=$1 AND user_id=$2', [id, userId]);
  return { ok: true, photo: publicRow(row) };
}

async function listPhotos(db, userId) {
  const rows = await db.queryAll(
    'SELECT id, file_name, mime, size_bytes, caption, tags, created_at FROM agent_media WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',
    [userId, MAX_PER_USER]).catch(() => []);
  return rows.map(publicRow);
}

async function updatePhoto(db, userId, id, { caption, tags }) {
  const sets = [], vals = [];
  if (caption !== undefined) { vals.push(cleanText(caption, MAX_CAPTION) || null); sets.push(`caption=$${vals.length}`); }
  if (tags !== undefined)    { vals.push(cleanText(tags, MAX_TAGS) || null);       sets.push(`tags=$${vals.length}`); }
  if (!sets.length) return null;
  vals.push(id, userId);
  const r = await db.query(`UPDATE agent_media SET ${sets.join(', ')} WHERE id=$${vals.length - 1} AND user_id=$${vals.length}`, vals);
  if (r && r.rowCount === 0) return null;
  const row = await db.queryOne('SELECT id, file_name, mime, size_bytes, caption, tags, created_at FROM agent_media WHERE id=$1 AND user_id=$2', [id, userId]);
  return row ? publicRow(row) : null;
}

async function deletePhoto(db, userId, id) {
  const r = await db.query('DELETE FROM agent_media WHERE id=$1 AND user_id=$2', [id, userId]);
  return !!(r && r.rowCount);
}

// Ids the user actually owns, in the order given, capped. Anything else is dropped.
async function ownedIds(db, userId, ids) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, MAX_PER_MESSAGE);
  if (!want.length) return [];
  const rows = await db.queryAll('SELECT id FROM agent_media WHERE user_id=$1 AND id = ANY($2::text[])', [userId, want]).catch(() => []);
  const have = new Set(rows.map(r => r.id));
  return want.filter(id => have.has(id));
}

// Full bytes for sending: [{ id, filename, mime, buffer, caption }]
async function loadForSend(db, userId, ids) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, MAX_PER_MESSAGE);
  if (!want.length || !db) return [];
  const rows = await db.queryAll(
    'SELECT id, file_name, mime, caption, data FROM agent_media WHERE user_id=$1 AND id = ANY($2::text[])', [userId, want]).catch(() => []);
  const byId = new Map(rows.map(r => [r.id, r]));
  return want.filter(id => byId.has(id)).map(id => {
    const r = byId.get(id);
    return { id, filename: r.file_name, mime: r.mime, buffer: r.data, caption: r.caption || '' };
  });
}

// Photos attached to an AI-drafted reply (aiReply.mediaIds), ready to send.
async function loadReplyPhotos(db, userId, aiReply) {
  const ids = aiReply && typeof aiReply === 'object' ? aiReply.mediaIds : null;
  if (!Array.isArray(ids) || !ids.length) return [];
  try { return await loadForSend(db, userId, ids); }
  catch (e) { console.error('[media] could not load reply photos:', e.message); return []; }
}

// Send an AI reply's photos over WhatsApp right after its text. Never throws:
// the text has already gone out, a photo failure must not undo or retry it.
async function sendReplyPhotosWhatsApp(db, userId, aiReply, to, creds) {
  try {
    const photos = await loadReplyPhotos(db, userId, aiReply);
    if (!photos.length) return 0;
    const { sendWhatsAppImages } = require('./whatsapp');
    return await sendWhatsAppImages({ to, media: photos, phoneNumberId: creds.phoneNumberId, accessToken: creds.accessToken });
  } catch (e) { console.error('[media] WhatsApp photo send failed:', e.message); return 0; }
}

// Compact library listing for prompts / businessContext (no bytes).
async function libraryForContext(db, userId) {
  if (!db || !db.queryAll) return [];
  const rows = await db.queryAll(
    'SELECT id, caption, tags, file_name FROM agent_media WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, MAX_PER_USER]).catch(() => []);
  return rows.map(r => ({ id: r.id, caption: r.caption || '', tags: r.tags || '', name: r.file_name }));
}

// ── choosing photos for a customer request ───────────────────────
const STOP = new Set(['the','a','an','of','for','and','or','to','in','on','with','your','you','my','me','some','any','photos','photo','pictures','picture','pics','pic','images','image','examples','example','work','past','previous','recent','send','show','see','can','could','please','do','have','what','look','like']);
function words(s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)); }

/**
 * Pick up to `max` photos for a customer's request. If they named a topic
 * ("bathroom remodels"), photos whose caption/tags/name overlap it come first.
 * If nothing matches (or the request was generic: "send photos of your work")
 * fall back to the newest photos, because that is what they asked to see.
 */
function pickForRequest(library, topic, max) {
  const lib = Array.isArray(library) ? library : [];
  if (!lib.length) return [];
  const n = Math.max(1, Math.min(MAX_PER_MESSAGE, max || 3));
  const tw = words(topic);
  if (tw.length) {
    const scored = lib.map((p, i) => {
      const hay = new Set(words(`${p.caption} ${p.tags} ${p.name}`));
      const score = tw.reduce((s, w) => s + (hay.has(w) ? 1 : 0), 0);
      return { p, score, i };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
    if (scored.length) return scored.slice(0, n).map(x => x.p.id);
  }
  return lib.slice(0, n).map(p => p.id);
}

// ── router ───────────────────────────────────────────────────────
function createMediaRouter(db) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    res.json({ success: true, photos: await listPhotos(db, req.user.id), max: MAX_PER_USER });
  });

  router.post('/', mediaLimiter, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await saveImage(db, req.user.id, b);
      if (!r.ok) return res.status(r.status || 400).json({ success: false, message: r.message });
      res.status(201).json({ success: true, photo: r.photo });
    } catch (e) {
      console.error('[media] upload error:', e.message);
      res.status(500).json({ success: false, message: 'Could not save that photo.' });
    }
  });

  router.get('/:id/file', async (req, res) => {
    try {
      const row = await db.queryOne('SELECT mime, data, file_name FROM agent_media WHERE id=$1 AND user_id=$2', [String(req.params.id), req.user.id]);
      if (!row) return res.status(404).end();
      res.set({
        'Content-Type': row.mime,
        'Content-Disposition': `inline; filename="${String(row.file_name).replace(/"/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      res.send(row.data);
    } catch (e) { res.status(500).end(); }
  });

  router.patch('/:id', mediaLimiter, async (req, res) => {
    try {
      const photo = await updatePhoto(db, req.user.id, String(req.params.id), req.body || {});
      if (!photo) return res.status(404).json({ success: false, message: 'Photo not found.' });
      res.json({ success: true, photo });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not update that photo.' }); }
  });

  router.delete('/:id', mediaLimiter, async (req, res) => {
    try {
      const ok = await deletePhoto(db, req.user.id, String(req.params.id));
      if (!ok) return res.status(404).json({ success: false, message: 'Photo not found.' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not delete that photo.' }); }
  });

  return router;
}

module.exports = {
  createMediaRouter,
  saveImage, listPhotos, updatePhoto, deletePhoto, ownedIds, loadForSend, libraryForContext,
  loadReplyPhotos, sendReplyPhotosWhatsApp,
  pickForRequest, detectImage,
  MAX_BYTES, MAX_PER_USER, MAX_PER_MESSAGE,
};
