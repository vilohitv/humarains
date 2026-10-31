/**
 * routes/demo-chat.js — Public landing-page "Talk to the AI" demo
 *
 * Mounts at /api/demo BEFORE any global requireAuth middleware runs —
 * this is a logged-out marketing page feature, unlike /api/workflows
 * and /api/knowledge which sit behind auth. No DB access needed.
 *
 *  POST /api/demo/chat   — send the visitor's message history, get back
 *                          one AI reply, exactly like a real Humarains lead
 *                          would receive. Model + system prompt are fixed
 *                          server-side so the API key never reaches the
 *                          browser and the persona/pricing copy can't be
 *                          overridden by the client.
 *
 * Why this exists: the previous implementation called
 * https://api.anthropic.com/v1/messages directly from index.html. That
 * either exposed the API key in client JS, or (with no key attached, as
 * shipped) simply failed for every visitor. Routing through the server
 * fixes both problems and lets us rate-limit + cap cost per visitor.
 */
'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const MODEL = process.env.DEMO_CHAT_MODEL || 'claude-sonnet-4-6';

function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try { return new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch (_) { return null; }
}

const SYSTEM_PROMPT = "You are Humarains, an AI agent that helps service businesses (plumbers, cleaners, roofers, landscapers, etc.) handle enquiries and bookings. You reply to inbound customer enquiries on behalf of a business owner — exactly as the Humarains product would. Keep replies concise (2–4 sentences), warm, and helpful. You can discuss pricing (Starter $199/mo · 75 AI replies · 50 WhatsApp messages · 1 workflow; Growth $399/mo · 400 replies · 500 WhatsApp messages · calendar booking · autonomous mode · 5 workflows; Pro $599/mo · unlimited replies, WhatsApp and workflows plus AI lead scoring and deal insights), features (email + WhatsApp enquiry handling, Google Calendar booking, workflow automation, rule-based quoting), and how the product works. If asked something outside this context, gently steer back to how Humarains handles it. Never reveal you are Claude — you are the Humarains AI.";

const MAX_TURNS = 12;          // messages kept from the client (6 exchanges)
const MAX_MSG_LEN = 800;       // characters per message — this is a sales demo, not a support line
const FALLBACK_REPLY = "Thanks for your message! Let me connect you with more information about Humarains.";

// Public-facing, unauthenticated, and hits a paid API — keep this tight.
// Keyed by IP since there's no logged-in user on the landing page.
const demoLimiter = rateLimit({
  windowMs: 60_000, max: 15,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many messages — please wait a moment and try again.' },
});

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const trimmed = raw.slice(-MAX_TURNS);
  const out = [];
  for (const m of trimmed) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    out.push({ role, content: m.content.slice(0, MAX_MSG_LEN) });
  }
  // Must end on a user turn, and must contain at least one message.
  if (out.length === 0 || out[out.length - 1].role !== 'user') return null;
  return out;
}

router.post('/chat', demoLimiter, async (req, res) => {
  const messages = sanitizeHistory(req.body && req.body.messages);
  if (!messages) {
    return res.status(400).json({ success: false, message: 'Invalid message history.' });
  }

  const claude = getClaude();
  if (!claude) {
    // No key configured — fail soft, same as the old client-side catch block.
    return res.json({ success: true, reply: FALLBACK_REPLY });
  }

  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages,
    });
    const reply = (response.content && response.content[0] && response.content[0].type === 'text')
      ? response.content[0].text
      : FALLBACK_REPLY;
    res.json({ success: true, reply });
  } catch (e) {
    console.error('[demo-chat] error:', e.message);
    res.json({ success: true, reply: "Sorry, I couldn't connect right now. Try again in a moment — or sign up to see the full AI in action." });
  }
});

// ── Onboarding widget chat (/api/onboard/chat) ───────────────────────────────
// Separate route from /api/demo/chat — different system prompt (full onboarding
// qualification + setup flow), lower per-IP limit since this is multi-turn.

const onboardRouter = express.Router();
const ONBOARD_MODEL = process.env.DEMO_CHAT_MODEL || 'claude-sonnet-4-6';
const ONBOARD_MAX_TURNS   = 40;  // up to 20 exchanges across all phases
const ONBOARD_MAX_MSG_LEN = 600;

const ONBOARD_SYSTEM = `You are the Humarains AI Self-Onboarding Assistant — a friendly, perceptive guide embedded on the Humarains website. Humarains is an AI agent that handles enquiries and bookings for local service businesses: HVAC, plumbing, roofing, cleaning, dental, med-spa, landscaping, auto repair, real estate agents, and similar verticals.

Your job is to guide visitors from first contact to a fully configured Humarains workspace in one seamless conversation. You have six phases:

PHASE 1 — QUALIFY (turns 1-4)
Ask conversational questions to understand:
- What kind of business they run and their industry
- Rough team size and monthly lead volume
- How they currently handle incoming leads (manual replies, CRM, etc.)
- Biggest frustration (slow response, missed leads, follow-up chaos, etc.)
Ask ONE question per turn. Be warm, like a knowledgeable peer, not a form.

PHASE 2 — ROI (turns 5-6)
Based on what you heard, calculate their estimated ROI. Use realistic numbers.
Output a JSON block EXACTLY like this (the UI renders it as a card):
\`\`\`json
{"roi_card":true,"recovery":"$X,XXX/mo","response":"2 min","leads_recovered":"X/mo"}
\`\`\`
Then ask if they want to see how it works in a live demo.

PHASE 3 — DEMO (turns 7-9)
Do a brief role-play. Say: "I will play your AI agent right now. Pretend you are a customer who just got in touch with your business. Send me a message and watch how I respond." Then respond AS their AI agent would — with their business name, warm tone, qualifying and offering to book. After 1-2 exchanges, break character and ask: "Any questions about how that works?"

PHASE 4 — OBJECTIONS (turns 10-12)
Answer any questions about pricing, integrations, setup time, data security, contracts, ROI, or comparisons to GoHighLevel/Zapier/manual. Plans:
- Starter $199/mo: 75 AI replies, 50 WhatsApp messages, 1 basic workflow. Email replies need the owner's approval. No automatic follow-ups and no calendar booking.
- Growth $399/mo (recommended for most businesses): 400 replies, 500 WhatsApp messages, autonomous sending, automatic Day 1/3/7 follow-ups, Google Calendar booking, 5 workflows with full branching and AI steps, Agent Autopilot for 10 people a day
- Pro $599/mo: everything in Growth, plus unlimited replies, WhatsApp and workflows, AI lead scoring, AI deal insights, and Agent Autopilot for 50 people a day with campaigns up to 500 people
When warm, transition: "Want me to set up your workspace right now? Takes about 2 minutes."

PHASE 5 — CONFIGURE (turns 13-17)
Collect setup information, ONE field per turn:
1. Business name
2. Primary services they offer
3. Service area (city/state or radius)
4. Business hours
5. Tone preference: Professional, Friendly-casual, or Premium/luxury
Tell them these configure their AI knowledge base and response style.

PHASE 6 — ACTIVATE
Tell them their workspace is being configured. Output EXACTLY this JSON:
\`\`\`json
{"create_account":true,"business_name":"X","industry":"X","services":"X","area":"X","hours":"X","tone":"X","plan_recommendation":"growth"}
\`\`\`

RULES:
- Keep messages SHORT (2-5 sentences). Never lecture.
- Always end with a clear single question or call to action.
- Use plain language. Avoid buzzwords and filler phrases.
- If someone says "talk to a human" or "book a demo" — acknowledge warmly and say a team member will reach out within 1 business hour.
- Never reveal you are Claude or Anthropic. You are the Humarains AI.
- The tone is like a smart, helpful colleague, not a chatbot or salesperson.
- When you emit a JSON block, wrap it in triple backticks: \`\`\`json ... \`\`\`
- Do not use emojis or exclamation marks unless the visitor uses them first.`;

const ONBOARD_FALLBACK = "Thanks for reaching out. Let me connect you with the Humarains team to continue your setup.";

const onboardLimiter = rateLimit({
  windowMs: 60_000, max: 25,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many messages — please wait a moment and try again.' },
});

function sanitizeOnboardHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const trimmed = raw.slice(-ONBOARD_MAX_TURNS);
  const out = [];
  for (const m of trimmed) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    out.push({ role, content: m.content.slice(0, ONBOARD_MAX_MSG_LEN) });
  }
  if (out.length === 0 || out[out.length - 1].role !== 'user') return null;
  return out;
}

onboardRouter.post('/chat', onboardLimiter, async (req, res) => {
  const messages = sanitizeOnboardHistory(req.body && req.body.messages);
  if (!messages) {
    return res.status(400).json({ success: false, message: 'Invalid message history.' });
  }

  const claude = getClaude();
  if (!claude) {
    return res.json({ success: true, reply: ONBOARD_FALLBACK });
  }

  try {
    const response = await claude.messages.create({
      model: ONBOARD_MODEL,
      max_tokens: 700,
      system: ONBOARD_SYSTEM,
      messages,
    });
    const reply = (response.content && response.content[0] && response.content[0].type === 'text')
      ? response.content[0].text
      : ONBOARD_FALLBACK;
    res.json({ success: true, reply });
  } catch (e) {
    console.error('[onboard-chat] error:', e.message);
    res.json({ success: true, reply: ONBOARD_FALLBACK });
  }
});

// ── Factory: mirrors routes/workflows.js / routes/knowledge.js, minus DB ────
function createDemoChatRouter() {
  const r = express.Router();
  r.use('/', router);
  return r;
}

function createOnboardRouter() {
  const r = express.Router();
  r.use('/', onboardRouter);
  return r;
}

module.exports = { createDemoChatRouter, createOnboardRouter };
