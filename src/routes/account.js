// ── Account management routes (/api/account) ─────────────────────────────
// Handles: change password, update profile name, request email change,
// confirm email change (token-based), and delete account.
// All routes require authentication — the router is mounted behind requireAuth.

'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { body, validationResult } = require('express-validator');

const BCRYPT_ROUNDS = 12;

// Helper: extract CSRF-safe token from cookie (same pattern as server.js)
function getCsrf(req) {
  try {
    const m = req.cookies && req.cookies.bp_csrf;
    return m ? decodeURIComponent(m) : '';
  } catch (_) { return ''; }
}

module.exports = function createAccountRouter(db, requireAuth, strictLimiter, verifyCsrfToken, auditLog) {
  const router = express.Router();
  router.use(requireAuth);

  // ── GET /api/account/me  (thin wrapper — full /api/users/me already exists) ──
  router.get('/me', async (req, res) => {
    try {
      const user = await db.Users.findById(req.user.id);
      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
      res.json({
        success: true,
        user: {
          id:         user.id,
          name:       user.name,
          email:      user.email,
          plan:       user.plan || 'free',
          created_at: user.created_at,
          has_password: !!user.password_hash,
          google_linked: !!user.google_id,
          avatar_url: user.avatar_url || null,
        },
      });
    } catch (e) {
      console.error('[account/me]', e.message);
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  // ── PUT /api/account/name ─────────────────────────────────────────────────
  router.put('/name',
    verifyCsrfToken,
    body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name must be 1–100 characters.'),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
      try {
        await db.Users.update(req.user.id, { name: req.body.name.trim() });
        if (typeof auditLog === 'function') auditLog(req.user.id, 'account.name_changed', req);
        res.json({ success: true, message: 'Name updated.' });
      } catch (e) {
        console.error('[account/name]', e.message);
        res.status(500).json({ success: false, message: 'Failed to update name.' });
      }
    }
  );

  // ── PUT /api/account/password ─────────────────────────────────────────────
  router.put('/password',
    strictLimiter,
    verifyCsrfToken,
    body('currentPassword').isLength({ min: 1, max: 128 }),
    body('newPassword')
      .isLength({ min: 10, max: 128 })
      .matches(/[A-Z]/)
      .matches(/[a-z]/)
      .matches(/[0-9]/)
      .withMessage('Password must be at least 10 characters and include uppercase, lowercase, and a number.'),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
      try {
        const user = await db.Users.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        if (!user.password_hash) {
          return res.status(400).json({ success: false, message: 'Your account uses Google sign-in. Set a password via "Forgot password" if you want one.' });
        }

        const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
        if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });

        const sameAsOld = await bcrypt.compare(req.body.newPassword, user.password_hash);
        if (sameAsOld) return res.status(400).json({ success: false, message: 'New password must be different from your current password.' });

        const newHash = await bcrypt.hash(req.body.newPassword, BCRYPT_ROUNDS);
        await db.Users.updatePassword(req.user.id, newHash);
        if (typeof auditLog === 'function') auditLog(req.user.id, 'account.password_changed', req);
        res.json({ success: true, message: 'Password changed successfully.' });
      } catch (e) {
        console.error('[account/password]', e.message);
        res.status(500).json({ success: false, message: 'Failed to change password.' });
      }
    }
  );

  // ── POST /api/account/request-email-change ────────────────────────────────
  // Sends a confirmation link to the *new* email address. The change is not
  // applied until the user clicks the link (confirm-email-change below).
  router.post('/request-email-change',
    strictLimiter,
    verifyCsrfToken,
    body('newEmail').isEmail().normalizeEmail().withMessage('Please enter a valid email address.'),
    body('currentPassword').isLength({ min: 1, max: 128 }),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
      try {
        const user = await db.Users.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        // Verify password (skip for Google-only accounts)
        if (user.password_hash) {
          const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
          if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
        }

        const newEmail = req.body.newEmail;
        if (newEmail === user.email) {
          return res.status(400).json({ success: false, message: 'That is already your current email address.' });
        }

        // Check if new email is already taken
        const existing = await db.Users.findByEmail(newEmail).catch(() => null);
        if (existing) return res.status(409).json({ success: false, message: 'That email address is already in use.' });

        // Store pending change in integrations (same pattern as password_reset)
        const token      = crypto.randomBytes(32).toString('hex');
        const expiresAt  = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h
        const intg       = typeof user.integrations === 'string'
          ? JSON.parse(user.integrations || '{}')
          : (user.integrations || {});
        intg.pending_email_change = {
          newEmail,
          tokenHash:  crypto.createHash('sha256').update(token).digest('hex'),
          expiresAt:  expiresAt.toISOString(),
        };
        await db.Users.update(req.user.id, { integrations: intg });

        // Send confirmation email
        try {
          const baseUrl = process.env.APP_URL || 'https://app.humarains.com';
          const confirmUrl = `${baseUrl}/confirm-email-change?token=${token}&uid=${req.user.id}`;
          // Use the mailer if available — graceful fallback so it never crashes
          const mailer = require('../services/mailer');
          await mailer.send({
            to:      newEmail,
            subject: 'Confirm your new email address — Humarains',
            html:    `<p>Hi ${user.name || 'there'},</p>
                      <p>Click the button below to confirm <strong>${newEmail}</strong> as your new login email. This link expires in 24 hours.</p>
                      <p><a href="${confirmUrl}" style="display:inline-block;padding:10px 20px;background:#0B252A;color:#fff;border-radius:6px;text-decoration:none">Confirm new email</a></p>
                      <p style="color:#888;font-size:12px">If you did not request this change, you can safely ignore this email.</p>`,
          });
        } catch (mailErr) {
          console.error('[account/request-email-change] mail error:', mailErr.message);
          // Don't fail the request — log and continue
        }

        if (typeof auditLog === 'function') auditLog(req.user.id, 'account.email_change_requested', req);
        res.json({ success: true, message: `A confirmation link has been sent to ${newEmail}. Check your inbox.` });
      } catch (e) {
        console.error('[account/request-email-change]', e.message);
        res.status(500).json({ success: false, message: 'Failed to initiate email change.' });
      }
    }
  );

  // ── GET /api/account/confirm-email-change  (token link from email) ────────
  router.get('/confirm-email-change', async (req, res) => {
    const { token, uid } = req.query;
    if (!token || !uid) return res.status(400).send('Invalid link.');
    try {
      const user = await db.Users.findById(uid);
      if (!user) return res.status(404).send('User not found.');

      const intg = typeof user.integrations === 'string'
        ? JSON.parse(user.integrations || '{}')
        : (user.integrations || {});
      const pending = intg.pending_email_change;

      if (!pending) return res.status(400).send('No pending email change for this account.');
      if (new Date() > new Date(pending.expiresAt)) return res.status(400).send('This confirmation link has expired. Please request a new one.');

      const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(pending.tokenHash))) {
        return res.status(400).send('Invalid confirmation token.');
      }

      // Check email still free
      const existing = await db.Users.findByEmail(pending.newEmail).catch(() => null);
      if (existing && existing.id !== uid) {
        return res.status(409).send('That email address has been taken by another account.');
      }

      await db.Users.update(uid, { email: pending.newEmail });
      delete intg.pending_email_change;
      await db.Users.update(uid, { integrations: intg });

      if (typeof auditLog === 'function') auditLog(uid, 'account.email_changed', req);

      // Redirect to dashboard with success param
      res.redirect('/?email_changed=1');
    } catch (e) {
      console.error('[account/confirm-email-change]', e.message);
      res.status(500).send('Server error confirming email change.');
    }
  });

  // ── DELETE /api/account  (permanent account deletion) ────────────────────
  router.delete('/',
    strictLimiter,
    verifyCsrfToken,
    body('confirmText').equals('DELETE').withMessage('Type DELETE to confirm.'),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
      try {
        const user = await db.Users.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        // Verify password (skip for Google-only accounts)
        if (user.password_hash && req.body.currentPassword) {
          const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
          if (!valid) return res.status(401).json({ success: false, message: 'Password is incorrect.' });
        }

        // Cancel Stripe subscription before deleting user
        try {
          const Stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
          const intg = typeof user.integrations === 'string'
            ? JSON.parse(user.integrations || '{}')
            : (user.integrations || {});
          if (Stripe && intg.stripe_subscription_id) {
            await Stripe.subscriptions.cancel(intg.stripe_subscription_id).catch(() => {});
          } else if (Stripe && user.stripe_customer_id) {
            const subs = await Stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'active', limit: 5 }).catch(() => ({ data: [] }));
            for (const sub of subs.data) {
              await Stripe.subscriptions.cancel(sub.id).catch(() => {});
            }
          }
        } catch (stripeErr) {
          console.error('[account/delete] Stripe cleanup error:', stripeErr.message);
        }

        if (typeof auditLog === 'function') auditLog(req.user.id, 'account.deleted', req);

        await db.Users.delete(req.user.id);

        // Clear session / JWT cookie
        res.clearCookie('bp_token');
        res.clearCookie('bp_csrf');
        res.json({ success: true, message: 'Your account has been permanently deleted.' });
      } catch (e) {
        console.error('[account/delete]', e.message);
        res.status(500).json({ success: false, message: 'Failed to delete account. Please contact support.' });
      }
    }
  );

  return router;
};
