/**
 * services/agent/handover-tools.js — the Agent can set up and run human handover from chat.
 *
 *   get_handover_settings     the switch, the moments, the team
 *   update_handover_settings  switch on/off, choose the moments, copy the owner
 *   add_handover_person       add (or update) a person and the jobs they handle
 *   remove_handover_person    take someone off the team
 *   handover_lead             hand one conversation to a person now
 *   resume_lead_ai            give a handed-over conversation back to the AI
 *
 * Everything goes through services/handover.js (validateConfig, normalizeConfig, manualHandover, resumeAI), the
 * same code the Settings page and /api/leads/handover use, so chat and Settings can never disagree.
 */
'use strict';

module.exports = function createHandoverTools(h) {
  const { clip, compactLead, resolveLead, ambiguity, leadsApi } = h;
  const svc = () => require('../handover');

  const view = cfg => ({
    enabled: cfg.enabled,
    handOverWhen: cfg.stages,
    copyOwner: cfg.copyOwner,
    team: cfg.contacts.map(c => ({ name: c.name, role: c.role || null, email: c.email || null, phone: c.phone || null, jobs: c.jobs, handlesEverythingElse: c.isDefault })),
  });

  /** Validate a full config through the shared rules, then save it with the other business settings. */
  async function persist(ctx, next) {
    const v = svc().validateConfig(next);
    if (!v.ok) return { ok: false, error: v.error };
    await leadsApi().saveSettings(ctx.userId, { ...ctx.settings, ...v.config }, ctx.db);
    Object.assign(ctx.settings, v.config);
    ctx.profileUpdated = true;
    return { ok: true, cfg: svc().normalizeConfig(ctx.settings) };
  }
  const toBody = cfg => ({ enabled: cfg.enabled, stages: cfg.stages, contacts: cfg.contacts, copyOwner: cfg.copyOwner });
  const findPerson = (cfg, name) => {
    const n = String(name || '').toLowerCase().trim();
    if (!n) return null;
    return cfg.contacts.find(c => c.name.toLowerCase() === n) || cfg.contacts.find(c => c.name.toLowerCase().includes(n)) || null;
  };

  const STAGES = ['quoted', 'booking_requested', 'deal_closed'];

  const TOOL_DEFS = [
    { name: 'get_handover_settings',
      description: 'Show how human handover is set up: whether it is on, at which moments the AI passes a customer to a person (a quote was sent, they want to book, they said yes), and the team with the jobs each person handles. Call it before changing anything and when the owner asks who gets handed leads.',
      input_schema: { type: 'object', properties: {} } },
    { name: 'update_handover_settings',
      description: 'Switch human handover on or off, choose the moments it happens, or choose whether the owner is copied. Handover means the AI stops replying and a person on the team takes the conversation, with the customer\'s phone and email. Only change what the owner asked. Turning it on with nobody on the team means handovers come to the owner; say so.',
      input_schema: { type: 'object', properties: {
        enabled:    { type: 'boolean', description: 'true to switch handover on, false to switch it off.' },
        hand_over_when: { type: 'array', items: { type: 'string', enum: STAGES }, description: 'quoted = a quote was sent; booking_requested = they want to book (recommended); deal_closed = they said yes. Replaces the current list.' },
        copy_owner: { type: 'boolean', description: 'Copy the owner on every handover email.' },
      } } },
    { name: 'add_handover_person',
      description: 'Add a person to the handover team, or update them if the name is already there. Each person needs a name and an email or phone number. "jobs" are the services they handle (for example roof repair, gutters); the AI matches the customer\'s job to a person. Only save details the OWNER gave you. Max 20 people.',
      input_schema: { type: 'object', properties: {
        name:  { type: 'string' },
        role:  { type: 'string', description: 'Optional, e.g. Roofing lead.' },
        email: { type: 'string' },
        phone: { type: 'string', description: 'Include the country code if the owner gave it.' },
        jobs:  { type: 'array', items: { type: 'string' }, description: 'Jobs this person handles. When updating, these replace their current jobs; use add_jobs to keep them.' },
        add_jobs: { type: 'array', items: { type: 'string' }, description: 'Jobs to add to an existing person without removing the others.' },
        handles_everything_else: { type: 'boolean', description: 'This person gets every lead that matches nobody else. Only one person can have this.' },
      }, required: ['name'] } },
    { name: 'remove_handover_person',
      description: 'Take a person off the handover team. Leads already handed to them stay with them. Only when the owner asked.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    { name: 'handover_lead',
      description: 'Hand one lead\'s conversation to a person right now, at any stage. The person is emailed the customer\'s phone, email and the conversation so far, and the AI stops replying on that thread. Only when the owner asked to hand over, pass on or give a lead to someone. Leave person_name out to hand it to the owner.',
      input_schema: { type: 'object', properties: {
        lead_id:   { type: 'string', description: 'Lead id (from a previous result).' },
        lead_name: { type: 'string', description: 'Name, email or phone fragment if you have no id.' },
        person_name: { type: 'string', description: 'A person on the handover team. Omit for the owner.' },
      } } },
    { name: 'resume_lead_ai',
      description: 'Give a handed-over conversation back to the AI so it replies again. After this the AI will not hand that lead over again. Only when the owner asked.',
      input_schema: { type: 'object', properties: {
        lead_id:   { type: 'string' },
        lead_name: { type: 'string', description: 'Name, email or phone fragment if you have no id.' },
      } } },
  ];

  const HANDLERS = {
    async get_handover_settings(ctx) {
      const cfg = svc().normalizeConfig(ctx.settings);
      return { ok: true, ...view(cfg), services: (ctx.settings.services || []).map(s => s && s.name).filter(Boolean).slice(0, 30),
        note: cfg.contacts.length ? undefined : 'Nobody is on the team yet, so every handover comes to the owner.' };
    },

    async update_handover_settings(ctx, input) {
      const cfg = svc().normalizeConfig(ctx.settings);
      const body = toBody(cfg);
      const changed = [];
      if (typeof input.enabled === 'boolean') { body.enabled = input.enabled; changed.push(input.enabled ? 'switched handover on' : 'switched handover off'); }
      if (Array.isArray(input.hand_over_when)) {
        const st = [...new Set(input.hand_over_when.filter(s => STAGES.includes(s)))];
        if (!st.length) return { ok: false, error: 'Choose at least one moment: a quote was sent, they want to book, or they said yes.' };
        body.stages = st; changed.push('updated when it happens');
      }
      if (typeof input.copy_owner === 'boolean') { body.copyOwner = input.copy_owner; changed.push(input.copy_owner ? 'copying you on handovers' : 'no longer copying you'); }
      if (!changed.length) return { ok: false, error: 'Nothing to change. Say whether to switch it on or off, when it should happen, or whether to copy the owner.' };
      const out = await persist(ctx, body);
      if (!out.ok) return out;
      ctx.actions.push('Handover: ' + changed.join(', '));
      return { ok: true, ...view(out.cfg),
        note: out.cfg.enabled && !out.cfg.contacts.length ? 'Handover is on but nobody is on the team yet, so every handover comes to the owner.' : undefined };
    },

    async add_handover_person(ctx, input) {
      const name = clip(input.name, 80);
      if (!name) return { ok: false, error: 'A name is needed.' };
      const cfg = svc().normalizeConfig(ctx.settings);
      const body = toBody(cfg);
      const idx = body.contacts.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
      const prev = idx >= 0 ? body.contacts[idx] : null;
      const jobs = Array.isArray(input.jobs) ? input.jobs : (prev ? prev.jobs : []);
      const person = {
        id: prev ? prev.id : undefined,
        name,
        role:  input.role  !== undefined ? input.role  : (prev ? prev.role : ''),
        email: input.email !== undefined ? input.email : (prev ? prev.email : ''),
        phone: input.phone !== undefined ? input.phone : (prev ? prev.phone : ''),
        jobs: [...jobs, ...(Array.isArray(input.add_jobs) ? input.add_jobs : [])],
        isDefault: typeof input.handles_everything_else === 'boolean' ? input.handles_everything_else : !!(prev && prev.isDefault),
        active: true,
      };
      if (person.isDefault) body.contacts.forEach(c => { c.isDefault = false; });   // only one person handles everything else
      if (idx >= 0) body.contacts[idx] = person; else body.contacts.push(person);
      const out = await persist(ctx, body);
      if (!out.ok) return out;
      ctx.actions.push(`${idx >= 0 ? 'Updated' : 'Added'} ${name} on the handover team`);
      return { ok: true, [idx >= 0 ? 'updated' : 'added']: name, ...view(out.cfg),
        note: out.cfg.enabled ? undefined : 'Handover is still switched off, so nothing will be handed over yet. Offer to switch it on.' };
    },

    async remove_handover_person(ctx, input) {
      const cfg = svc().normalizeConfig(ctx.settings);
      const p = findPerson(cfg, input.name);
      if (!p) return { ok: false, error: `No one called ${clip(input.name, 60)} is on the handover team.`, team: cfg.contacts.map(c => c.name) };
      const body = toBody(cfg);
      body.contacts = body.contacts.filter(c => c.id !== p.id);
      const out = await persist(ctx, body);
      if (!out.ok) return out;
      ctx.actions.push(`Removed ${p.name} from the handover team`);
      return { ok: true, removed: p.name, ...view(out.cfg) };
    },

    async handover_lead(ctx, input) {
      const r = await resolveLead(ctx, input);
      const amb = ambiguity(r, input.lead_name); if (amb) return amb;
      const lead = r.lead;
      const cfg = svc().normalizeConfig(ctx.settings);
      let contactId = null;
      if (input.person_name) {
        const p = findPerson(cfg, input.person_name);
        if (!p) return { ok: false, error: `No one called ${clip(input.person_name, 60)} is on the handover team. Add them first with add_handover_person.`, team: cfg.contacts.map(c => c.name) };
        contactId = p.id;
      }
      const out = await svc().manualHandover({ db: ctx.db, user: ctx.user, lead, businessContext: ctx.settings, contactId });
      if (!out.ok) return { ok: false, error: out.error };
      const who = contactId ? findPerson(cfg, input.person_name).name : 'you';
      const name = compactLead(lead).name;
      ctx.actions.push(`Handed ${name} to ${who}`);
      return out.delivered !== false
        ? { ok: true, lead: name, handedTo: who, emailed: true, note: 'The AI no longer replies on this conversation. They were emailed the customer\'s details.' }
        : { ok: true, lead: name, handedTo: who, emailed: false, error: out.error || 'They could not be emailed.', note: 'The handover is recorded but the email failed. Tell the owner to contact the customer themselves.' };
    },

    async resume_lead_ai(ctx, input) {
      const r = await resolveLead(ctx, input);
      const amb = ambiguity(r, input.lead_name); if (amb) return amb;
      const ok = await svc().resumeAI(ctx.db, ctx.userId, r.lead.id);
      if (!ok) return { ok: false, error: 'That lead is not handed over.' };
      const name = compactLead(r.lead).name;
      ctx.actions.push(`Gave ${name} back to the AI`);
      return { ok: true, lead: name, note: 'The AI replies on this conversation again and will not hand it over a second time.' };
    },
  };

  return { TOOL_DEFS, HANDLERS };
};
