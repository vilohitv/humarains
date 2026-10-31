/**
 * humarains — Shared Mailer
 *
 * Priority order:
 * 1. Resend API  (set RESEND_API_KEY) — recommended, reliable free tier
 * 2. SMTP        (set SMTP_HOST + SMTP_USER + SMTP_PASS)
 * 3. No-op       (logs to console only)
 *
 * Resend setup: https://resend.com → API Keys → Create key
 * Set RESEND_API_KEY and RESEND_FROM (e.g. "humarains <hello@yourdomain.com>")
 */
'use strict';

const FROM_DEFAULT = process.env.RESEND_FROM ||
                     process.env.SMTP_FROM    ||
                     '"humarains" <hello@humarains.com>';

// ── Resend (HTTP API) ──────────────────────────────────────────
async function sendViaResend({ to, subject, html, from = FROM_DEFAULT }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null; // not configured

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Resend API error ' + res.status + ': ' + (err.message || JSON.stringify(err)));
  }

  const data = await res.json();
  return data.id || 'ok';
}

// ── SMTP (nodemailer) ──────────────────────────────────────────
let _smtpTransport = null;

function getSmtpTransport() {
  if (_smtpTransport) return _smtpTransport;
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  const nodemailer = require('nodemailer');
  _smtpTransport = nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     15_000,
    pool: true, maxConnections: 3, maxMessages: 100,
  });
  return _smtpTransport;
}

async function sendViaSmtp({ to, subject, html, from = FROM_DEFAULT }) {
  const t = getSmtpTransport();
  if (!t) return null; // not configured
  const info = await t.sendMail({ from, to, subject, html });
  return info.messageId || 'ok';
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Send an email. Returns true on success, false if no provider configured.
 * Never throws — all errors are caught and logged.
 */
async function sendMail({ to, subject, html, from = FROM_DEFAULT }) {
  // Try Resend first
  if (process.env.RESEND_API_KEY) {
    try {
      const id = await sendViaResend({ to, subject, html, from });
      if (id !== null) {
        console.log('[Mailer/Resend] Sent "' + subject + '" to ' + to + ' (' + id + ')');
        return true;
      }
    } catch (err) {
      console.error('[Mailer/Resend] Failed "' + subject + '" to ' + to + ':', err.message);
      // Fall through to SMTP
    }
  }

  // Try SMTP
  if (process.env.SMTP_HOST) {
    try {
      const id = await sendViaSmtp({ to, subject, html, from });
      if (id !== null) {
        console.log('[Mailer/SMTP] Sent "' + subject + '" to ' + to + ' (' + id + ')');
        return true;
      }
    } catch (err) {
      console.error('[Mailer/SMTP] Failed "' + subject + '" to ' + to + ':', err.message);
    }
  }

  // No provider configured
  console.log('[Mailer] No provider configured — skipping "' + subject + '" to ' + to);
  console.log('[Mailer] Set RESEND_API_KEY (recommended) or SMTP_HOST to enable emails.');
  return false;
}

/**
 * Verify the configured email provider on server startup.
 */
async function verifyConnection() {
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/domains', {
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
      });
      if (res.ok) {
        console.log('[Mailer] Resend API key verified \u2713');
        return true;
      }
      const err = await res.json().catch(() => ({}));
      throw new Error('Status ' + res.status + ':' + (err.message || 'unknown'));
    } catch(err) {
      console.error('[Mailer] Resend API key INVALID:', err.message);
      console.error('[Mailer] Check RESEND_API_KEY at https://resend.com/api-keys');
    }
  }

  if (process.env.SMTP_HOST) {
    const t = getSmtpTransport();
    if (t) {
      try {
        await t.verify();
        console.log('[Mailer] SMTP connection verified \u2713', process.env.SMTP_HOST);
        return true;
      } catch(err) {
        console.error('[Mailer] SMTP connection FAILED:', err.message);
        console.error('[Mailer] Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE');
      }
    }
  }

  if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) {
    console.log('[Mailer] No email provider configured.');
    console.log('[Mailer] \u2192 Easiest: set RESEND_API_KEY (free at resend.com)');
    console.log('[Mailer] \u2192 Or set SMTP_HOST + SMTP_USER + SMTP_PASS for your SMTP provider');
  }

  return false;
}

module.exports = { sendMail, verifyConnection };
