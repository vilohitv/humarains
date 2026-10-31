/**
 * lib/deeplink.js: links from emails to the exact place in the dashboard that needs the owner.
 *
 *   dashboardUrl(appUrl, { view, lead, ask })
 *     view  one of VIEWS: the page to open (the Consent Queue, Human Review, Email Connection, ...)
 *     lead  a lead id: that lead's detail panel opens on top of the page
 *     ask   a ready-made request sent to the Agent (only the keys in ASKS), for things that are approved by chat
 *
 * The dashboard reads these in public/agent.js (openDeepLink). A link that is opened while logged out survives the login: the
 * dashboard keeps the parameters for the rest of the browser tab. Unknown views, malformed ids and unknown asks are dropped, so
 * a link can never open anything that is not a real page.
 */
'use strict';

const VIEWS = ['leads', 'new', 'pending', 'closed', 'ingest', 'email', 'whatsapp', 'calendar', 'settings', 'payment',
  'humanreview', 'inbox', 'performance', 'workflows', 'knowledge', 'account', 'support'];
const ASKS = ['opportunities'];
const LEAD_ID = /^[A-Za-z0-9_-]{3,80}$/;

function dashboardUrl(appUrl, { view, lead, ask } = {}) {
  const base = String(appUrl || 'https://humarains.com').replace(/\/+$/, '') + '/dashboard.html';
  const q = [];
  if (view && VIEWS.includes(view)) q.push('view=' + encodeURIComponent(view));
  if (lead && LEAD_ID.test(String(lead))) q.push('lead=' + encodeURIComponent(lead));
  if (ask && ASKS.includes(ask)) q.push('ask=' + encodeURIComponent(ask));
  return q.length ? base + '?' + q.join('&') : base;
}

module.exports = { dashboardUrl, VIEWS, ASKS, LEAD_ID };
