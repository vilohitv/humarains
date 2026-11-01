#!/usr/bin/env node
// Run from the repo root:  node apply-practice-enquiry-fix.js
// Makes the onboarding "practice enquiry" always produce a reply, even before any services are configured.
// Each edit must match exactly once, or nothing is written. Backups are saved as *.bak.
const fs = require('fs');

const EDITS = [
  { file: 'src/services/leads/engine.js',
    find: `async function processLead(claude, model, rawLead, businessContext, agentMode = 'autonomous') {
  const lead = normalizeLead(rawLead);
  lead.agentModeSnapshot = agentMode;

  // Step 1: Qualify
  const qualification = await qualifyLead(claude, model, lead, businessContext);
  lead.qualification   = qualification;`,
    replace: `async function processLead(claude, model, rawLead, businessContext, agentMode = 'autonomous', opts = {}) {
  const lead = normalizeLead(rawLead);
  lead.agentModeSnapshot = agentMode;
  // Practice enquiry (onboarding): the sample is written by us, so it is always a genuine lead and must not be
  // held back for human review just because the business profile is still thin.
  const practice = !!(opts && opts.practice);

  // Step 1: Qualify
  const qualification = practice
    ? { isLead: true, confidence: 1, reason: 'practice_enquiry', senderType: 'customer', urgencyLevel: 'none', serviceMatch: null, buyingSignals: [], preflightHit: true }
    : await qualifyLead(claude, model, lead, businessContext);
  lead.qualification   = qualification;` },
  { file: 'src/services/leads/engine.js',
    find: `    assessHumanReviewNeeded(claude, model, lead, extracted, businessContext, initialHistory),
    Promise.resolve(calculateQuote(extracted, businessContext)),`,
    replace: `    practice
      ? { needed: false, reason: null, confidence: 1, escalationType: null }
      : assessHumanReviewNeeded(claude, model, lead, extracted, businessContext, initialHistory),
    Promise.resolve(calculateQuote(extracted, businessContext)),` },
  { file: 'src/services/leads/engine.js',
    find: `  const sufficiency = await checkKnowledgeSufficiency(claude, model, lead, extracted, businessContext);`,
    replace: `  const sufficiency = practice
    ? { sufficient: true, missingInfo: [] }
    : await checkKnowledgeSufficiency(claude, model, lead, extracted, businessContext);` },
  { file: 'src/routes/leads.js',
    find: `  const sample = TEST_LEAD_SAMPLES[Math.floor(Math.random() * TEST_LEAD_SAMPLES.length)];
  const businessContext = await getSettings(req.user.id, req._db);`,
    replace: `  const sample = { ...TEST_LEAD_SAMPLES[Math.floor(Math.random() * TEST_LEAD_SAMPLES.length)] };
  const businessContext = await getSettings(req.user.id, req._db);
  // Mention what the business does so the practice enquiry reads like a real customer, even before services are added.
  const bType = String(businessContext.businessType || '').trim();
  if (bType && bType !== 'local service business') {
    sample.subject = 'Enquiry about ' + bType.slice(0, 60);
    sample.body = "Hi, I found your business online and I'm interested in what you offer (" + bType.slice(0, 80) + "). Could someone get in touch with me about next steps? Thanks!";
  }` },
  { file: 'src/routes/leads.js',
    find: `    }, businessContext);

    await storeLead(req.user.id, processed, req._db);
    console.log(\`[Leads] Created onboarding test lead`,
    replace: `    }, businessContext, 'autonomous', { practice: true });

    await storeLead(req.user.id, processed, req._db);
    console.log(\`[Leads] Created onboarding test lead` },
];

const files = {};
for (const e of EDITS) {
  if (!files[e.file]) {
    if (!fs.existsSync(e.file)) { console.error('Not found: ' + e.file + '. Run this from the repo root.'); process.exit(1); }
    files[e.file] = fs.readFileSync(e.file, 'utf8');
  }
  const n = files[e.file].split(e.find).length - 1;
  if (n !== 1) { console.error(`Edit failed in ${e.file}: expected 1 match, found ${n}. Nothing was changed.\nLooking for:\n${e.find.slice(0, 120)}...`); process.exit(1); }
}
for (const e of EDITS) files[e.file] = files[e.file].replace(e.find, () => e.replace);
for (const f of Object.keys(files)) { fs.copyFileSync(f, f + '.bak'); fs.writeFileSync(f, files[f]); console.log('Updated ' + f + ' (backup: ' + f + '.bak)'); }
console.log('Done. Restart the server, then run the practice enquiry again.');
