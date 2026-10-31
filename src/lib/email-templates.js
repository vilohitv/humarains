/**
 * humarains — Email Templates
 * Clean black and white emails for all transactional messages.
 * Solid fills only, so they render the same in every client.
 */
'use strict';

const { dashboardUrl } = require('./deeplink');

const APP_NAME = 'humarains';

const INK        = '#000000';
const BG_COLOR   = '#ffffff';
const CARD_BG    = '#ffffff';
const TEXT_MAIN  = '#0a0a0a';
const TEXT_MUTED = '#6b6b6b';
const BORDER     = '#e6e6e6';
const SOFT       = '#f6f6f6';

const FONT = "'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A solid black bar across the top of the card. */
function topBar(height = 4) {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;"><tr><td bgcolor="${INK}" style="background:${INK};height:${height}px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

/**
 * Shared email wrapper: wordmark, white card with a black top bar, footer.
 */
function wrap({ preheader = '', body = '', appUrl = 'https://humarains.com' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light only">
  <title>${APP_NAME}</title>
  <style>
    /* Hanken Grotesk loads in mail apps that support web fonts (Apple Mail, iOS); the rest fall back to the system sans. */
    @font-face { font-family:'Hanken Grotesk'; font-style:normal; font-weight:100 900; src:url('${appUrl}/fonts/hanken-grotesk-latin-wght-normal.woff2') format('woff2'); }
    @media only screen and (max-width:620px) {
      .card-pad { padding:32px 24px 28px !important; }
      .stat-cell { display:block !important; width:100% !important; padding:0 0 10px !important; }
      .stat-gap { display:none !important; }
    }
  </style>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:${BG_COLOR};font-family:${FONT};-webkit-font-smoothing:antialiased;color:${TEXT_MAIN};">
  <!-- preheader -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:${BG_COLOR};line-height:1px;">${preheader}&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;</div>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:${BG_COLOR};min-width:100%;">
    <tr>
      <td align="center" style="padding:48px 16px 0;">

        <!-- Wordmark -->
        <div style="margin:0 0 32px;text-align:center;">
          <a href="${appUrl}" style="text-decoration:none;font-size:26px;font-weight:800;letter-spacing:-0.8px;font-family:${FONT};color:${INK};">${APP_NAME}</a>
        </div>

        <!-- Card -->
        <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="600" style="max-width:600px;width:100%;background:${CARD_BG};border-radius:20px;border:1px solid ${BORDER};overflow:hidden;">
          <tr><td style="padding:0;font-size:0;line-height:0;">${topBar(4)}</td></tr>
          <tr>
            <td class="card-pad" style="padding:48px 52px 44px;">
              ${body}
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="600" style="max-width:600px;width:100%;margin-top:32px;">
          <tr>
            <td style="padding:0 16px 56px;text-align:center;">
              <div style="width:28px;height:2px;background:${INK};margin:0 auto 18px;font-size:0;line-height:0;">&nbsp;</div>
              <p style="margin:0 0 8px;font-size:12px;color:${TEXT_MUTED};line-height:1.6;">
                &copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
              </p>
              <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.6;">
                <a href="${appUrl}/dashboard.html" style="color:${TEXT_MUTED};text-decoration:underline;">Dashboard</a>
                &nbsp;&middot;&nbsp;
                <a href="${appUrl}/privacy.html" style="color:${TEXT_MUTED};text-decoration:underline;">Privacy</a>
                &nbsp;&middot;&nbsp;
                <a href="${appUrl}/terms.html" style="color:${TEXT_MUTED};text-decoration:underline;">Terms</a>
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * CTA button: solid black, white text.
 */
function ctaButton({ href, label }) {
  return `
  <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:36px 0 36px;">
    <tr>
      <td align="left" bgcolor="${INK}" style="border-radius:12px;background-color:${INK};">
        <a href="${String(href).replace(/&(?!amp;)/g, '&amp;')}" style="display:inline-block;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:16px 36px;border-radius:12px;letter-spacing:0.2px;line-height:1;">
          ${label}
        </a>
      </td>
    </tr>
  </table>`;
}

/** A quieter second link under the main button, for a different place that also needs the owner. */
function textLink({ href, label }) {
  return `<p style="margin:-20px 0 32px;font-size:14px;line-height:1.6;"><a href="${String(href).replace(/&(?!amp;)/g, '&amp;')}" style="color:${TEXT_MAIN};font-weight:600;text-decoration:underline;">${label}</a></p>`;
}

/** Soft divider */
const divider = `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:32px 0;"><tr><td style="border-top:1px solid ${BORDER};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;

/** Heading + intro paragraph used at the top of every email. */
const heading = text => `<h1 style="margin:0 0 12px;font-size:28px;font-weight:800;color:${TEXT_MAIN};letter-spacing:-0.6px;line-height:1.2;">${text}</h1>`;
const intro   = text => `<p style="margin:0 0 32px;font-size:15px;color:${TEXT_MUTED};line-height:1.7;">${text}</p>`;

/** Tinted note box with a coloured left edge. */
function callout({ color, tint, html }) {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 24px;"><tr>
    <td style="background:${tint};border-left:4px solid ${color};border-radius:12px;padding:18px 20px;font-size:14px;color:${TEXT_MAIN};line-height:1.7;">${html}</td>
  </tr></table>`;
}

/**
 * ── PASSWORD RESET EMAIL ─────────────────────────────────────────────────────
 */
function passwordReset({ name = 'there', resetUrl, appUrl = 'https://humarains.com' }) {
  const body = `
    ${heading('Reset your password')}
    <p style="margin:0;font-size:15px;color:${TEXT_MUTED};line-height:1.7;">
      Hi ${esc(name)}, we received a request to reset the password for your humarains account.
      Click the button below to choose a new one. This link expires in&nbsp;<strong style="color:${TEXT_MAIN};">1&nbsp;hour</strong>.
    </p>

    ${ctaButton({ href: resetUrl, label: 'Reset my password' })}

    ${divider}

    <p style="margin:0 0 10px;font-size:13px;color:${TEXT_MUTED};line-height:1.6;">
      If the button above does not work, copy and paste this link into your browser:
    </p>
    <p style="margin:0 0 28px;font-size:12px;line-height:1.6;">
      <a href="${resetUrl}" style="color:${INK};text-decoration:underline;word-break:break-all;">${resetUrl}</a>
    </p>

    ${callout({ color: INK, tint: SOFT, html: `<span style="font-size:13px;color:${TEXT_MUTED};">If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.</span>` })}
  `;

  return {
    subject: 'Reset your humarains password',
    html: wrap({ preheader: 'Use the link inside to reset your humarains password. Valid for 1 hour.', body, appUrl }),
  };
}

/**
 * ── MORNING BRIEFING ─────────────────────────────────────────────────────────
 * Sent once a day by services/agent/proactive.js when there is something worth saying.
 * data: { newLeads, replied, won, wonValue, waiting, opportunities: [{title,count,estValue,rationale}] }
 */
function dailyBriefing({ name = 'there', business = '', data = {}, currency = 'USD', appUrl = 'https://humarains.com', link = null, secondaryLink = null }) {
  const sym = currency === 'USD' ? '$' : (currency ? currency + ' ' : '');
  const opps = Array.isArray(data.opportunities) ? data.opportunities.slice(0, 4) : [];
  const potential = opps.reduce((s, o) => s + (o.estValue || 0), 0);

  // Three white stat tiles, each with its own colour on top.
  const tile = (n, label) => `<td class="stat-cell" width="31%" valign="top" style="width:31%;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:${CARD_BG};border:1px solid ${BORDER};border-top:4px solid ${INK};border-radius:14px;">
        <tr><td style="padding:20px 12px 18px;text-align:center;">
          <div style="font-size:30px;font-weight:800;color:${TEXT_MAIN};line-height:1.1;letter-spacing:-0.5px;">${esc(n)}</div>
          <div style="font-size:11px;font-weight:600;color:${TEXT_MUTED};margin-top:8px;letter-spacing:0.6px;text-transform:uppercase;">${esc(label)}</div>
        </td></tr>
      </table></td>`;
  const gap = '<td class="stat-gap" width="14" style="width:14px;min-width:14px;font-size:0;line-height:0;">&nbsp;</td>';
  const wonLabel = data.won ? 'won' : 'jobs won';
  const wonValue = data.won ? (data.wonValue ? sym + Math.round(data.wonValue).toLocaleString('en-US') : data.won + ' won') : '0';

  const oppRows = opps.map((o, i) => `
    <tr><td style="padding:18px 0;${i < opps.length - 1 ? `border-bottom:1px solid ${BORDER};` : ''}">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>
        <td width="24" valign="top" style="width:24px;font-size:16px;line-height:22px;color:${INK};">&#9679;</td>
        <td valign="top">
          <div style="font-size:15px;font-weight:700;color:${TEXT_MAIN};line-height:1.4;">${esc(o.title)} <span style="color:${TEXT_MUTED};font-weight:400;">&middot; ${o.count} ${o.count === 1 ? 'person' : 'people'}${o.estValue ? ' &middot; about ' + esc(sym) + Number(o.estValue).toLocaleString('en-US') : ''}</span></div>
          <div style="font-size:13px;color:${TEXT_MUTED};margin-top:6px;line-height:1.65;">${esc(o.rationale)}</div>
        </td>
      </tr></table>
    </td></tr>`).join('');

  const recovered = data.recovered && data.recovered.count
    ? callout({ color: INK, tint: SOFT, html: `<b>${data.recovered.count} ${data.recovered.count === 1 ? 'job' : 'jobs'}${data.recovered.value ? ' worth about ' + esc(sym) + Number(data.recovered.value).toLocaleString('en-US') : ''} won after a follow-up</b> from your Agent in the last ${data.recovered.days || 30} days.` })
    : '';
  // What the Agent did by itself overnight (agent_actions): the owner should never find out from a customer.
  const did = data.agentDid && data.agentDid.total ? data.agentDid : null;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const didParts = did ? [
    did.reengage && plural(did.reengage, 'follow-up', 'follow-ups'), did.discount && plural(did.discount, 'discount offer', 'discount offers'),
    did.missed_call && plural(did.missed_call, 'missed call texted back', 'missed calls texted back'),
    did.review && plural(did.review, 'review request', 'review requests'), did.winback && plural(did.winback, 'win-back check-in', 'win-back check-ins')].filter(Boolean) : [];
  const agentDid = did
    ? callout({ color: INK, tint: SOFT, html: `<b>Your Agent acted on its own:</b> ${esc(didParts.join(', '))}.${did.held ? ' ' + esc(plural(did.held, 'action was', 'actions were')) + ' held back by your limits or rules.' : ''}` })
    : '';
  const waiting = data.waiting
    ? callout({ color: INK, tint: SOFT, html: `<b>${data.waiting} ${data.waiting === 1 ? 'item needs' : 'items need'} you:</b> drafted replies or leads the Agent handed over for a personal answer.` })
    : '';
  const oppBlock = opps.length ? `
    <h2 style="margin:36px 0 8px;font-size:18px;font-weight:800;color:${TEXT_MAIN};letter-spacing:-0.3px;line-height:1.3;">Ready for your OK${potential ? ' &mdash; about ' + esc(sym) + Math.round(potential).toLocaleString('en-US') + ' in play' : ''}</h2>
    <p style="margin:0 0 8px;font-size:13px;color:${TEXT_MUTED};line-height:1.7;">I found these on my own and wrote the follow-ups. Nothing is sent until you approve.</p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">${oppRows}</table>` : '';

  const body = `
    ${heading('Good morning, ' + esc(name))}
    ${intro('Here is what your Humarains Agent saw in the last 24 hours' + (business ? ' at ' + esc(business) : '') + '.')}
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 32px;"><tr>
      ${tile(data.newLeads || 0, 'new leads')}${gap}${tile(data.replied || 0, 'replies sent')}${gap}${tile(wonValue, wonLabel)}
    </tr></table>
    ${recovered}
    ${agentDid}
    ${waiting}
    ${oppBlock}
    ${ctaButton(link || { href: dashboardUrl(appUrl, opps.length ? { ask: 'opportunities' } : { view: 'leads' }), label: opps.length ? 'Review &amp; approve' : 'Open my leads' })}
    ${secondaryLink ? textLink(secondaryLink) : ''}
    <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.7;">Don't want this email? Open the Agent and say &ldquo;turn off my morning briefing&rdquo;.</p>
  `;
  const bits = [];
  if (data.newLeads) bits.push(`${data.newLeads} new lead${data.newLeads === 1 ? '' : 's'}`);
  if (opps.length) bits.push(`${opps.length} follow-up${opps.length === 1 ? '' : 's'} ready`);
  if (data.waiting) bits.push(`${data.waiting} need${data.waiting === 1 ? 's' : ''} you`);
  return {
    subject: `Your morning briefing${bits.length ? ': ' + bits.join(', ') : ''}`,
    html: wrap({ preheader: bits.join(' · ') || 'What your Agent saw overnight.', body, appUrl }),
  };
}

/**
 * Owner alert: customers are waiting on the owner. Short, one action, no lead text.
 * counts: { stuckApprovals, needsYou, unanswered }, oldestHours, names: [string]
 */
function ownerAlert({ name = 'there', business = '', counts = {}, oldestHours = 0, names = [], appUrl = 'https://humarains.com', link = null }) {
  const stuck = counts.stuckApprovals || 0, needs = counts.needsYou || 0, un = counts.unanswered || 0;
  const total = stuck + needs + un;
  const wait = oldestHours >= 24 ? Math.round(oldestHours / 24) + ' day' + (Math.round(oldestHours / 24) === 1 ? '' : 's') : oldestHours + ' hour' + (oldestHours === 1 ? '' : 's');

  // One row per kind of waiting item, each with its own colour dot and a big number.
  const row = (n, text, last) => `<tr><td style="padding:16px 0;${last ? '' : `border-bottom:1px solid ${BORDER};`}">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>
        <td width="56" valign="middle" style="width:56px;"><div style="font-size:26px;font-weight:800;color:${INK};line-height:1;letter-spacing:-0.5px;">${n}</div></td>
        <td valign="middle" style="font-size:14px;color:${TEXT_MAIN};line-height:1.6;">${text}</td>
      </tr></table></td></tr>`;
  const items = [];
  if (needs) items.push([needs, `${needs === 1 ? 'conversation needs' : 'conversations need'} a personal answer from you`]);
  if (stuck) items.push([stuck, `drafted ${stuck === 1 ? 'reply is' : 'replies are'} waiting for your OK`]);
  if (un)    items.push([un, `${un === 1 ? 'message has' : 'messages have'} not been answered yet`]);
  const rows = items.map(([n, t], i) => row(n, t, i === items.length - 1)).join('');
  const who = names.length
    ? `<p style="margin:20px 0 0;font-size:13px;color:${TEXT_MUTED};line-height:1.7;">Including ${names.map(esc).join(', ')}${total > names.length ? ' and ' + (total - names.length) + ' more' : ''}.</p>`
    : '';

  const body = `
    ${heading((total === 1 ? 'A customer is' : total + ' customers are') + ' waiting, ' + esc(name))}
    <div style="margin:0 0 16px;"><span style="display:inline-block;padding:7px 14px;border-radius:999px;background:${SOFT};border:1px solid ${BORDER};color:${INK};font-size:12px;font-weight:700;letter-spacing:0.2px;">Longest wait: about ${esc(wait)}</span></div>
    ${intro('Customers who hear back quickly are far more likely to book' + (business ? ' at ' + esc(business) : '') + '.')}
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};">${rows}</table>
    ${who}
    ${ctaButton(link || { href: dashboardUrl(appUrl, { view: needs ? 'humanreview' : stuck ? 'consent' : 'leads' }), label: needs ? 'Open Human Review' : stuck ? 'Review the drafts' : 'Open my leads' })}
    <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.7;">At most two of these a day, never at night. Open the Agent and say &ldquo;turn off urgent alerts&rdquo; to stop them.</p>
  `;
  return {
    subject: total === 1 ? `A customer has been waiting ${wait} for a reply` : `${total} customers are waiting on you`,
    html: wrap({ preheader: `Longest wait: ${wait}.`, body, appUrl }),
  };
}

/**
 * ── PAYMENT FAILED ───────────────────────────────────────────────────────────
 * One clear action. The link opens the dashboard, which takes them straight to the card update.
 */
function paymentFailed({ name = 'there', appUrl = 'https://humarains.com' }) {
  const body = `
    ${heading('Your payment did not go through')}
    ${intro(`Hi ${esc(name)}, we could not charge your card for Humarains. This is usually an expired card or a bank block, and it takes about a minute to fix.`)}
    ${callout({ color: INK, tint: SOFT, html: 'Your account is <strong>still active</strong> and your AI keeps replying to customers while we retry the payment. Update your card soon so nothing is interrupted.' })}
    ${ctaButton({ href: `${appUrl}/dashboard.html?billing=fix`, label: 'Update payment method' })}
    <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.7;">If you already updated your card, you can ignore this email.</p>
  `;
  return { subject: 'Action needed: your Humarains payment did not go through', html: wrap({ preheader: 'Your account is still active. Update your card to keep it that way.', body, appUrl }) };
}

/**
 * ── SUBSCRIPTION ENDED (win-back) ────────────────────────────────────────────
 */
function subscriptionEnded({ name = 'there', appUrl = 'https://humarains.com' }) {
  const body = `
    ${heading('Your plan has ended')}
    ${intro(`Hi ${esc(name)}, your Humarains subscription has ended and your account is now on the free plan (10 AI replies a month).`)}
    ${callout({ color: INK, tint: SOFT, html: 'Your leads, conversations and business settings are all still here. If you come back, everything picks up exactly where you left off.' })}
    ${ctaButton({ href: dashboardUrl(appUrl, { view: 'payment' }), label: 'Restart my plan' })}
    <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.7;">If something was missing or not working, just reply to this email and tell us. We read every reply.</p>
  `;
  return { subject: 'Your Humarains plan has ended, your data is safe', html: wrap({ preheader: 'Your leads and settings are kept if you want to come back.', body, appUrl }) };
}

/**
 * ── FINISH SETUP (first week) ────────────────────────────────────────────────
 * `gaps` is a list of plain-language things still missing. Only real gaps are listed.
 */
function setupNudge({ name = 'there', gaps = [], second = false, appUrl = 'https://humarains.com', link = null }) {
  const rows = gaps.map((g, i) => `<tr><td style="padding:14px 0;${i === gaps.length - 1 ? '' : `border-bottom:1px solid ${BORDER};`}font-size:14px;color:${TEXT_MAIN};line-height:1.6;">${esc(g)}</td></tr>`).join('');
  const body = `
    ${heading(second ? 'Your AI is still waiting to start' : 'Two minutes to get your AI working')}
    ${intro(`Hi ${esc(name)}, Humarains only starts winning you customers once it can see your enquiries. ${gaps.length === 1 ? 'One thing is' : 'A few things are'} still missing:`)}
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};">${rows}</table>
    ${ctaButton(link || { href: dashboardUrl(appUrl), label: 'Finish setup' })}
    <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.7;">${second ? 'This is the last reminder we will send about setup.' : 'Stuck on something? Just reply to this email.'}</p>
  `;
  return { subject: second ? 'Your Humarains AI is not running yet' : 'Finish setting up Humarains', html: wrap({ preheader: 'A couple of quick steps and your AI starts replying to customers.', body, appUrl }) };
}

/**
 * Sent by the workflow step "Alert me". One lead, one button that opens that lead.
 * lead: { name, contact, service, summary }, note: the owner's own text, link: { href, label }
 */
function leadAlert({ subject = 'A lead needs your attention', note = '', lead = {}, link = null, appUrl = 'https://humarains.com' }) {
  const row = (k, v) => v ? `<tr><td style="padding:10px 0;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT_MUTED};width:96px;" valign="top">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid ${BORDER};font-size:14px;color:${TEXT_MAIN};line-height:1.6;" valign="top">${esc(v)}</td></tr>` : '';
  const body = `
    ${heading(esc(subject))}
    ${intro(esc(note || 'One of your automations flagged this lead for you.'))}
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-top:1px solid ${BORDER};">
      ${row('Customer', lead.name)}${row('Contact', lead.contact)}${row('Service', lead.service)}${row('Summary', lead.summary)}
    </table>
    ${ctaButton(link || { href: dashboardUrl(appUrl, { view: 'leads' }), label: 'Open my leads' })}
    <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.7;">You are getting this because an automation has an "Alert me" step. Edit it in Workflows.</p>
  `;
  return { subject, html: wrap({ preheader: note || 'An automation flagged a lead for you.', body, appUrl }) };
}

/**
 * ── HANDOVER ─────────────────────────────────────────────────────────────────
 * handoverNotice: the AI hands a conversation to a person on the team, with the lead's phone number
 * and email so they can take it from here. Also used (kind 'message') when the customer writes again after the handover.
 *
 * lead: { name, phone, email, channel, service, urgency, summary, quote }
 * history: [{ who: 'Customer' | 'Us', text }]   (the last few turns, already trimmed)
 */
function handoverNotice({ kind = 'handover', toName = '', lead = {}, reason = '', history = [], message = '', copyNote = '', link = null, appUrl = 'https://humarains.com' }) {
  const digits = String(lead.phone || '').replace(/[^\d+]/g, '');
  const waDigits = digits.replace(/^\+/, '');
  const phoneHtml = lead.phone
    ? `<a href="tel:${esc(digits)}" style="color:${TEXT_MAIN};font-weight:700;text-decoration:none;">${esc(lead.phone)}</a>`
      + (lead.channel === 'whatsapp' && waDigits ? ` &nbsp;<a href="https://wa.me/${esc(waDigits)}" style="color:${TEXT_MUTED};font-size:13px;">Open in WhatsApp</a>` : '')
    : '';
  const emailHtml = lead.email ? `<a href="mailto:${esc(lead.email)}" style="color:${TEXT_MAIN};font-weight:700;text-decoration:none;">${esc(lead.email)}</a>` : '';
  const row = (k, vHtml) => vHtml ? `<tr><td style="padding:10px 0;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT_MUTED};width:96px;" valign="top">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid ${BORDER};font-size:14px;color:${TEXT_MAIN};line-height:1.6;" valign="top">${vHtml}</td></tr>` : '';
  const isMsg = kind === 'message';
  const who = lead.name || 'a customer';
  const title = isMsg ? `${esc(who)} replied` : `${esc(who)} is ready for you`;
  const lede = isMsg
    ? `${esc(who)} wrote again on the conversation handed to you. The AI is no longer replying, so this one is yours.`
    : `${toName ? 'Hi ' + esc(toName) + ', t' : 'T'}he AI has taken this conversation as far as it should and is handing it to you. They are close to booking, so please contact them yourself now.`;
  const hist = (history || []).slice(-6).map(h => `<tr><td style="padding:6px 0;font-size:13px;line-height:1.6;color:${TEXT_MAIN};"><strong style="color:${TEXT_MUTED};font-weight:600;">${esc(h.who)}:</strong> ${esc(h.text)}</td></tr>`).join('');
  const body = `
    ${heading(title)}
    ${intro(lede)}
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-top:1px solid ${BORDER};">
      ${row('Phone', phoneHtml)}${row('Email', emailHtml)}${row('Customer', esc(lead.name || ''))}${row('Channel', esc(lead.channel === 'whatsapp' ? 'WhatsApp' : 'Email'))}
      ${row('Service', esc(lead.service || ''))}${row('Urgency', esc(lead.urgency || ''))}${row('Quote', esc(lead.quote || ''))}${row('Summary', esc(lead.summary || ''))}${row('Why now', esc(reason || ''))}
    </table>
    ${isMsg && message ? `<p style="margin:24px 0 8px;font-size:13px;color:${TEXT_MUTED};">Their message</p>${quote(message)}` : ''}
    ${!isMsg && hist ? `<p style="margin:24px 0 8px;font-size:13px;color:${TEXT_MUTED};">Latest in the conversation</p><table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">${hist}</table>` : ''}
    ${ctaButton(link || { href: dashboardUrl(appUrl, { view: 'leads' }), label: 'Open the full conversation' })}
    <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.7;">${esc(copyNote || 'Reply to the customer yourself from here on. The AI will not send them any more messages unless the owner gives the conversation back to it.')}</p>
  `;
  const subject = isMsg ? `${who} replied: pick this up` : `Handover: ${who} is ready to book`;
  return { subject, html: wrap({ preheader: esc(isMsg ? `${who} wrote again.` : `${who} is ready. ${lead.phone || lead.email || ''}`.trim()), body, appUrl }) };
}


/**
 * ── SUPPORT ──────────────────────────────────────────────────────────────────
 * supportReply: the admin answered an owner's message on the Support page.
 * supportAdminNotice: an owner wrote to the admin (sent to ADMIN_EMAIL).
 */
const quote = text => `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 8px;"><tr>
    <td style="background:${SOFT};border-left:4px solid ${INK};border-radius:12px;padding:18px 20px;font-size:14px;color:${TEXT_MAIN};line-height:1.7;white-space:pre-wrap;">${esc(text)}</td>
  </tr></table>`;

function supportReply({ name = 'there', subject = '', message = '', appUrl = 'https://humarains.com' }) {
  const body = `
    ${heading('We replied to your message')}
    ${intro(`Hi ${esc(name)}, here is our answer about &ldquo;${esc(subject)}&rdquo;.`)}
    ${quote(message)}
    ${ctaButton({ href: dashboardUrl(appUrl, { view: 'support' }), label: 'Open the conversation' })}
    <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.7;">Reply from the Support page in your dashboard and we will see it there. Replies to this email are not read.</p>
  `;
  return { subject: `Re: ${String(subject).slice(0, 120)}`, html: wrap({ preheader: 'We replied to your message.', body, appUrl }) };
}

function supportAdminNotice({ from = 'A user', email = '', subject = '', message = '', isNew = true, appUrl = 'https://humarains.com' }) {
  const body = `
    ${heading(isNew ? 'New support message' : 'New reply on a support message')}
    ${intro(`${esc(from)}${email ? ' (' + esc(email) + ')' : ''} wrote about &ldquo;${esc(subject)}&rdquo;.`)}
    ${quote(message)}
    <p style="margin:24px 0 0;font-size:14px;color:${TEXT_MAIN};line-height:1.7;">Answer it from the Support tab in the admin panel.</p>
  `;
  return { subject: `${isNew ? 'Support' : 'Support reply'}: ${String(subject).slice(0, 120)}`, html: wrap({ preheader: esc(String(message).replace(/\s+/g, ' ').slice(0, 90)), body, appUrl }) };
}

module.exports = { leadAlert, handoverNotice, passwordReset, dailyBriefing, ownerAlert, paymentFailed, subscriptionEnded, setupNudge, supportReply, supportAdminNotice };
