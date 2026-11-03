/**
 * routes/telegram.js — /api/telegram/*: connect the owner's Telegram to the Agent (the dashboard card on Channels > Telegram).
 *
 *   GET    /status       { configured, connected, name, username, notify, blocked, botUsername, linkPending }
 *   POST   /link         start connecting: { url, expiresAt }. The owner opens the url in Telegram and taps Start.
 *   POST   /notify       { level: "all" | "important" | "off" }  how much the Agent reports
 *   POST   /test         send a test message to the connected chat
 *   POST   /disconnect   unlink the chat (it is told, and gets no more updates)
 *
 * Everything runs as the logged-in owner (server.js: requireAuth + attachLeadsUser, CSRF on every write). The bot itself
 * lives in services/telegram.js.
 */
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const telegram = require('../services/telegram');

const limiter = rateLimit({
  windowMs: 60_000, max: 30,
  keyGenerator: req => (req.user ? String(req.user.id) : req.ip),
  message: { success: false, message: 'Too many requests. Please try again in a moment.' },
});

function createTelegramRouter(db) {
  const router = express.Router();
  router.use(limiter);
  const user = req => req.dbUser || { id: req.user.id };

  router.get('/status', async (req, res) => {
    try { res.json({ success: true, ...(await telegram.status(db, user(req))) }); }
    catch (e) { console.error('[telegram] status error:', e.message); res.status(500).json({ success: false, message: 'Could not load the Telegram connection.' }); }
  });

  router.post('/link', async (req, res) => {
    if (!telegram.enabled()) return res.status(503).json({ success: false, message: 'Telegram is not available yet. Please try again later.' });
    try { res.json({ success: true, ...(await telegram.createLink(db, req.user.id)) }); }
    catch (e) { console.error('[telegram] link error:', e.message); res.status(500).json({ success: false, message: 'Could not start the Telegram connection. Please try again.' }); }
  });

  router.post('/notify', async (req, res) => {
    try { res.json({ success: true, notify: await telegram.setNotify(db, req.user.id, String((req.body && req.body.level) || '')) }); }
    catch (e) { res.status(400).json({ success: false, message: e.message }); }
  });

  router.post('/test', async (req, res) => {
    try { await telegram.sendTest(db, user(req)); res.json({ success: true }); }
    catch (e) {
      const blocked = e.code === 403;
      res.status(blocked ? 409 : 400).json({ success: false, message: blocked
        ? 'Telegram would not deliver it. Open the chat with the Humarains bot and press Start, or disconnect and connect again.'
        : (e.message || 'Could not send the test message.') });
    }
  });

  router.post('/disconnect', async (req, res) => {
    try { await telegram.unlink(db, req.user.id); res.json({ success: true }); }
    catch (e) { console.error('[telegram] disconnect error:', e.message); res.status(500).json({ success: false, message: 'Could not disconnect Telegram.' }); }
  });

  return router;
}

module.exports = { createTelegramRouter };
