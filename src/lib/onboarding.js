/**
 * lib/onboarding.js — who has to go through channel setup, and how far along they are.
 *
 * New accounts (email sign-up or Google) are stamped with integrations.onboarding.required = true.
 * The stamp is what makes the dashboard send them to /onboarding.html until a channel (email or
 * WhatsApp) is connected. Accounts that existed before this shipped have no stamp, so nobody who is
 * already live is pushed through it.
 */
'use strict';

function stampRequired(intg, now = new Date()) {
  const out = { ...(intg || {}) };
  out.onboarding = { required: true, startedAt: now.toISOString() };
  return out;
}

function channelState(intg) {
  const i = intg || {};
  const email = !!(i.pipeline_email || i.lead_email);
  const whatsapp = !!(i.whatsapp && (i.whatsapp.phoneNumberId || i.whatsapp === true));
  return { email_connected: email, whatsapp_connected: whatsapp, channel_connected: email || whatsapp };
}

// Required only while a stamped account has no channel. Connecting either one releases it for good.
function onboardingRequired(intg) {
  const i = intg || {};
  if (!(i.onboarding && i.onboarding.required)) return false;
  return !channelState(i).channel_connected;
}

// Which wizard step to open on: 1 connect, 2 business, 3 what the Agent may do on its own, 4 try it.
function resumeStep({ channel_connected, profile_complete, autonomy_configured }) {
  if (!channel_connected) return 1;
  if (!profile_complete) return 2;
  if (autonomy_configured !== true) return 3;
  return 4;
}

module.exports = { stampRequired, channelState, onboardingRequired, resumeStep };
