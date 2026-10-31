/**
 * lib/business-hours.js: the business's time zone and weekly opening hours.
 *
 * Opening hours are a schedule with one entry per weekday (0 = Sunday ... 6 = Saturday):
 *   { open: boolean, start: 'HH:MM', end: 'HH:MM' }   24-hour clock, in the business's own time zone.
 * Older accounts only have businessDays + businessHoursStart/End (one range for every open day);
 * normalizeSchedule() reads either form and always returns all seven days. legacyFields() goes the other
 * way, so code that still reads the old fields keeps working.
 */
'use strict';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];            // shown Monday first
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_START = '09:00';
const DEFAULT_END = '17:00';
const DEFAULT_DAYS = [1, 2, 3, 4, 5];

const toMinutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** The zone name if it is a real IANA zone, otherwise null. */
function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (_) { return null; }
}

function defaultSchedule() {
  const s = {};
  for (let d = 0; d < 7; d++) s[d] = { open: DEFAULT_DAYS.includes(d), start: DEFAULT_START, end: DEFAULT_END };
  return s;
}

/** Full seven-day schedule from settings: the per-day schedule if there is one, else the old single range. */
function normalizeSchedule(settings) {
  const st = settings || {};
  const out = {};
  const src = st.businessHours && typeof st.businessHours === 'object' ? st.businessHours : null;
  if (src) {
    for (let d = 0; d < 7; d++) {
      const e = src[d] || src[String(d)] || {};
      const start = HHMM.test(e.start) ? e.start : DEFAULT_START;
      const end = HHMM.test(e.end) && toMinutes(e.end) > toMinutes(start) ? e.end : DEFAULT_END;
      out[d] = { open: e.open === true, start, end: toMinutes(end) > toMinutes(start) ? end : '23:59' };
    }
    return out;
  }
  const days = Array.isArray(st.businessDays)
    ? st.businessDays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : DEFAULT_DAYS;
  const start = HHMM.test(st.businessHoursStart) ? st.businessHoursStart : DEFAULT_START;
  let end = HHMM.test(st.businessHoursEnd) ? st.businessHoursEnd : DEFAULT_END;
  if (toMinutes(end) <= toMinutes(start)) end = '23:59';
  for (let d = 0; d < 7; d++) out[d] = { open: days.includes(d), start, end };
  return out;
}

/**
 * Check a schedule that came from a form or a tool. Returns { ok: true, schedule } or { ok: false, error }.
 * Accepts an object keyed 0 to 6, or an array of seven entries starting with Sunday.
 */
function validateSchedule(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Opening hours are missing.' };
  const schedule = {};
  let anyOpen = false;
  for (let d = 0; d < 7; d++) {
    const e = input[d] || input[String(d)];
    if (!e || typeof e !== 'object') return { ok: false, error: `${DAY_NAMES[d]} is missing.` };
    if (e.open !== true && e.open !== false) return { ok: false, error: `${DAY_NAMES[d]}: say whether the business is open.` };
    const start = HHMM.test(e.start) ? e.start : null;
    const end = HHMM.test(e.end) ? e.end : null;
    if (e.open) {
      if (!start || !end) return { ok: false, error: `${DAY_NAMES[d]}: opening and closing times must look like 09:00.` };
      if (toMinutes(end) <= toMinutes(start)) return { ok: false, error: `${DAY_NAMES[d]}: closing time must be after opening time.` };
      anyOpen = true;
    }
    schedule[d] = { open: e.open, start: start || DEFAULT_START, end: end && start && toMinutes(end) > toMinutes(start) ? end : DEFAULT_END };
  }
  if (!anyOpen) return { ok: false, error: 'Choose at least one day the business is open.' };
  return { ok: true, schedule };
}

/** The old single-range fields, derived from a schedule: open days, earliest opening, latest closing. */
function legacyFields(schedule) {
  const open = Object.keys(schedule).map(Number).filter(d => schedule[d].open).sort((a, b) => a - b);
  const starts = open.map(d => schedule[d].start).sort();
  const ends = open.map(d => schedule[d].end).sort();
  return {
    businessDays: open,
    businessHoursStart: starts[0] || DEFAULT_START,
    businessHoursEnd: ends[ends.length - 1] || DEFAULT_END,
  };
}

/** "Mon-Fri 09:00-17:00, Sat 10:00-14:00, Sun closed" */
function describeHours(schedule) {
  const days = WEEK_ORDER.map(d => ({ d, ...schedule[d] }));
  const same = (a, b) => a.open === b.open && (!a.open || (a.start === b.start && a.end === b.end));
  const groups = [];
  for (const day of days) {
    const last = groups[groups.length - 1];
    if (last && same(last.items[last.items.length - 1], day)) last.items.push(day); else groups.push({ items: [day] });
  }
  return groups.map(g => {
    const first = g.items[0], last = g.items[g.items.length - 1];
    const label = g.items.length === 1 ? DAY_SHORT[first.d] : `${DAY_SHORT[first.d]}-${DAY_SHORT[last.d]}`;
    return first.open ? `${label} ${first.start}-${first.end}` : `${label} closed`;
  }).join(', ');
}

/** Weekday number and minutes since midnight in a zone, plus the date as YYYY-MM-DD. */
function localParts(tz, now = new Date()) {
  const zone = validTimezone(tz) || 'UTC';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]));
  const day = DAY_SHORT.indexOf(p.weekday);
  const hh = Number(p.hour) % 24, mm = Number(p.minute);
  return { zone, day, minutes: hh * 60 + mm, label: `${p.weekday} ${String(hh).padStart(2, '0')}:${p.minute}` };
}

/** Is the business open right now, and when does it next open or close? */
function openStatus(schedule, tz, now = new Date()) {
  const lp = localParts(tz, now);
  const today = schedule[lp.day];
  if (today.open && lp.minutes >= toMinutes(today.start) && lp.minutes < toMinutes(today.end)) {
    return { open: true, zone: lp.zone, localLabel: lp.label, closesAt: today.end };
  }
  if (today.open && lp.minutes < toMinutes(today.start)) {
    return { open: false, zone: lp.zone, localLabel: lp.label, next: { day: lp.day, time: today.start, when: 'today' } };
  }
  for (let i = 1; i <= 7; i++) {
    const d = (lp.day + i) % 7;
    if (schedule[d].open) {
      return { open: false, zone: lp.zone, localLabel: lp.label,
        next: { day: d, time: schedule[d].start, when: i === 1 ? 'tomorrow' : `on ${DAY_NAMES[d]}` } };
    }
  }
  return { open: false, zone: lp.zone, localLabel: lp.label, next: null };
}

/** One sentence for the AI: what time it is for the business and whether it is open. */
function hoursNowLine(schedule, tz, now = new Date()) {
  const s = openStatus(schedule, tz, now);
  const state = s.open ? `OPEN (closes at ${s.closesAt})`
    : s.next ? `CLOSED (opens ${s.next.when} at ${s.next.time})` : 'CLOSED';
  return `It is ${s.localLabel} for the business (${s.zone}) and the business is ${state}.`;
}

/**
 * Has the owner chosen their time zone? New accounts start on UTC as a placeholder and are not confirmed until they pick one.
 * Accounts from before this setting existed count as confirmed when they already use a zone other than UTC.
 */
function isTimezoneConfirmed(settings) {
  const st = settings || {};
  if (typeof st.timezoneConfirmed === 'boolean') return st.timezoneConfirmed;
  return !!validTimezone(st.timezone) && st.timezone !== 'UTC';
}

module.exports = {
  isTimezoneConfirmed, DAY_NAMES, DAY_SHORT, defaultSchedule, normalizeSchedule, validateSchedule, legacyFields,
  describeHours, localParts, openStatus, hoursNowLine, validTimezone,
};
