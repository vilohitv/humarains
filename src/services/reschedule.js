/**
 * services/reschedule.js — move a booked job to a new date and time.
 *
 * One function, used by the dashboard button (POST /api/leads/:id/reschedule) and by the Agent tool
 * (reschedule_booking), so both follow the same rules: the booking must already be on Google Calendar,
 * the new slot is validated, the SAME calendar event is moved (same link, attendees, reminders), and the
 * customer is told through Google's own update email when they were invited.
 */
'use strict';

const gc = () => require('./google-calendar');

/** "Fri 14 Nov, 2:00 pm" from a wall-clock date + time (no zone maths: it is already the event's local time). */
function formatWhen(date, time) {
  if (!date) return null;
  const d = new Date(`${date}T${time || '12:00'}:00Z`);
  if (isNaN(d)) return null;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d).replace(',', '');
  if (!time) return day;
  const t = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
    .replace(/\s?AM$/, ' am').replace(/\s?PM$/, ' pm');
  return `${day}, ${t}`;
}

/** A short note the owner can paste into WhatsApp or email. */
function customerMessage(lead, whenText) {
  const first = String(lead.customerName || lead.fromName || '').trim().split(/\s+/)[0];
  const what = lead.serviceType && lead.serviceType !== 'unknown' ? `your ${String(lead.serviceType).toLowerCase()} booking` : 'your booking';
  return `Hi${first ? ' ' + first : ''}, we have moved ${what} to ${whenText}. Let us know if that does not suit you and we will find another time.`;
}

/**
 * @param {object} o
 * @param {object} o.lead              lead (camelCase) that already has calendarEventId
 * @param {{date:string, time?:string, durationMinutes?:number}} o.when  the new slot, in the event's local time
 * @param {boolean} [o.notifyCustomer=true]
 * @returns {Promise<{ok:true, ...}|{ok:false, error:string}>}
 */
async function rescheduleLead({ lead, when, notifyCustomer = true, businessContext, userIntg, onTokenRefresh, db, userId, calendar }) {
  const cal = calendar || gc();
  const eventId = lead && (lead.calendarEventId || lead.calendar_event_id);
  if (!eventId) return { ok: false, error: 'This lead has no calendar booking yet, so there is nothing to move.' };
  if (!cal.getCalendarStatus(userIntg || {}).connected) return { ok: false, error: 'Google Calendar is not connected. Connect it in Settings first.' };
  if (!when || typeof when.date !== 'string') return { ok: false, error: 'A new date is needed.' };

  const r = await cal.rescheduleCalendarEvent({
    eventId, date: when.date, time: when.time, durationMinutes: when.durationMinutes,
    businessContext, userIntg, notifyCustomer: notifyCustomer !== false, onTokenRefresh,
  });
  if (!r.success) return { ok: false, error: r.error };

  const prevLink = lead.calendarEventLink || lead.calendar_event_link || null;
  if (db && r.eventLink && r.eventLink !== prevLink) {
    try { await db.query('UPDATE leads SET calendar_event_link=$1 WHERE id=$2 AND user_id=$3', [r.eventLink, lead.id, userId]); }
    catch (e) { console.error('[Reschedule] could not save the new link:', e.message); }
  }

  const cur = r.current || {};
  const whenText = formatWhen(cur.date || when.date, cur.time || (when.time || null));
  const prevText = r.previous && r.previous.date ? formatWhen(r.previous.date, r.previous.time) : null;
  return {
    ok: true, eventLink: r.eventLink || null, when: whenText, previousWhen: prevText,
    date: cur.date || when.date, time: cur.time || null, timeZone: r.timeZone || null,
    invited: !!r.invited, notified: !!r.notified,
    message: customerMessage(lead, whenText || 'the new time'),
  };
}

module.exports = { rescheduleLead, formatWhen, customerMessage };
