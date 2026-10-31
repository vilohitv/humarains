 /**
 * google-calendar.js — Google Calendar Integration
 *
 * Handles:
 *  - OAuth connect flow (calendar.events scope)
 *  - Token storage/refresh via users.integrations JSON
 *  - Smart event extraction from conversation history using AI
 *  - Calendar event creation when a lead reaches deal_closed / closed
 *
 * Credentials are stored encrypted in users.integrations under the key
 * "google_calendar" using the same AES-256-GCM approach as services/mailbox.js.
 */
'use strict';

const crypto = require('crypto');

// ── Encryption (mirrors services/mailbox.js) ─────────────────────
const ALGO = 'aes-256-gcm';

function getEncKey() {
  const secret = process.env.JWT_SECRET || 'fallback-dev-key-change-in-production';
  return crypto.createHash('sha256').update(secret).digest();
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

// ── Build / read calendar integration object ───────────────────
function buildCalendarIntegration(email, accessToken, refreshToken, expiryDate) {
  return {
    type:         'google_calendar',
    email,
    enc_access:   encrypt(accessToken),
    enc_refresh:  encrypt(refreshToken),
    expiry_date:  expiryDate || null,
    connected_at: new Date().toISOString(),
  };
}

/**
 * Returns the raw (decrypted) tokens from the integration blob, or null.
 */
function getCalendarTokens(intg) {
  const cfg = intg?.google_calendar;
  if (!cfg) return null;
  const accessToken  = cfg.enc_access  ? decrypt(cfg.enc_access)  : null;
  const refreshToken = cfg.enc_refresh ? decrypt(cfg.enc_refresh) : null;
  if (!refreshToken) return null;
  return { accessToken, refreshToken, email: cfg.email, expiryDate: cfg.expiry_date || null };
}

/**
 * Returns a safe (no secrets) status object for API responses.
 */
function getCalendarStatus(intg) {
  const cfg = intg?.google_calendar;
  if (!cfg) return { connected: false };
  return {
    connected:    true,
    email:        cfg.email || null,
    connected_at: cfg.connected_at || null,
  };
}

// ── Build an authenticated oauth2Client ────────────────────────
async function buildAuthClient(tokens, onTokenRefresh) {
  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.APP_URL || 'http://localhost:3000') + '/api/leads/calendar/callback'
  );
  client.setCredentials({
    access_token:  tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date:   tokens.expiryDate ? Number(tokens.expiryDate) : undefined,
  });
  // Persist new access tokens whenever Google silently refreshes them,
  // so the next call doesn't start with a stale token and force another refresh.
  if (typeof onTokenRefresh === 'function') {
    client.on('tokens', (newTokens) => {
      onTokenRefresh(newTokens).catch(err =>
        console.error('[Calendar] Failed to persist refreshed tokens:', err.message)
      );
    });
  }
  return client;
}

// ── Time helpers (all wall-clock maths is done in an explicit IANA zone, never the server's) ──
function validTz(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (_) { return null; }
}

// "Thu 2026-10-15 14:00" for a Date, as seen in `tz`
function fmtInTz(date, tz) {
  try {
    const p = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).forEach(x => { p[x.type] = x.value; });
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch (_) { return date.toISOString(); }
}

// Today's calendar date (YYYY-MM-DD) in `tz`
function todayInTz(tz, now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now || new Date());
}

function isRealDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// "YYYY-MM-DD" + "HH:MM" + minutes -> "YYYY-MM-DDTHH:MM:00" (still wall-clock, no zone applied)
function addMinutesLocal(ymd, hhmm, minutes) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm]  = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm + minutes)).toISOString().slice(0, 19);
}

function normTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

// ── Extract appointment details from conversation via AI ────────
/**
 * Uses Claude to read the conversation history and pull out:
 *  - appointmentDate (YYYY-MM-DD, or null)
 *  - appointmentTime (HH:MM 24h, exactly as the customer said it, or null)
 *  - timeZone (IANA zone the time is expressed in: the customer's if they stated one,
 *    otherwise the business's configured timezone)
 *  - durationMinutes (number, default 60)
 *  - serviceType, customerName, address, notes
 *
 * Relative wording ("tomorrow", "Thursday", "next week") is resolved against the date the
 * message was sent, in the business's timezone.
 */
async function extractAppointmentDetails(claude, model, lead, businessContext) {
  const bizTz = validTz(businessContext && businessContext.timezone) || 'UTC';
  const now   = new Date();

  const history = (lead.conversationHistory || [])
    .slice(-12) // last 12 turns
    .map(t => {
      const when = t.sentAt && !isNaN(new Date(t.sentAt)) ? `, sent ${fmtInTz(new Date(t.sentAt), bizTz)}` : '';
      return `[${t.role === 'agent' ? 'Business' : 'Customer'}${when}]: ${(t.body || '').slice(0, 400)}`;
    })
    .join('\n\n');

  const prompt = `You are reading a service booking conversation. Extract the appointment details.

Business: ${(businessContext && businessContext.businessName) || 'Service Business'}
Business timezone: ${bizTz}
Right now (business timezone): ${fmtInTz(now, bizTz)}
Service type: ${lead.serviceType || 'unknown'}
Customer name: ${lead.customerName || lead.fromName || 'Customer'}

Conversation (timestamps are in the business timezone):
---
${history}
---

Rules:
- Pick the appointment time the customer requested or both sides settled on. If the business offered options and the customer chose one, use the chosen one. If the time was changed during the conversation, the LATEST agreed time wins.
- Resolve relative dates ("tomorrow", "Thursday", "next week") against the timestamp of the message they appear in, never against today. A bare weekday means the next occurrence after that message.
- Copy the clock time exactly as stated ("2pm" -> "14:00", "noon" -> "12:00"). Do NOT convert it to another timezone.
- If the customer explicitly names a timezone or a city/region for the time ("3pm EST", "10am London time"), return it as an IANA name in customerTimezone (e.g. "America/New_York", "Europe/London"). Otherwise return null.
- If no concrete day was agreed, return null for appointmentDate and appointmentTime. If a day was agreed but only a vague part of day ("morning"), return the date and null for appointmentTime.

Return ONLY valid JSON:
{
  "appointmentDate": "YYYY-MM-DD or null",
  "appointmentTime": "HH:MM in 24h format or null",
  "customerTimezone": "IANA timezone name or null",
  "durationMinutes": 60,
  "serviceType": "the service being booked",
  "customerName": "customer first name",
  "address": "service address if mentioned, or null",
  "notes": "any important details (what they need, special requirements), max 100 chars"
}`;

  try {
    const res = await claude.messages.create({
      model,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content.map(b => b.text || '').join('').trim();
    // Strip markdown fences if present
    const clean = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);

    const date = isRealDate(parsed.appointmentDate) ? parsed.appointmentDate : null;
    const time = date ? normTime(parsed.appointmentTime) : null; // a time without a date is meaningless
    const dur  = parseInt(parsed.durationMinutes, 10);

    return {
      appointmentDate:  date,
      appointmentTime:  time,
      timeZone:         validTz(parsed.customerTimezone) || bizTz,
      durationMinutes:  dur > 0 && dur <= 24 * 60 ? dur : 60,
      serviceType:      parsed.serviceType      || lead.serviceType || 'Service Appointment',
      customerName:     parsed.customerName     || lead.customerName || lead.fromName || 'Customer',
      address:          parsed.address          || null,
      notes:            parsed.notes            || null,
    };
  } catch (err) {
    console.error('[Calendar] extractAppointmentDetails error:', err.message);
    return {
      appointmentDate: null,
      appointmentTime: null,
      timeZone:        bizTz,
      durationMinutes: 60,
      serviceType:     lead.serviceType || 'Service Appointment',
      customerName:    lead.customerName || lead.fromName || 'Customer',
      address:         null,
      notes:           null,
    };
  }
}

// ── Build Google Calendar event object ─────────────────────────
function buildCalendarEvent(details, lead, businessContext) {
  const { appointmentDate, appointmentTime, durationMinutes, serviceType, customerName, address, notes } = details;
  const tz = validTz(details.timeZone) || validTz(businessContext && businessContext.timezone) || 'UTC';

  let start, end;

  if (appointmentDate && isRealDate(appointmentDate)) {
    const time = normTime(appointmentTime);
    if (time) {
      // Specific date + time: a wall-clock time in an explicit zone, so Google (not this server) places it
      // correctly, including daylight-saving changes.
      start = { dateTime: `${appointmentDate}T${time}:00`, timeZone: tz };
      end   = { dateTime: addMinutesLocal(appointmentDate, time, durationMinutes || 60), timeZone: tz };
    } else {
      // Date only (all-day event); Google's all-day end date is exclusive
      start = { date: appointmentDate };
      end   = { date: addDaysYmd(appointmentDate, 1) };
    }
  } else {
    // No date agreed yet — create a placeholder for "today + 3 days" (business-local date)
    const day = addDaysYmd(todayInTz(tz), 3);
    start = { date: day };
    end   = { date: addDaysYmd(day, 1) };
  }

  const summary = `${serviceType} — ${customerName}`;

  const descParts = [
    `Customer: ${customerName}`,
    lead.fromEmail ? `Email: ${lead.fromEmail}` : null,
    notes          ? `Notes: ${notes}`          : null,
    address        ? `Location: ${address}`     : null,
    `Booked via Humarains`,
    `Lead ID: ${lead.id}`,
  ].filter(Boolean);

  const event = {
    summary,
    description: descParts.join('\n'),
    start,
    end,
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email',  minutes: 60 * 24 }, // 1 day before
        { method: 'popup',  minutes: 60 },       // 1 hour before
      ],
    },
  };

  if (address) event.location = address;

  // Invite the customer
  if (lead.fromEmail) {
    event.attendees = [{ email: lead.fromEmail, displayName: customerName }];
  }

  return event;
}

// ── Main function: create a Calendar event for a closed lead ───
/**
 * @param {object} options
 * @param {object} options.lead           — the lead object (camelCase)
 * @param {object} options.businessContext — business settings
 * @param {object} options.userIntg        — parsed integrations blob
 * @param {object} options.claude          — Anthropic SDK instance (for AI extraction)
 * @param {string} options.model           — model string
 * @returns {{ success: boolean, eventId?: string, eventLink?: string, error?: string }}
 */
async function createCalendarEventForLead({ lead, businessContext, userIntg, claude, model, onTokenRefresh }) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return { success: false, error: 'Google OAuth not configured.' };
  }

  const tokens = getCalendarTokens(userIntg);
  if (!tokens) {
    return { success: false, error: 'Google Calendar not connected.' };
  }

  try {
    const { google } = require('googleapis');

    // Build auth client + handle token refresh automatically
    const authClient = await buildAuthClient(tokens, onTokenRefresh);

    // Extract appointment details from the conversation
    const details = await extractAppointmentDetails(claude, model, lead, businessContext);

    // Build the event payload
    const eventBody = buildCalendarEvent(details, lead, businessContext);

    // Create the event
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    const response = await calendar.events.insert({
      calendarId:          'primary',
      resource:            eventBody,
      sendUpdates:         lead.fromEmail ? 'all' : 'none', // send invite to customer
    });

    const event = response.data;
    console.log(`[Calendar] Event created for lead ${lead.id}: ${event.id}`);

    return {
      success:   true,
      eventId:   event.id,
      eventLink: event.htmlLink,
      summary:   event.summary,
      details,
    };
  } catch (err) {
    console.error('[Calendar] createCalendarEventForLead error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Create a simple test event (no AI, no lead required) ───────
/**
 * Lets a user verify their Google Calendar connection actually works by
 * creating a harmless placeholder event on their primary calendar,
 * starting a few minutes from now.
 * @param {object} options
 * @param {object} options.userIntg — parsed integrations blob
 * @returns {{ success: boolean, eventId?: string, eventLink?: string, error?: string }}
 */
async function createTestCalendarEvent({ userIntg, onTokenRefresh }) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return { success: false, error: 'Google OAuth not configured.' };
  }

  const tokens = getCalendarTokens(userIntg);
  if (!tokens) {
    return { success: false, error: 'Google Calendar not connected.' };
  }

  try {
    const { google } = require('googleapis');
    const authClient = await buildAuthClient(tokens, onTokenRefresh);

    const startMs = Date.now() + 10 * 60_000; // 10 minutes from now
    const endMs   = startMs + 30 * 60_000;     // 30 minute event

    const eventBody = {
      summary: 'Humarains Test Event',
      description: [
        'This is a test event created from Humarains to confirm your Google',
        'Calendar connection is working. It\'s safe to delete this event.',
      ].join(' '),
      start: { dateTime: new Date(startMs).toISOString() },
      end:   { dateTime: new Date(endMs).toISOString() },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    };

    const calendar = google.calendar({ version: 'v3', auth: authClient });
    const response = await calendar.events.insert({
      calendarId:  'primary',
      resource:    eventBody,
      sendUpdates: 'none',
    });

    const event = response.data;
    console.log(`[Calendar] Test event created: ${event.id}`);

    return {
      success:   true,
      eventId:   event.id,
      eventLink: event.htmlLink,
      summary:   event.summary,
    };
  } catch (err) {
    console.error('[Calendar] createTestCalendarEvent error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── List upcoming events on the user's primary calendar ────────
/**
 * Fetches upcoming events so the UI can show the user everything on
 * their connected Google Calendar, not just events Humarains created.
 * @param {object} options
 * @param {object} options.userIntg    — parsed integrations blob
 * @param {number} [options.maxResults] — max events to return (default 25)
 * @param {string} [options.timeMin]    — ISO string lower bound (default: now)
 * @returns {{ success: boolean, events?: Array, error?: string }}
 */
async function listCalendarEvents({ userIntg, maxResults = 25, timeMin, onTokenRefresh }) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return { success: false, error: 'Google OAuth not configured.' };
  }

  const tokens = getCalendarTokens(userIntg);
  if (!tokens) {
    return { success: false, error: 'Google Calendar not connected.' };
  }

  try {
    const { google } = require('googleapis');
    const authClient = await buildAuthClient(tokens, onTokenRefresh);
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const response = await calendar.events.list({
      calendarId:    'primary',
      timeMin:       timeMin || new Date().toISOString(),
      maxResults,
      singleEvents:  true,
      orderBy:       'startTime',
    });

    const events = (response.data.items || []).map(ev => ({
      id:          ev.id,
      summary:     ev.summary || '(No title)',
      description: ev.description || null,
      location:    ev.location || null,
      start:       ev.start && (ev.start.dateTime || ev.start.date),
      end:         ev.end && (ev.end.dateTime || ev.end.date),
      allDay:      !!(ev.start && ev.start.date && !ev.start.dateTime),
      link:        ev.htmlLink,
      status:      ev.status,
      attendees:   (ev.attendees || []).map(a => ({ email: a.email, responseStatus: a.responseStatus })),
    }));

    return { success: true, events };
  } catch (err) {
    console.error('[Calendar] listCalendarEvents error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Reschedule an existing booking ─────────────────────────────
/** "HH:MM" for `now` as seen in `tz` */
function timeNowInTz(tz, now) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now || new Date()).forEach(x => { p[x.type] = x.value; });
  return `${p.hour}:${p.minute}`;
}

/**
 * Work out the new start/end for a reschedule. Pure: no network, so it can be tested on its own.
 * @param {{date:string, time?:string, durationMinutes?:number, timeZone?:string}} want  the new slot (wall-clock)
 * @param {object} existing  the current Google event ({start, end}) used for the zone and the duration
 * @param {object} businessContext
 * @param {Date} [now]
 * @returns {{start, end, timeZone, durationMinutes, allDay} | {error: string}}
 */
function buildReschedulePatch(want, existing, businessContext, now) {
  const cur = existing || {};
  const tz = validTz(want.timeZone) || validTz(cur.start && cur.start.timeZone) || validTz(businessContext && businessContext.timezone) || 'UTC';
  const date = String(want.date || '').trim();
  if (!isRealDate(date)) return { error: 'Choose a real date (YYYY-MM-DD).' };
  const today = todayInTz(tz, now);
  if (date < today) return { error: 'That date is in the past.' };
  if (date > addDaysYmd(today, 730)) return { error: 'That date is more than two years away.' };

  const timeRaw = want.time == null || String(want.time).trim() === '' ? null : normTime(want.time);
  if (want.time != null && String(want.time).trim() !== '' && !timeRaw) return { error: 'Choose a real time (HH:MM, 24-hour).' };
  if (timeRaw && date === today && timeRaw < timeNowInTz(tz, now)) return { error: 'That time has already passed today.' };

  if (!timeRaw) {   // date only, an all-day event (Google's all-day end date is exclusive)
    return { allDay: true, timeZone: tz, durationMinutes: null, start: { date }, end: { date: addDaysYmd(date, 1) } };
  }
  let duration = Number(want.durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) {
    const a = cur.start && cur.start.dateTime && Date.parse(cur.start.dateTime);
    const b = cur.end && cur.end.dateTime && Date.parse(cur.end.dateTime);
    duration = a && b && b > a ? Math.round((b - a) / 60000) : 60;
  }
  duration = Math.max(15, Math.min(720, Math.round(duration)));
  return {
    allDay: false, timeZone: tz, durationMinutes: duration,
    start: { dateTime: `${date}T${timeRaw}:00`, timeZone: tz },
    end:   { dateTime: addMinutesLocal(date, timeRaw, duration), timeZone: tz },
  };
}

function eventTimes(ev) {
  const start = ev && ev.start, end = ev && ev.end;
  if (start && start.date && !start.dateTime) return { allDay: true, date: start.date, time: null, timeZone: null, durationMinutes: null };
  const tz = validTz(start && start.timeZone) || null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec((start && start.dateTime) || '');
  let date = m ? m[1] : null, time = m ? m[2] : null;
  if (start && start.dateTime && tz) {          // express the instant in the event's own zone
    const d = new Date(start.dateTime);
    if (!isNaN(d)) { date = todayInTz(tz, d); time = timeNowInTz(tz, d); }
  }
  const a = start && start.dateTime && Date.parse(start.dateTime), b = end && end.dateTime && Date.parse(end.dateTime);
  return { allDay: false, date, time, timeZone: tz, durationMinutes: a && b && b > a ? Math.round((b - a) / 60000) : null };
}

function calendarErrorMessage(err) {
  const code = err && (err.code || (err.response && err.response.status));
  if (code === 404 || code === 410) return 'That booking is no longer on your Google Calendar. It may have been deleted there.';
  if (code === 401 || code === 403) return 'Google Calendar did not allow the change. Reconnect your calendar and try again.';
  return (err && err.message) || 'Could not update Google Calendar.';
}

/** Read one booking's current time from Google Calendar. */
async function getCalendarEventTimes({ eventId, userIntg, onTokenRefresh }) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return { success: false, error: 'Google OAuth not configured.' };
  const tokens = getCalendarTokens(userIntg);
  if (!tokens) return { success: false, error: 'Google Calendar not connected.' };
  try {
    const { google } = require('googleapis');
    const calendar = google.calendar({ version: 'v3', auth: await buildAuthClient(tokens, onTokenRefresh) });
    const ev = (await calendar.events.get({ calendarId: 'primary', eventId })).data;
    if (ev.status === 'cancelled') return { success: false, error: 'That booking is no longer on your Google Calendar. It may have been deleted there.' };
    return { success: true, summary: ev.summary || null, link: ev.htmlLink || null, hasAttendees: !!(ev.attendees && ev.attendees.length), ...eventTimes(ev) };
  } catch (err) {
    console.error('[Calendar] getCalendarEventTimes error:', err.message);
    return { success: false, error: calendarErrorMessage(err) };
  }
}

/**
 * Move an existing booking to a new date/time. Keeps the same event (same link, attendees and reminders).
 * When `notifyCustomer` is true and the customer was invited, Google emails them the updated time.
 */
async function rescheduleCalendarEvent({ eventId, date, time, durationMinutes, timeZone, businessContext, userIntg, notifyCustomer, onTokenRefresh }) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return { success: false, error: 'Google OAuth not configured.' };
  const tokens = getCalendarTokens(userIntg);
  if (!tokens) return { success: false, error: 'Google Calendar not connected.' };
  if (!eventId) return { success: false, error: 'This lead has no calendar booking to move.' };
  try {
    const { google } = require('googleapis');
    const calendar = google.calendar({ version: 'v3', auth: await buildAuthClient(tokens, onTokenRefresh) });
    const cur = (await calendar.events.get({ calendarId: 'primary', eventId })).data;
    if (cur.status === 'cancelled') return { success: false, error: 'That booking is no longer on your Google Calendar. It may have been deleted there.' };

    const plan = buildReschedulePatch({ date, time, durationMinutes, timeZone }, cur, businessContext);
    if (plan.error) return { success: false, error: plan.error };

    // Switching between an all-day and a timed event: Google needs the old field cleared.
    if (plan.start.dateTime && cur.start && cur.start.date) { plan.start.date = null; plan.end.date = null; }
    if (plan.start.date && cur.start && cur.start.dateTime) { plan.start.dateTime = null; plan.start.timeZone = null; plan.end.dateTime = null; plan.end.timeZone = null; }

    const invited = !!(cur.attendees && cur.attendees.length);
    const resp = await calendar.events.patch({
      calendarId: 'primary', eventId,
      resource: { start: plan.start, end: plan.end },
      sendUpdates: notifyCustomer && invited ? 'all' : 'none',
    });
    console.log(`[Calendar] Event ${eventId} rescheduled to ${date}${time ? ' ' + time : ''}`);
    return {
      success: true, eventId, eventLink: resp.data.htmlLink || cur.htmlLink || null,
      previous: eventTimes(cur), current: eventTimes(resp.data),
      notified: !!(notifyCustomer && invited), invited,
      timeZone: plan.timeZone,
    };
  } catch (err) {
    console.error('[Calendar] rescheduleCalendarEvent error:', err.message);
    return { success: false, error: calendarErrorMessage(err) };
  }
}

// ── Generate OAuth URL ─────────────────────────────────────────
function generateCalendarAuthUrl(userId) {
  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.APP_URL || 'http://localhost:3000') + '/api/leads/calendar/callback'
  );

  const state = crypto.randomBytes(16).toString('hex');
  if (!global._calendarOAuthStates) global._calendarOAuthStates = new Map();
  global._calendarOAuthStates.set(state, { userId, expires: Date.now() + 300_000 });

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  });

  return { url, state };
}

// ── Handle OAuth callback ──────────────────────────────────────
/**
 * Exchanges code for tokens, saves to user integrations.
 * @returns {{ userId, email }} on success, throws on error.
 */
async function handleCalendarCallback(code, state, saveIntegrationsFn) {
  const stateMap   = global._calendarOAuthStates;
  const stateEntry = stateMap && stateMap.get(state);
  if (!stateEntry || Date.now() > stateEntry.expires) {
    throw new Error('state_expired');
  }
  stateMap.delete(state);

  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.APP_URL || 'http://localhost:3000') + '/api/leads/calendar/callback'
  );

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Get connected email
  const oauth2  = google.oauth2({ version: 'v2', auth: client });
  const { data: userInfo } = await oauth2.userinfo.get();
  const email = userInfo.email;

  await saveIntegrationsFn(stateEntry.userId, email, tokens.access_token, tokens.refresh_token, tokens.expiry_date);

  return { userId: stateEntry.userId, email };
}

module.exports = {
  buildCalendarIntegration,
  getCalendarTokens,
  getCalendarStatus,
  generateCalendarAuthUrl,
  handleCalendarCallback,
  createCalendarEventForLead,
  createTestCalendarEvent,
  listCalendarEvents,
  extractAppointmentDetails,
  buildCalendarEvent,
  buildReschedulePatch,
  getCalendarEventTimes,
  rescheduleCalendarEvent,
};
