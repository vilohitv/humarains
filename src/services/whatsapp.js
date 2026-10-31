/**
 * whatsapp.js — Meta WhatsApp Business Cloud API
 *
 * Uses the official WhatsApp Cloud API (no third-party SDKs).
 * https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Onboarding is done via WhatsApp Embedded Signup — users connect their
 * own WhatsApp Business number through a Facebook popup, no manual
 * Phone Number ID / access token copy-pasting required.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
 *
 * Required env vars:
 *   META_APP_ID            — Meta App ID (App Dashboard → Settings → Basic)
 *   META_APP_SECRET        — Meta App Secret (server-side only, never sent to the client)
 *   META_CONFIG_ID         — Facebook Login for Business "Configuration ID" for the
 *                            Embedded Signup flow (App Dashboard → WhatsApp → Embedded
 *                            Signup Builder, or Facebook Login for Business → Configurations)
 *   WHATSAPP_VERIFY_TOKEN  — a secret string you choose for webhook verification
 *
 * Legacy/optional (server-level fallback, e.g. single-tenant self-host):
 *   WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN
 *
 * One-time Meta App setup for Embedded Signup:
 *   1. App Dashboard → Add Product → "Facebook Login for Business"
 *   2. Facebook Login for Business → Configurations → Create a configuration
 *      scoped to whatsapp_business_management + whatsapp_business_messaging.
 *      Copy its Configuration ID into META_CONFIG_ID.
 *   3. Facebook Login for Business → Settings → add this app's domain to
 *      "Allowed Domains for the JavaScript SDK" and "Valid OAuth Redirect URIs".
 *   4. App Dashboard → WhatsApp → Configuration → set the webhook URL to
 *      https://yourdomain.com/api/leads/whatsapp/webhook and subscribe to "messages".
 *   5. While the app is in Development mode, add yourself as a tester
 *      (App Dashboard → App Roles → Roles) to test the flow end-to-end.
 *   6. Submit for App Review to request Advanced Access for
 *      whatsapp_business_management / whatsapp_business_messaging before going live.
 */
'use strict';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE    = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ── Send a WhatsApp text message ──────────────────────────────
async function sendWhatsAppMessage({ to, body, phoneNumberId, accessToken }) {
  const pid   = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = accessToken   || process.env.WHATSAPP_ACCESS_TOKEN;

  if (!pid || !token) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required.');
  }

  // Normalise to E.164: strip spaces/dashes, ensure leading +
  const toNorm = normalisePhone(to);
  if (!toNorm) throw new Error('Invalid phone number: ' + to);

  const url  = `${GRAPH_API_BASE}/${pid}/messages`;
  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                toNorm,
    type:              'text',
    text: { preview_url: false, body },
  });

  // Retry only when the message definitely was NOT accepted (429 / 503, or the
  // connection never opened). Other failures could have been delivered anyway, and
  // WhatsApp has no idempotency key, so retrying them risks a duplicate message.
  // err.retryable = safe to retry; err.ambiguous = may or may not have been delivered.
  const DELAYS = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: payload });
    } catch (e) {
      const code = (e.cause && e.cause.code) || e.code;
      const err = new Error('WhatsApp network error: ' + e.message);
      err.retryable = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
      err.ambiguous = !err.retryable;
      if (err.retryable && attempt < DELAYS.length) { await new Promise(r => setTimeout(r, DELAYS[attempt])); continue; }
      throw err;
    }

    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON error body */ }

    if (!res.ok) {
      const e = data?.error || {};
      const msg = e.message || JSON.stringify(data);
      const err = new Error(`WhatsApp API ${res.status}${e.code ? ' (#' + e.code + ')' : ''}: ${msg}${waErrorHint(e.code)}`);
      err.waCode = e.code;
      err.status = res.status;
      err.retryable = res.status === 429 || res.status === 503;
      err.ambiguous = res.status === 500 || res.status === 502 || res.status === 504;
      if (err.retryable && attempt < DELAYS.length) { await new Promise(r => setTimeout(r, DELAYS[attempt])); continue; }
      throw err;
    }

    // Returns { messages: [{ id: 'wamid.xxx' }] }
    const messageId = data?.messages?.[0]?.id || null;
    console.log(`[WhatsApp] Sent to ${toNorm} — id: ${messageId}`);
    return messageId;
  }
}

// Plain-English hints for the most common Cloud API send failures
function waErrorHint(code) {
  switch (Number(code)) {
    case 131030: return ' — This number is not on the allowed recipient list. While the Meta app is in Development/test mode, add it under WhatsApp → API Setup → "To".';
    case 131047: case 131051: return ' — Outside the 24-hour window: WhatsApp only lets you reply within 24 hours of the person\'s last message. Wait until they message you again, or contact them another way.';
    case 133010: case 133004: return ' — This phone number is not registered with the Cloud API yet. Disconnect and reconnect WhatsApp.';
    case 131042: return ' — No valid payment method on the WhatsApp Business Account (Meta Business Manager → WhatsApp Manager → Payment settings).';
    case 190: return ' — The WhatsApp access token is invalid or expired. Disconnect and reconnect WhatsApp.';
    case 100: return ' — Meta rejected the request (check the phone number format and that the number is connected).';
    default: return '';
  }
}

// WhatsApp only allows free-form text for 24 hours after the customer's last message.
const SERVICE_WINDOW_MS = 24 * 3600 * 1000;
function lastCustomerMessageAt(lead) {
  if (!lead) return null;
  let t = lead.lastCustomerMessageAt ? new Date(lead.lastCustomerMessageAt).getTime() : 0;
  let h = lead.conversationHistory;
  if (typeof h === 'string') { try { h = JSON.parse(h); } catch (_) { h = []; } }
  for (const turn of (Array.isArray(h) ? h : [])) {
    if (turn && turn.role === 'customer' && turn.sentAt) { const x = new Date(turn.sentAt).getTime(); if (x > t) t = x; }
  }
  return t || null;
}
function inServiceWindow(lead, now = Date.now()) {
  const t = lastCustomerMessageAt(lead);
  return !!t && (now - t) < SERVICE_WINDOW_MS - 60_000;
}
const isWindowError = e => !!e && [131047, 131051].includes(Number(e.waCode));   // definite refusals: outside the 24h window

// Send one WhatsApp message to a customer. Humarains only ever REPLIES: free-form text is allowed for 24 hours after the
// customer's last message and nothing else is sent. Outside that window this throws err.windowClosed and calls nothing;
// the caller then uses another channel (email) or skips the message.
// Returns { id }.
async function sendWhatsAppReply({ to, body, lead, phoneNumberId, accessToken }) {
  if (!inServiceWindow(lead)) {
    const err = new Error('This contact has not messaged you on WhatsApp in the last 24 hours, and WhatsApp only allows replies inside that window. Contact them by email or phone instead.');
    err.windowClosed = true;
    throw err;
  }
  try {
    const id = await sendWhatsAppMessage({ to, body, phoneNumberId, accessToken });
    return { id };
  } catch (e) {
    // Our clock said "open" but Meta says closed: report it as a closed window, not a generic failure.
    if (isWindowError(e)) { e.windowClosed = true; }
    throw e;
  }
}

// ── Mark a message as read ────────────────────────────────────
async function markMessageRead({ messageId, phoneNumberId, accessToken }) {
  const pid   = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = accessToken   || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!pid || !token) return;

  const url = `${GRAPH_API_BASE}/${pid}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status:            'read',
      message_id:        messageId,
    }),
  }).catch(e => console.warn('[WhatsApp] markRead failed:', e.message));
}

// ── Parse inbound webhook payload ────────────────────────────
// Returns an array of normalised message objects, or [] if nothing actionable.
function parseWebhookPayload(body) {
  const messages = [];
  try {
    const entries = body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const val = change.value || {};
        const contacts = val.contacts || [];
        for (const msg of val.messages || []) {
          if (msg.type !== 'text' && msg.type !== 'image' && msg.type !== 'button') continue; // text, photos and quick-reply button taps from earlier messages

          const contact = contacts.find(c => c.wa_id === msg.from) || {};
          const profileName = contact?.profile?.name || null;

          messages.push({
            messageId:   msg.id,
            fromPhone:   '+' + msg.from.replace(/^\+/, ''), // ensure E.164
            fromName:    profileName,
            body:        msg.type === 'image' ? (msg.image?.caption || '') : msg.type === 'button' ? (msg.button?.text || msg.button?.payload || '') : (msg.text?.body || ''),
            images:      msg.type === 'image' && msg.image?.id ? [{ id: msg.image.id, mimeType: msg.image.mime_type || null }] : [],
            timestamp:   msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000).toISOString() : new Date().toISOString(),
            phoneNumberId: val.metadata?.phone_number_id || null,
          });
        }
      }
    }
  } catch (e) {
    console.error('[WhatsApp] parseWebhookPayload error:', e.message);
  }
  return messages;
}

// ── Download a photo the customer sent (media id -> bytes) ───
// Returns { mediaType, data (base64) } or null. Only jpeg/png/webp/gif, max ~4 MB.
const MEDIA_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
async function downloadMedia({ mediaId, accessToken, maxBytes = 4 * 1024 * 1024 }) {
  const token = accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!mediaId || !token) return null;
  const withTimeout = async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try { return await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal }); }
    finally { clearTimeout(t); }
  };
  try {
    const metaRes = await withTimeout(`${GRAPH_API_BASE}/${encodeURIComponent(mediaId)}`);
    const meta = await metaRes.json();
    if (!metaRes.ok || !meta.url) { console.warn('[WhatsApp] media lookup failed:', meta?.error?.message || metaRes.status); return null; }
    const mediaType = String(meta.mime_type || '').toLowerCase();
    if (!MEDIA_OK.has(mediaType)) { console.warn('[WhatsApp] unsupported media type:', mediaType); return null; }
    if (meta.file_size && Number(meta.file_size) > maxBytes) { console.warn('[WhatsApp] photo too large:', meta.file_size); return null; }
    const fileRes = await withTimeout(meta.url);
    if (!fileRes.ok) { console.warn('[WhatsApp] media download failed:', fileRes.status); return null; }
    const buf = Buffer.from(await fileRes.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    return { mediaType, data: buf.toString('base64') };
  } catch (e) {
    console.warn('[WhatsApp] media download error:', e.message);
    return null;
  }
}

// ── Verify webhook challenge from Meta ───────────────────────
function verifyWebhookChallenge(query, verifyToken) {
  const token     = verifyToken || process.env.WHATSAPP_VERIFY_TOKEN;
  const mode      = query['hub.mode'];
  const challenge = query['hub.challenge'];
  const tok       = query['hub.verify_token'];
  if (mode === 'subscribe' && tok === token) return challenge;
  return null;
}

// ── Validate credentials against the Graph API ───────────────
// Returns { valid: true, displayPhoneNumber, verifiedName } or { valid: false, error }
async function validateCredentials({ phoneNumberId, accessToken }) {
  if (!phoneNumberId || !accessToken) {
    return { valid: false, error: 'Phone Number ID and access token are required.' };
  }
  try {
    const url = `${GRAPH_API_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.error) {
      const msg = data?.error?.message || ('Graph API ' + res.status);
      return { valid: false, error: msg };
    }
    return {
      valid: true,
      displayPhoneNumber: data.display_phone_number || null,
      verifiedName:       data.verified_name        || null,
      qualityRating:      data.quality_rating        || null,
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ── Check if WhatsApp is configured (server-level fallback) ───
function isConfigured() {
  return !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}

// ── Check if Embedded Signup is configured (App ID/Secret/Config ID) ─
function isEmbeddedSignupConfigured() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_CONFIG_ID);
}

// ════════════════════════════════════════════════════════════════
// WHATSAPP EMBEDDED SIGNUP
// https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
// ════════════════════════════════════════════════════════════════

// ── Exchange the Embedded Signup auth code for a business token ──
// The `code` comes from the FB.login() authResponse after the user
// completes the popup flow. This call must happen server-side because
// it uses the App Secret. No redirect_uri is needed/used here since
// Embedded Signup runs in a popup (JS SDK), not a redirect-based OAuth flow.
async function exchangeCodeForToken({ code, appId, appSecret }) {
  const clientId     = appId     || process.env.META_APP_ID;
  const clientSecret = appSecret || process.env.META_APP_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET are required for Embedded Signup.');
  }
  if (!code) throw new Error('Missing authorization code from Embedded Signup.');

  const url = `${GRAPH_API_BASE}/oauth/access_token`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&client_secret=${encodeURIComponent(clientSecret)}`
    + `&code=${encodeURIComponent(code)}`;

  const res  = await fetch(url);
  const data = await res.json();

  if (!res.ok || data.error) {
    const msg = data?.error?.message || ('Graph API ' + res.status);
    throw new Error('Token exchange failed: ' + msg);
  }

  // { access_token, token_type, expires_in } — business tokens issued via
  // Embedded Signup are long-lived (no time-based expiry under standard access).
  return {
    accessToken: data.access_token,
    expiresIn:   data.expires_in || null,
  };
}

// ── Register the customer's phone number for Cloud API use ───────
// Required once per phone number before it can send/receive via Cloud API.
// A random PIN is generated since two-step verification isn't relevant
// for numbers onboarded entirely through Embedded Signup.
async function registerPhoneNumber({ phoneNumberId, accessToken, pin }) {
  if (!phoneNumberId || !accessToken) {
    throw new Error('phoneNumberId and accessToken are required to register the number.');
  }
  const twoStepPin = pin || String(Math.floor(100000 + Math.random() * 900000));

  const url = `${GRAPH_API_BASE}/${phoneNumberId}/register`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin: twoStepPin }),
  });
  const data = await res.json();

  if (!res.ok || data.error) {
    const msg = data?.error?.message || ('Graph API ' + res.status);
    throw new Error('Phone number registration failed: ' + msg);
  }
  return true;
}

// ── Subscribe this app to webhooks on the customer's WABA ─────────
// Without this, Meta will not deliver inbound message webhooks for
// this business's phone numbers to our webhook URL.
async function subscribeAppToWaba({ wabaId, accessToken }) {
  if (!wabaId || !accessToken) {
    throw new Error('wabaId and accessToken are required to subscribe to webhooks.');
  }
  const url = `${GRAPH_API_BASE}/${wabaId}/subscribed_apps`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });
  const data = await res.json();

  if (!res.ok || data.error) {
    const msg = data?.error?.message || ('Graph API ' + res.status);
    throw new Error('Webhook subscription failed: ' + msg);
  }
  return true;
}

// ── Look up display phone number + verified name for a phone number ─
async function getPhoneNumberDetails({ phoneNumberId, accessToken }) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}`
    + `?fields=display_phone_number,verified_name,quality_rating`
    + `&access_token=${encodeURIComponent(accessToken)}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    const msg = data?.error?.message || ('Graph API ' + res.status);
    throw new Error('Could not fetch phone number details: ' + msg);
  }
  return {
    displayPhoneNumber: data.display_phone_number || null,
    verifiedName:       data.verified_name        || null,
    qualityRating:      data.quality_rating        || null,
  };
}

// ── Full server-side completion of an Embedded Signup session ────
// Given the `code`, `phoneNumberId`, and `wabaId` returned by the
// FB.login() popup, this exchanges the code, registers the number,
// subscribes the app to the WABA's webhooks, and returns everything
// needed to persist the connection.
async function completeEmbeddedSignup({ code, phoneNumberId, wabaId }) {
  if (!phoneNumberId || !wabaId) {
    throw new Error('Missing phoneNumberId or wabaId from Embedded Signup.');
  }

  const { accessToken } = await exchangeCodeForToken({ code });

  // Registration can fail harmlessly (number already registered / has its own 2-step PIN).
  // Don't let that block saving the connection; log it so it's visible.
  let registerError = null;
  try {
    await registerPhoneNumber({ phoneNumberId, accessToken });
  } catch (e) {
    registerError = e.message;
    console.warn('[WhatsApp] register failed (continuing):', e.message);
  }
  await subscribeAppToWaba({ wabaId, accessToken });

  let details = {};
  try {
    details = await getPhoneNumberDetails({ phoneNumberId, accessToken });
  } catch (e) {
    console.warn('[WhatsApp] getPhoneNumberDetails failed (non-fatal):', e.message);
  }

  return {
    accessToken,
    phoneNumberId,
    wabaId,
    displayPhoneNumber: details.displayPhoneNumber || null,
    verifiedName:       details.verifiedName       || null,
    registerError,
  };
}

// ── Live health of a connected number (is it really able to receive?) ─
// A number that shows only ONE tick for senders is almost always not registered
// with the Cloud API (status != CONNECTED / platform_type != CLOUD_API).
async function getNumberHealth({ phoneNumberId, wabaId, accessToken }) {
  const out = { ok: false, problem: null, needsRegister: false, status: null, platformType: null, nameStatus: null, subscribed: null, qualityRating: null, policy: false };
  try {
    const url = `${GRAPH_API_BASE}/${phoneNumberId}`
      + `?fields=status,platform_type,name_status,code_verification_status,quality_rating,account_mode`
      + `&access_token=${encodeURIComponent(accessToken)}`;
    const r = await fetch(url); const d = await r.json();
    if (!r.ok || d.error) {
      out.problem = 'Meta rejected the connection check: ' + (d?.error?.message || ('HTTP ' + r.status)) + waErrorHint(d?.error?.code);
      return out;
    }
    out.status = d.status || null; out.platformType = d.platform_type || null; out.nameStatus = d.name_status || null;
    out.qualityRating = d.quality_rating || null;
    // Meta itself has restricted, flagged or banned this number. Re-registering cannot fix that and must not be tried:
    // the owner has to look at Account Quality in Meta Business Suite (and appeal if it is a mistake).
    if (/^(FLAGGED|RESTRICTED|BANNED)$/i.test(String(d.status || ''))) {
      out.policy = true;
      out.problem = `Meta has set this number to ${d.status} for a policy or quality problem. Open Account Quality in Meta Business Suite to see the reason and appeal.`;
    } else if (d.platform_type && d.platform_type !== 'CLOUD_API') {
      out.needsRegister = true;
      out.problem = `This number is not active on the WhatsApp Cloud API (platform: ${d.platform_type}). Messages sent to it show one tick and are never delivered.`;
    } else if (d.status && d.status !== 'CONNECTED') {
      out.needsRegister = true;
      out.problem = `This number's status on Meta is ${d.status}, not CONNECTED, so it cannot receive messages yet.`;
    } else if (d.name_status && /DECLINED|NONE/.test(d.name_status)) {
      out.problem = `The WhatsApp display name status is ${d.name_status}. Fix it in Meta WhatsApp Manager.`;
    }
    if (wabaId) {
      try {
        const sr = await fetch(`${GRAPH_API_BASE}/${wabaId}/subscribed_apps`, { headers: { Authorization: 'Bearer ' + accessToken } });
        const sd = await sr.json();
        out.subscribed = Array.isArray(sd?.data) ? sd.data.length > 0 : null;
        if (out.subscribed === false && !out.problem) out.problem = 'Humarains is not subscribed to this WhatsApp account\'s messages, so inbound messages will not arrive.';
      } catch (_) {}
    }
    out.ok = !out.problem;
  } catch (e) { out.problem = 'Could not reach Meta: ' + e.message; }
  return out;
}

// Send failures that mean the whole WhatsApp connection is broken (not just one message).
const ACCOUNT_LEVEL_CODES = new Set([190, 131031, 131042, 133004, 133010, 131030, 368]);
const isAccountLevelError = code => ACCOUNT_LEVEL_CODES.has(Number(code));

// One self-heal pass: check the number, re-register / re-subscribe when Meta says it is not active.
// Returns the health object (with `healed: [...]` listing what was fixed).
async function checkAndHeal({ phoneNumberId, wabaId, accessToken, allowRegister = true }) {
  let health = await getNumberHealth({ phoneNumberId, wabaId, accessToken });
  const healed = [];
  if (!health.ok && health.needsRegister && allowRegister && !health.policy) {
    try { await registerPhoneNumber({ phoneNumberId, accessToken }); healed.push('registered'); } catch (e) { health.registerError = e.message; }
  }
  if (wabaId && health.subscribed === false) {
    try { await subscribeAppToWaba({ wabaId, accessToken }); healed.push('subscribed'); } catch (e) { health.subscribeError = e.message; }
  }
  if (healed.length) health = { ...(await getNumberHealth({ phoneNumberId, wabaId, accessToken })), healed };
  else health.healed = healed;
  return health;
}

// ── Normalise phone to E.164 ──────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return null;
  // Strip everything except digits and leading +
  let n = String(raw).replace(/[\s\-().]/g, '');
  if (!n.startsWith('+')) n = '+' + n;
  // Must be at least 7 digits after +
  if (!/^\+\d{7,15}$/.test(n)) return null;
  return n;
}


// ── Send photos (WhatsApp image messages) ─────────────────────
// Uploads each image to the WhatsApp media endpoint, then sends it by media id
// (no public URL needed). media: [{ buffer, mime, filename, caption }]
// Returns the number of images sent. Failures on one image do not stop the rest.
async function sendWhatsAppImages({ to, media, phoneNumberId, accessToken }) {
  const pid   = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = accessToken   || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!pid || !token) throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required.');
  const toNorm = normalisePhone(to);
  if (!toNorm) throw new Error('Invalid phone number: ' + to);

  let sent = 0;
  for (const m of (Array.isArray(media) ? media : []).slice(0, 4)) {
    try {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', m.mime);
      form.append('file', new Blob([m.buffer], { type: m.mime }), m.filename || 'photo');
      const up = await fetch(`${GRAPH_API_BASE}/${pid}/media`, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: form,
      });
      const upData = await up.json();
      if (!up.ok || !upData.id) throw new Error(upData?.error?.message || 'media upload failed');

      const res = await fetch(`${GRAPH_API_BASE}/${pid}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', recipient_type: 'individual', to: toNorm, type: 'image',
          image: { id: upData.id, ...(m.caption ? { caption: String(m.caption).slice(0, 900) } : {}) },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data));
      sent++;
    } catch (e) {
      console.error(`[WhatsApp] image send failed to ${toNorm}:`, e.message);
    }
  }
  return sent;
}
// Meta signs every webhook with HMAC-SHA256 of the raw body using the app secret, in X-Hub-Signature-256 ("sha256=<hex>").
// Fails closed: with no secret configured nothing is trusted.
function verifyWebhookSignature(rawBody, header, secret = process.env.META_APP_SECRET) {
  try {
    if (!secret || !rawBody || !header || !String(header).startsWith('sha256=')) return false;
    const expected = require('crypto').createHmac('sha256', secret).update(rawBody).digest('hex');
    const got = String(header).slice(7);
    return got.length === expected.length && require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch (_) { return false; }
}

// ── Calls (WhatsApp Business Calling API) ─────────────────────
// Meta sends a `calls` webhook: event "connect" when a customer rings, then "terminate" when it ends. Humarains never
// answers calls, so a customer call that ends without ever being picked up is a MISSED call: a terminate event, direction
// USER_INITIATED, with no start_time (Meta: unanswered calls are "completed" but carry no start/end time or duration)
// or with status FAILED. Returns [{ callId, phone, name, phoneNumberId, at }] for those only.
function parseMissedCalls(body) {
  const out = [];
  try {
    for (const entry of body?.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'calls') continue;
        const val = change.value || {};
        for (const c of val.calls || []) {
          if (c.event !== 'terminate' || c.direction !== 'USER_INITIATED') continue;
          const answered = !!c.start_time && String(c.status || '').toUpperCase() !== 'FAILED';
          if (answered) continue;
          // The caller's number can be omitted when they use a WhatsApp username; without it nothing can be sent.
          const raw = c.from || (val.contacts && val.contacts[0] && val.contacts[0].wa_id) || '';
          const phone = normalisePhone(raw);
          out.push({
            callId: String(c.id || ''), phone: phone || null,
            name: (val.contacts && val.contacts[0] && val.contacts[0].profile && val.contacts[0].profile.name) || null,
            phoneNumberId: val.metadata?.phone_number_id || null,
            at: c.timestamp ? new Date(parseInt(c.timestamp, 10) * 1000).toISOString() : new Date().toISOString(),
          });
        }
      }
    }
  } catch (e) { console.error('[WhatsApp] parseMissedCalls error:', e.message); }
  return out.filter(c => c.callId);
}

// Turn the Calling API on for one business number (the owner asks for it explicitly). Customers then see a call button.
async function setCallingEnabled({ phoneNumberId, accessToken, enabled }) {
  const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/settings`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ calling: { status: enabled ? 'ENABLED' : 'DISABLED' } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error((data.error && data.error.message) || ('Graph API ' + res.status));
  return true;
}
async function getCallingStatus({ phoneNumberId, accessToken }) {
  const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/settings`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error((data.error && data.error.message) || ('Graph API ' + res.status));
  return String((data.calling && data.calling.status) || 'DISABLED').toUpperCase();
}

module.exports = {
  GRAPH_API_BASE,
  isAccountLevelError,
  checkAndHeal,
  downloadMedia,
  getNumberHealth,
  sendWhatsAppMessage,
  sendWhatsAppReply,
  inServiceWindow,
  lastCustomerMessageAt,
  waErrorHint,
  sendWhatsAppImages,
  markMessageRead,
  parseWebhookPayload,
  verifyWebhookChallenge,
  validateCredentials,
  normalisePhone,
  isConfigured,
  isEmbeddedSignupConfigured,
  exchangeCodeForToken,
  registerPhoneNumber,
  subscribeAppToWaba,
  getPhoneNumberDetails,
  completeEmbeddedSignup,
  parseMissedCalls,
  verifyWebhookSignature,
  setCallingEnabled,
  getCallingStatus,
};
