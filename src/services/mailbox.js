/**
 * services/mailbox.js
 *
 * Handles outreach email sending and the stored email-account config.
 *
 * Email is connected via one combined account (same email + password used
 * for both directions):
 *   - SMTP — sending outreach / reply emails
 *   - IMAP — reading the inbox so inbound replies can be ingested
 *
 * Credentials are stored encrypted in the users.integrations JSON column.
 * The encryption key is derived from JWT_SECRET so no extra env var needed.
 */
'use strict';

const crypto     = require('crypto');
const nodemailer = require('nodemailer');

// ── Encryption for stored credentials ─────────────────────────
// Uses AES-256-GCM so stored SMTP/IMAP passwords are not plaintext in DB
const ALGO = 'aes-256-gcm';

function getEncKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[pipeline-email] JWT_SECRET is required in production to encrypt email credentials.');
    }
    console.warn('[pipeline-email] JWT_SECRET not set — using insecure dev key. Do not store real credentials in this mode.');
  }
  const _secret = secret || 'fallback-dev-key-change-in-production';
  return crypto.createHash('sha256').update(_secret).digest(); // 32 bytes
}

function encrypt(text) {
  const iv  = crypto.randomBytes(12);
  const key = getEncKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(payload) {
  try {
    const [ivHex, tagHex, encHex] = payload.split(':');
    const key = getEncKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch (_) {
    return null;
  }
}

// ── SMTP Transport factory ────────────────────────────────────
function createSmtpTransport(config) {
  return nodemailer.createTransport({
    host:   config.smtpHost,
    port:   parseInt(config.smtpPort || '587'),
    secure: String(config.smtpPort) === '465' || config.secure === true,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15_000,
    greetingTimeout:   10_000,
    socketTimeout:     20_000,
    tls: { rejectUnauthorized: false }, // tolerate self-signed certs on private mail servers
  });
}

// ── Verify SMTP config (used by the "Send test email" / save flow) ─
async function verifySmtp(config) {
  const transport = createSmtpTransport(config);
  try {
    await transport.verify();
  } catch (err) {
    try { transport.close(); } catch (_) {}
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('authentication') || msg.includes('credentials') ||
        msg.includes('invalid') || msg.includes('535') || msg.includes('534') ||
        msg.includes('username') || msg.includes('password')) {
      throw new Error(
        'SMTP login rejected. If you use Gmail or Outlook, use an App Password — ' +
        'your regular password will not work.'
      );
    }
    if (msg.includes('econnrefused') || msg.includes('connect')) {
      throw new Error(`Cannot reach ${config.smtpHost}:${config.smtpPort || 587}. Check the SMTP host and port.`);
    }
    if (msg.includes('timeout')) {
      throw new Error(`SMTP connection to ${config.smtpHost} timed out.`);
    }
    throw new Error(err.message || 'SMTP connection failed.');
  }
  transport.close();
}

// ── Verify IMAP config (used by the "Connect" flow) ────────────
async function verifyImap(config) {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host:   config.imapHost,
    port:   parseInt(config.imapPort || '993'),
    secure: String(config.imapPort) !== '143',
    auth:   { user: config.user, pass: config.pass },
    logger: false,
    tls:    { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout:   8000,
    socketTimeout:     10000,
  });
  try {
    await client.connect();
    await client.logout();
  } catch (err) {
    // Always attempt a clean disconnect so the socket doesn't hang
    try { client.close(); } catch (_) {}

    const msg = (err.message || '').toLowerCase();

    // Gmail/Outlook IMAP disabled at account or org level —
    // server sends a WEBALERT or web browser redirect, not an auth error.
    // Must be checked BEFORE the auth block since these responses also
    // contain the word "login".
    if (msg.includes('webalert') || msg.includes('web browser') ||
        msg.includes('please log in via') || msg.includes('imap access is disabled')) {
      throw new Error(
        'IMAP access is disabled for this account. ' +
        'For Gmail: go to Gmail → Settings (gear icon) → See all settings → ' +
        'Forwarding and POP/IMAP tab → enable IMAP Access, then save.'
      );
    }

    // Explicit auth failure keywords — intentionally narrow to avoid
    // misclassifying network errors as credential problems.
    if (msg.includes('authentication') || msg.includes('authenticationfailed') ||
        msg.includes('credentials') || msg.includes('invalid') ||
        msg.includes('login failed') || msg.includes('login rejected') ||
        msg.includes('535') || msg.includes('534') ||
        msg.includes('username') || msg.includes('password')) {
      throw new Error(
        'Login rejected by the mail server. ' +
        'If you use Gmail or Outlook, you must use an App Password — ' +
        'your regular password will not work. ' +
        'For Gmail: Google Account → Security → 2-Step Verification → App Passwords.'
      );
    }

    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('connect')) {
      throw new Error(`Cannot reach ${config.imapHost}:${config.imapPort || 993}. Check the IMAP host and port.`);
    }
    if (msg.includes('timeout')) {
      throw new Error(`Connection to ${config.imapHost} timed out. Check the host and that port ${config.imapPort || 993} is not blocked.`);
    }
    throw new Error(err.message || 'IMAP connection failed.');
  }
}

// ── Get user's email config from their integrations ───────────
function getEmailConfig(user) {
  let intg = {};
  const raw = user.integrations;
  if (raw) {
    if (typeof raw === 'object') {
      intg = raw;
    } else {
      try {
        const parsed = JSON.parse(raw);
        // Handle double-stringified data from previous bug
        intg = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      } catch (_) {}
    }
  }

  // The poller also accepts the legacy `lead_email` key; reading it here too means a mailbox that is
  // polled can always be replied from (before, such accounts received mail but every send failed).
  const emailConfig = intg.pipeline_email || intg.lead_email || null;
  if (!emailConfig) return null;

  // Single combined account type: same credentials power both IMAP (read)
  // and SMTP (send).
  if (emailConfig.type === 'email') {
    return {
      type:      'email',
      user:      emailConfig.user,
      pass:      emailConfig.enc_pass ? decrypt(emailConfig.enc_pass) : null,
      imapHost:  emailConfig.imapHost,
      imapPort:  emailConfig.imapPort || '993',
      smtpHost:  emailConfig.smtpHost,
      smtpPort:  emailConfig.smtpPort || '587',
      fromName:  emailConfig.fromName || emailConfig.user,
      fromEmail: emailConfig.user,
    };
  }

  return null;
}

// ── Send a pipeline outreach email ────────────────────────────
async function sendPipelineEmail({ user, to, subject, body, fromName }) {
  const config = getEmailConfig(user);
  if (!config) throw new Error('No email account connected. Please connect your email in Pipeline → Settings.');

  const from = `"${fromName || config.fromName}" <${config.fromEmail}>`;

  // ── HTML email template ────────────────────────────────────────
  // Converts the AI's plain-text reply into a clean, professional email.
  // Paragraphs are separated by blank lines in the AI output.
  const escapeHtml = s => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const paragraphs = body
    .split(/\n{2,}/)               // split on blank lines → paragraphs
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      // Single newlines within a paragraph become <br>
      const inner = p.split('\n').map(escapeHtml).join('<br>');
      return `<p style="margin:0 0 18px;font-family:'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7">${inner}</p>`;
    })
    .join('\n');

  const senderDisplay = escapeHtml(fromName || config.fromName || '');
  const senderEmail   = escapeHtml(config.fromEmail || '');

  // Plain, personal layout: no gray page, card, shadow, header bar or divider lines.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0;padding:0">
  <div style="max-width:600px;margin:0;padding:0">
    ${paragraphs}
    <p style="margin:28px 0 0;font-family:'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;opacity:.6;line-height:1.6">
      Sent by ${senderDisplay}${senderEmail ? ` &lt;${senderEmail}&gt;` : ''} &middot; Powered by <a href="https://humarains.com" style="color:inherit;text-decoration:none">Humarains</a>
    </p>
  </div>
</body>
</html>`;

  if (config.type !== 'email') {
    throw new Error('Unknown email provider type: ' + config.type);
  }

  const transport = createSmtpTransport(config);
  try {
    const info = await transport.sendMail({ from, to, subject, text: body, html });
    console.log(`[PipelineEmail] Sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } finally {
    if (transport.close) transport.close();
  }
}

// ── Save combined IMAP+SMTP config to user's integrations ─────
function buildEmailIntegration({ user, pass, imapHost, imapPort, smtpHost, smtpPort, fromName }) {
  return {
    type: 'email',
    user,
    fromName: fromName || user,
    enc_pass: encrypt(pass),
    imapHost, imapPort: String(imapPort || '993'),
    smtpHost, smtpPort: String(smtpPort || '587'),
    connectedAt: new Date().toISOString(),
  };
}

// ── Check if user has email configured ────────────────────────
function hasEmailConfig(user) {
  return !!getEmailConfig(user);
}

// ── Get safe display info (no credentials) ────────────────────
function getEmailConfigSafe(user) {
  const config = getEmailConfig(user);
  if (!config) return null;
  return {
    type: 'email',
    user: config.user,
    fromName: config.fromName,
    imapHost: config.imapHost,
    smtpHost: config.smtpHost,
  };
}

module.exports = {
  sendPipelineEmail,
  verifySmtp,
  verifyImap,
  buildEmailIntegration,
  hasEmailConfig,
  getEmailConfig,
  getEmailConfigSafe,
  encrypt,
  decrypt,
};
