/**
 * services/wa-consent.js — the rules that keep a WhatsApp number from being suspended.
 *
 * Humarains only ever REPLIES on WhatsApp. It never starts a conversation, never sends a template or marketing
 * message, and never messages anyone who has not written to the business first. This module is the single gate
 * every owner-triggered, follow-up or workflow WhatsApp message passes through (the AI's direct reply to a
 * message that arrived seconds ago is sent from the inbound worker, which is by definition inside the window):
 *
 *   consent      A person is only ever messaged on WhatsApp if they have messaged this business on WhatsApp first.
 *                That inbound message is recorded in whatsapp_contacts. A phone number that merely appears on a web
 *                form or in an email is NOT consent and never receives a WhatsApp message.
 *   opt-out      STOP, "no thanks" and similar replies block every further WhatsApp message until the person
 *                writes again.
 *   24h window   WhatsApp allows free-form messages only for 24 hours after the person's last message to the business.
 *                The window is measured from their last WhatsApp message (never from an email). Outside it nothing is
 *                sent on WhatsApp; callers use email instead (when the customer gave one) or skip the message.
 *
 * Source: WhatsApp Business Messaging Policy (whatsappbusiness.com/policy), sections 1 and 2.
 */
'use strict';

const HOUR = 3600_000, DAY = 24 * HOUR;

// Replies that mean "do not follow up": common plain-text ways of saying no (also button taps on older messages).
const NEGATIVE_REPLIES = new Set(['not right now', 'no thanks', 'no thank you', 'no', 'not interested', "i'm not interested", 'i am not interested', 'not now', 'no longer interested', 'already sorted', 'already done']);
const normaliseReply = s => String(s || '').trim().toLowerCase().replace(/[.!]+$/g, '').replace(/[\u2019]/g, "'");
const isNegativeReply = s => NEGATIVE_REPLIES.has(normaliseReply(s));

const normalisePhone = p => { const d = String(p || '').replace(/[^\d]/g, ''); return d ? '+' + d : ''; };

class WhatsAppBlocked extends Error {
  constructor(reason, message) { super(message); this.name = 'WhatsAppBlocked'; this.blockedBy = reason; this.whatsappBlocked = true; }
}
const MESSAGES = {
  no_consent: 'This person has not messaged you on WhatsApp, and WhatsApp only allows messages to people who contacted you there first. Reply by email or phone instead.',
  opted_out: 'This person asked not to be contacted on WhatsApp.',
  window_closed: 'This person has not messaged you on WhatsApp in the last 24 hours. WhatsApp only allows replies inside that 24-hour window, so nothing can be sent here. Contact them by email or phone instead.',
};

// ── Consent registry ─────────────────────────────────────────────
// A message from the person is their opt-in. A normal message re-opens a previous opt-out; STOP or "no thanks" sets it.
async function recordInbound(db, userId, phone, { optOut = false, now = new Date() } = {}) {
  const p = normalisePhone(phone);
  if (!db || !userId || !p) return;
  await db.query(
    `INSERT INTO whatsapp_contacts (user_id, phone, opted_in_at, last_inbound_at, opted_out_at)
     VALUES ($1, $2, $3, $3, $4)
     ON CONFLICT (user_id, phone) DO UPDATE
        SET opted_out_at    = CASE WHEN EXCLUDED.last_inbound_at >= whatsapp_contacts.last_inbound_at
                                   THEN EXCLUDED.opted_out_at ELSE whatsapp_contacts.opted_out_at END,
            last_inbound_at = GREATEST(whatsapp_contacts.last_inbound_at, EXCLUDED.last_inbound_at)`,
    [userId, p, now.toISOString(), optOut ? now.toISOString() : null]
  );
}

// A customer ringing the business on WhatsApp is contacting it first, exactly like a message: it opens the 24-hour window
// (Meta counts answered and missed calls alike). Unlike a message it never lifts an opt-out: someone who said STOP is not
// texted back automatically just because they also called.
async function recordCall(db, userId, phone, { now = new Date() } = {}) {
  const p = normalisePhone(phone);
  if (!db || !userId || !p) return;
  await db.query(
    `INSERT INTO whatsapp_contacts (user_id, phone, opted_in_at, last_inbound_at) VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_id, phone) DO UPDATE SET last_inbound_at = GREATEST(whatsapp_contacts.last_inbound_at, EXCLUDED.last_inbound_at)`,
    [userId, p, now.toISOString()]);
}

async function getContact(db, userId, phone) {
  const p = normalisePhone(phone);
  if (!db || !p) return null;
  return db.queryOne('SELECT phone, opted_in_at, last_inbound_at, opted_out_at FROM whatsapp_contacts WHERE user_id = $1 AND phone = $2', [userId, p]);
}

// ── The gate ─────────────────────────────────────────────────────
// Throws WhatsAppBlocked when this message must not be sent. Returns { lastInboundAt } (ms) when it may.
async function assertCanMessage({ db, userId, phone, now = Date.now() }) {
  const { inServiceWindow } = require('./whatsapp');
  const contact = await getContact(db, userId, phone);
  if (!contact) throw new WhatsAppBlocked('no_consent', MESSAGES.no_consent);
  if (contact.opted_out_at) throw new WhatsAppBlocked('opted_out', MESSAGES.opted_out);
  const lastInboundAt = new Date(contact.last_inbound_at).getTime();
  if (!inServiceWindow({ lastCustomerMessageAt: new Date(lastInboundAt).toISOString() }, now)) {
    throw new WhatsAppBlocked('window_closed', MESSAGES.window_closed);
  }
  return { lastInboundAt };
}

// The one function every outbound path uses. Checks the rules, then sends plain text. Returns { id }.
// Throws WhatsAppBlocked (err.whatsappBlocked, err.blockedBy) when the message must not be sent.
async function sendGuarded({ db, userId, to, body, phoneNumberId, accessToken, now = Date.now() }) {
  const { sendWhatsAppReply } = require('./whatsapp');
  const gate = await assertCanMessage({ db, userId, phone: to, now });
  // The window comes from the REAL last WhatsApp message (whatsapp_contacts). Nothing else from the lead is used: its history
  // may contain customer turns that arrived by email, which do not open a WhatsApp window.
  const realLead = { lastCustomerMessageAt: new Date(gate.lastInboundAt).toISOString() };
  try {
    return await sendWhatsAppReply({ to, body, lead: realLead, phoneNumberId, accessToken });
  } catch (e) {
    if (e && e.windowClosed) throw new WhatsAppBlocked('window_closed', MESSAGES.window_closed);   // Meta says the window is closed
    throw e;
  }
}

module.exports = { WhatsAppBlocked, MESSAGES, normalisePhone, isNegativeReply, recordInbound, recordCall, getContact, assertCanMessage, sendGuarded };
