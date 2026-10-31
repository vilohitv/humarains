/**
 * services/agent/booking-tools.js — the Agent can move a booked job from chat.
 *
 *   reschedule_booking   move a lead's booking to a new date and time
 *
 * Uses services/reschedule.js, the same code as the Reschedule button in the dashboard.
 */
'use strict';

module.exports = function createBookingTools(h) {
  const { clip, compactLead, resolveLead, ambiguity, leadsApi } = h;

  const TOOL_DEFS = [
    { name: 'reschedule_booking',
      description: 'Move a lead\'s booked job to a new date and time on Google Calendar. Use it only when the owner asked to move, change or reschedule a booking, and give the exact new date and time they chose; never pick a time yourself. It moves the same calendar event, and when the customer was invited Google emails them the new time. The lead must already have a calendar booking. The result includes a short message the owner can send to the customer (for example on WhatsApp). Work out the date from today\'s date: "next Friday" must become YYYY-MM-DD.',
      input_schema: { type: 'object', properties: {
        lead_id:   { type: 'string', description: 'Lead id (from a previous result).' },
        lead_name: { type: 'string', description: 'Name, email or phone fragment if you have no id.' },
        date: { type: 'string', description: 'New date as YYYY-MM-DD, in the business\'s local time.' },
        time: { type: 'string', description: 'New start time as 24-hour HH:MM. Leave out to make it an all-day entry.' },
        duration_minutes: { type: 'number', description: 'Optional. Defaults to the booking\'s current length.' },
        notify_customer: { type: 'boolean', description: 'Email the customer the new time through Google Calendar. Default true; set false only if the owner said not to.' },
      }, required: ['date'] } },
  ];

  const HANDLERS = {
    async reschedule_booking(ctx, input) {
      const r = await resolveLead(ctx, input);
      const amb = ambiguity(r, input.lead_name); if (amb) return amb;
      const lead = r.lead;
      const lr = leadsApi();
      const intg = lr.getUserIntegrations(ctx.user);
      const out = await require('../reschedule').rescheduleLead({
        lead, when: { date: String(input.date || '').trim(), time: input.time == null ? '' : String(input.time).trim(), durationMinutes: input.duration_minutes },
        notifyCustomer: input.notify_customer !== false,
        businessContext: ctx.settings, userIntg: intg,
        onTokenRefresh: lr.makeCalendarTokenRefreshFn(ctx.db, ctx.userId), db: ctx.db, userId: ctx.userId,
      });
      if (!out.ok) return { ok: false, error: out.error };
      const name = compactLead(lead).name;
      ctx.actions.push(`Moved ${name}'s booking to ${out.when}`);
      return {
        ok: true, lead: name, newTime: out.when, previousTime: out.previousWhen,
        customerEmailed: out.notified,
        note: out.notified
          ? 'Google Calendar emailed the customer the new time.'
          : (out.invited ? 'The customer was not emailed.' : 'The customer was not invited on the calendar event (no email on file), so tell the owner to let them know.'),
        messageForCustomer: clip(out.message, 400),
      };
    },
  };

  return { TOOL_DEFS, HANDLERS };
};
