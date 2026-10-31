/**
 * services/leads/ingestion.js — Email ingest and outbound sending
 *
 * Inbound:
 *   fetchNewMail()   — poll the user's inbox over IMAP by UID cursor (read or
 *                       unread), return raw messages for the engine.
 *
 * Outbound:
 *   sendLeadReply()  — send via SMTP, multipart HTML + plain text.
 *
 * Pre-qualification (fast, zero AI cost):
 *   prescreenEmail() — hard-pattern filter run BEFORE the AI call.
 *                      Only blatantly-obvious non-leads are blocked here.
 *                      Everything ambiguous passes through to qualifyLead().
 *
 * Design notes:
 *   - prescreenEmail is deliberately conservative. False-positive rejections
 *     (real customers filtered out) are far more costly than false negatives
 *     (spam passed to AI). When in doubt, let the AI decide.
 *   - HTML emails are decoded to clean plain text before being sent to the AI
 *     so the model reads the actual prose, not escaped HTML.
 */
'use strict';

const nodemailer = require('nodemailer');

// ════════════════════════════════════════════════════════════════
// PRE-SCREEN — zero-cost pattern filter (before AI)
// Only blocks emails that are UNAMBIGUOUSLY not leads.
// ════════════════════════════════════════════════════════════════

// Sender patterns that are always automated systems
const BLOCKED_SENDER_PATTERNS = [
  /^(?:no|do[-.]?not)[-.]?reply@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^bounces?\+/i,
  /^auto(?:reply|confirm|respond)@/i,
  // Known bulk/transactional ESPs as the sending domain
  /@(?:bounce\.|em\d+\.|mail\d+\.)?(?:sendgrid\.net|mailchimp\.com|klaviyo\.com|hubspot\.com|salesforce\.com|zendesk\.com|intercom\.io|constantcontact\.com|campaignmonitor\.com|mailgun\.org)$/i,
];

// Subject patterns that are unambiguously system-generated
const BLOCKED_SUBJECT_PATTERNS = [
  /^(?:auto(?:matic)?|automated)\s*(?:reply|response|out[-\s]?of[-\s]?office)/i,
  /^out[-\s]?of[-\s]?office/i,
  /^(?:delivery|mail)\s*(?:failed|failure|status\s*notification|undeliverable)/i,
  /^undeliverable:/i,
  /^\[spam\]/i,
  /^mailer[-_\s]?daemon/i,
];

/**
 * Fast pre-screen before calling the AI.
 * Returns { pass: true } to continue, or { pass: false, reason: '...' } to skip.
 * Ambiguous cases always return pass: true — let the AI decide.
 */
function prescreenEmail(fromEmail, subject, body) {
  const email = (fromEmail || '').toLowerCase().trim();
  const subj  = (subject   || '').trim();

  // Reject if no sender at all
  if (!email || !email.includes('@')) {
    return { pass: false, reason: 'missing_sender' };
  }

  // Reject unambiguous system senders
  for (const pattern of BLOCKED_SENDER_PATTERNS) {
    if (pattern.test(email)) {
      return { pass: false, reason: `blocked_sender_pattern` };
    }
  }

  // Reject unambiguous system subjects
  for (const pattern of BLOCKED_SUBJECT_PATTERNS) {
    if (pattern.test(subj)) {
      return { pass: false, reason: `blocked_subject_pattern` };
    }
  }

  // Reject completely empty emails
  const rawBody = (body || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!rawBody && !subj) {
    return { pass: false, reason: 'empty_email' };
  }

  // Everything else passes to AI
  return { pass: true };
}

// ════════════════════════════════════════════════════════════════
// IMAP INGEST
// Connects over IMAP, pulls unseen messages from INBOX, parses them
// with mailparser (handles multipart, base64, quoted-printable, and
// falls back from text/plain to text/html stripped of tags). Messages are
// marked \Seen by the poller only after they were processed successfully.
// ════════════════════════════════════════════════════════════════

function htmlToPlainText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Persistent IMAP connections ──────────────────────────────────
// The poller now runs every few seconds. Logging in from scratch each time
// would get mailboxes throttled (Gmail/Outlook rate-limit logins), so one
// connection per mailbox is kept open and reused. It is dropped on any
// error (the next poll reconnects), when the password changes, or when it
// has not been used for a while (user disconnected / stopped being polled).
const _imapConns = new Map(); // key -> { client, passHash, lastUsed, queue }

function _connKey({ user, host, port }) {
  return `${String(user).toLowerCase()}|${host}|${port || 993}`;
}

function _dropConn(key) {
  const entry = _imapConns.get(key);
  if (!entry) return;
  _imapConns.delete(key);
  try { entry.client.close(); } catch (_) {}
}

async function _getConn({ user, pass, host, port }) {
  const { ImapFlow } = require('imapflow');
  const crypto = require('crypto');
  const key = _connKey({ user, host, port });
  const passHash = crypto.createHash('sha256').update(String(pass)).digest('hex');

  let entry = _imapConns.get(key);
  if (entry && (entry.passHash !== passHash || !entry.client.usable)) {
    _dropConn(key);
    entry = null;
  }
  if (entry) { entry.lastUsed = Date.now(); return { key, entry }; }

  const client = new ImapFlow({
    host,
    port:   parseInt(port || '993', 10),
    secure: String(port) !== '143',
    auth:   { user, pass },
    logger: false,
    tls:    { rejectUnauthorized: false },
    connectionTimeout: 15_000,
    greetingTimeout:   10_000,
    socketTimeout:     60_000,
  });
  // Without an 'error' listener a dropped socket would crash the whole server.
  client.on('error', err => {
    console.warn(`[IMAP] connection error for ${user}: ${err.message}`);
    const cur = _imapConns.get(key);
    if (cur && cur.client === client) _imapConns.delete(key);
  });
  client.on('close', () => {
    const cur = _imapConns.get(key);
    if (cur && cur.client === client) _imapConns.delete(key);
  });

  await client.connect();
  entry = { client, passHash, lastUsed: Date.now(), queue: Promise.resolve() };
  _imapConns.set(key, entry);
  return { key, entry };
}

// Run fn(client) on the mailbox connection, one job at a time per mailbox.
// Any failure discards the connection so the next call starts clean.
async function _withConn(cfg, fn) {
  const { key, entry } = await _getConn(cfg);
  const job = entry.queue.then(async () => {
    entry.lastUsed = Date.now();
    try {
      return await fn(entry.client);
    } catch (err) {
      _dropConn(key);
      throw err;
    }
  });
  entry.queue = job.catch(() => {});
  return job;
}

/** Close connections that have not been used for maxIdleMs. */
function sweepIdleImap(maxIdleMs = 120_000) {
  const now = Date.now();
  for (const [key, entry] of _imapConns) {
    if (now - entry.lastUsed > maxIdleMs) _dropConn(key);
  }
}

function closeAllImap() {
  for (const key of [..._imapConns.keys()]) _dropConn(key);
}

/**
 * Mark messages as read. The poller calls this only AFTER a message has been
 * processed, so a failure (AI error, SMTP error, restart) leaves it unread and
 * it is retried instead of being lost.
 */
async function markImapSeen({ user, pass, host, port }, uids) {
  if (!uids || !uids.length) return;
  await _withConn({ user, pass, host, port }, async client => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  });
}

/**
 * Fetch NEW mail by position, not by the "unread" flag.
 *
 * Why: the old approach searched for \Seen=false. Anything the owner had already
 * opened (phone, webmail, a desktop client) was invisible to Humarains, so the lead
 * was never created and no reply was sent. Here every message with a UID greater
 * than the stored cursor is returned, read or not, and nothing is ever marked read
 * or otherwise changed in the owner's mailbox.
 *
 * cursor = { uidValidity, lastUid } as last committed by the poller, or null for a
 * mailbox that has never been polled (or whose UIDVALIDITY changed, or that was
 * reconnected). A null cursor is a BASELINE poll: mail that was already in the inbox
 * is NOT replied to; only unread mail that arrived in the last few minutes is, so
 * connecting an account never fires replies at old email.
 *
 * Returns { uidValidity, startUid, top, baseline, messages }, messages ascending by
 * UID. A message the pre-screen rejects (bounce, auto-reply, no-reply sender, too
 * old, unreadable) is still returned with `skip` set, so the poller can move the
 * cursor past it.
 */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;   // text parts come first; never pull a 25 MB attachment

async function fetchNewMail({ user, pass, host, port }, cursor, opts = {}) {
  const { simpleParser } = require('mailparser');
  const maxResults       = opts.maxResults || 20;
  const baselineWindowMs = opts.baselineWindowMs || 10 * 60_000;
  const maxAgeMs         = opts.maxAgeMs || 3 * 864e5;   // never auto-reply to mail older than 3 days
  const connectedMs      = opts.connectedAt ? Date.parse(opts.connectedAt) : NaN;

  return _withConn({ user, pass, host, port }, async client => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // The connection is kept open between polls; some servers only announce new
      // mail when asked.
      await client.noop().catch(() => {});

      const mb          = client.mailbox || {};
      const uidValidity = mb.uidValidity != null ? String(mb.uidValidity) : '';
      const top         = Math.max(0, (parseInt(mb.uidNext, 10) || 1) - 1);
      const baseline    = !cursor || String(cursor.uidValidity) !== uidValidity;

      let uids = [];
      let startUid;
      if (baseline) {
        // IMAP SINCE has day granularity, so ask for a day more and filter on the exact time.
        const floor = Math.max(Date.now() - baselineWindowMs, Number.isFinite(connectedMs) ? connectedMs - 60_000 : 0);
        const found = await client.search({ seen: false, since: new Date(floor - 864e5) }, { uid: true }) || [];
        if (found.length) {
          for await (const m of client.fetch(found.join(','), { uid: true, internalDate: true }, { uid: true })) {
            if (m.internalDate && new Date(m.internalDate).getTime() >= floor) uids.push(m.uid);
          }
        }
        uids.sort((a, b) => a - b);
        startUid = uids.length ? uids[0] - 1 : top;
      } else {
        startUid = cursor.lastUid;
        // "n:*" always includes the newest message even when it is older than n, so filter.
        const found = await client.search({ uid: `${startUid + 1}:*` }, { uid: true }) || [];
        uids = found.filter(u => u > startUid).sort((a, b) => a - b);
      }
      uids = uids.slice(0, maxResults);   // oldest first; the rest is picked up on the next poll

      const messages = [];
      for (const uid of uids) {
        try {
          const { content } = await client.download(uid, undefined, { uid: true, maxBytes: MAX_DOWNLOAD_BYTES });
          const parsed = await simpleParser(content);

          const fromAddr  = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
          const fromEmail = (fromAddr.address || '').trim();
          const fromName  = (fromAddr.name || '').trim() || null;
          const subject   = parsed.subject || '';

          let body = (parsed.text || '').trim();
          if (!body && parsed.html) body = htmlToPlainText(parsed.html);

          // Clamp to the column size (leads.email_message_id / email_thread_id are varchar(255)):
          // one over-long Message-ID would otherwise make every save fail and the lead be lost.
          const clamp      = v => (v ? String(v).slice(0, 255) : null);
          const messageId  = clamp(parsed.messageId);
          const inReplyTo  = clamp(parsed.inReplyTo);
          const references = Array.isArray(parsed.references) ? parsed.references.join(' ') : (parsed.references || null);
          const date       = parsed.date instanceof Date && !isNaN(parsed.date) ? parsed.date : null;

          // Machine-generated mail: auto-replies, bulk and list mail. Answering these starts mail loops.
          const hdr = n => String(parsed.headers.get(n) || '').toLowerCase().trim();
          const autoSub = hdr('auto-submitted');
          let skip = null;
          const pre = prescreenEmail(fromEmail, subject, body);
          if (!pre.pass) skip = pre.reason;
          else if (autoSub && autoSub !== 'no') skip = 'auto_submitted';
          else if (/bulk|junk|list/.test(hdr('precedence'))) skip = 'bulk_precedence';
          else if (hdr('x-auto-response-suppress')) skip = 'auto_response_suppressed';
          else if (date && Date.now() - date.getTime() > maxAgeMs) skip = 'too_old';
          if (skip) console.log(`[IMAP] Skipped ${fromEmail || '(no sender)'} — ${skip}`);

          messages.push({
            uid, skip, messageId, date,
            // Thread identity: prefer the email's own thread headers
            // (References chain root, then In-Reply-To, then this message's own ID).
            threadId: clamp((references && references.split(/\s+/)[0]) || inReplyTo || messageId),
            fromEmail, fromName, subject, body,
            isReply: !!(inReplyTo || (subject && /^re:/i.test(subject.trim()))),
            inReplyTo, references,
          });
        } catch (err) {
          console.error('[IMAP] Error processing message uid ' + uid + ':', err.message);
          // A connection-level failure must surface so the poller backs off; one
          // unparseable message must not block the ones behind it.
          if (!client.usable) throw err;
          messages.push({ uid, skip: 'unreadable', fromEmail: '', subject: '', body: '' });
        }
      }
      return { uidValidity, startUid, top, baseline, messages };
    } finally {
      lock.release();
    }
  });
}

// ════════════════════════════════════════════════════════════════
// EMAIL SENDING — shared HTML builder
// ════════════════════════════════════════════════════════════════
function buildHtmlEmail(plainBody) {
  // Looks like a normal personal email: no page background, card, shadow or border, and no hard-coded
  // colours, so it reads correctly in light and dark mode instead of sitting in a gray frame.
  const esc = line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Blank lines separate paragraphs; single line breaks inside one (a sign-off, an address) stay together.
  const escaped = String(plainBody || '')
    .split(/\n[ \t]*\n/)
    .map(block => block.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim()).map(esc).join('<br>'))
    .filter(Boolean)
    .map(inner => `<p style="margin:0 0 16px;font-family:'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7">${inner}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>
<body style="margin:0;padding:0">
  <div style="max-width:600px;margin:0;padding:0">
    ${escaped}
  </div>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════
// SMTP SEND
// ════════════════════════════════════════════════════════════════
async function sendSmtpEmail({ host, port, user, pass, secure, to, subject, body, fromName, fromEmail, attachments, inReplyTo, references }) {
  const transport = nodemailer.createTransport({
    host,
    port:   parseInt(port || '587', 10),
    secure: secure === true || String(port) === '465',
    auth:   { user, pass },
    connectionTimeout: 12_000,
    greetingTimeout:   8_000,
    socketTimeout:     15_000,
    tls: { rejectUnauthorized: false }, // handles self-signed certs on private mail servers
  });

  // Quotes / line breaks in a display name would produce a malformed From header.
  const safeName = fromName ? String(fromName).replace(/["\\\r\n]/g, '').trim() : '';
  const from = safeName ? `"${safeName}" <${fromEmail || user}>` : (fromEmail || user);
  const html = buildHtmlEmail(body);

  const mail = { from, to, subject, text: body, html };
  // Thread the reply under the customer's message so it lands in the same conversation in
  // their inbox, and so their answer carries a References chain we can match back to the lead.
  if (inReplyTo)  mail.inReplyTo  = inReplyTo;
  if (references) mail.references = references;
  // Photos from the media library: [{ filename, mime, buffer }]
  if (Array.isArray(attachments) && attachments.length) {
    mail.attachments = attachments.slice(0, 4).map(a => ({
      filename: a.filename, content: a.buffer, contentType: a.mime,
    }));
  }
  const info = await transport.sendMail(mail);
  transport.close();
  return { success: true, messageId: info.messageId };
}

// ── Dispatch: send the lead reply via the user's connected SMTP account ─
async function sendLeadReply({ user, to, subject, body, attachments, inReplyTo, references }) {
  const { getEmailConfig } = require('../mailbox');
  const config = getEmailConfig(user);

  if (!config) {
    throw new Error('No email account connected. Connect your email (IMAP + SMTP) in Email Connection settings.');
  }

  if (config.type === 'email') {
    if (!config.pass) {
      throw new Error('Email password missing or could not be decrypted. Please reconnect your email account.');
    }
    return sendSmtpEmail({
      host:      config.smtpHost,
      port:      config.smtpPort,
      user:      config.user,
      pass:      config.pass,
      fromEmail: config.fromEmail,
      fromName:  config.fromName,
      to, subject, body, attachments, inReplyTo, references,
    });
  }

  throw new Error('Unknown email configuration type: ' + config.type);
}

// Threading headers for a reply to a stored lead (manual send / approve / human-review send).
function threadingFor(lead) {
  if (!lead) return {};
  const parent = lead.emailMessageId || lead.emailThreadId;
  if (!parent) return {};
  const refs = [lead.emailThreadId, lead.emailMessageId].filter(Boolean);
  return { inReplyTo: parent, references: [...new Set(refs)].join(' ') };
}

module.exports = {
  fetchNewMail,
  markImapSeen,
  sweepIdleImap,
  closeAllImap,
  sendSmtpEmail,
  sendLeadReply,
  threadingFor,
  prescreenEmail,
  buildHtmlEmail,
};
