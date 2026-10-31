/**
 * services/lead-messages.js — one row per message, kept in step with the lead.
 *
 * leads.conversation_history (jsonb) is still what the AI reads and what every
 * existing screen uses. lead_messages mirrors it as real rows so that a long
 * thread no longer lives in one hot row, messages can be queried and counted, and
 * history can later move out of the lead record. syncLeadMessages() is called from
 * storeLead(), the single place history is written, so the two cannot drift.
 *
 * A sync failure is logged and never fails the lead save: the jsonb is the source
 * of truth until the application reads from this table.
 */
'use strict';

const CHUNK = 100;
const isoOrNull = v => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

async function syncLeadMessages(db, userId, lead) {
  const history = Array.isArray(lead && lead.conversationHistory) ? lead.conversationHistory : [];
  if (!db || !lead || !lead.id || !history.length) return;
  const channel = String(lead.source || '').toLowerCase() === 'whatsapp' ? 'whatsapp' : 'email';

  try {
    for (let start = 0; start < history.length; start += CHUNK) {
      const params = [lead.id, userId, channel];
      const values = [];
      history.slice(start, start + CHUNK).forEach((t, i) => {
        if (!t || typeof t !== 'object') return;
        const seq = start + i;
        const o = params.length;
        params.push(seq, t.role === 'customer' ? 'inbound' : 'outbound', String(t.body || ''), t.subject || null,
                    t.externalId ? String(t.externalId).slice(0, 255) : null, t.pending === true, isoOrNull(t.sentAt));
        values.push(`($1,$2,$${o + 1},$${o + 2},$3,$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7}::timestamptz,COALESCE($${o + 7}::timestamptz, now()))`);
      });
      if (!values.length) continue;
      await db.query(
        `INSERT INTO lead_messages (lead_id, user_id, seq, direction, channel, body, subject, external_id, pending, sent_at, created_at)
         VALUES ${values.join(',')}
         ON CONFLICT (lead_id, seq) DO UPDATE SET
           direction   = EXCLUDED.direction,
           body        = EXCLUDED.body,
           subject     = EXCLUDED.subject,
           external_id = COALESCE(EXCLUDED.external_id, lead_messages.external_id),
           pending     = EXCLUDED.pending,
           sent_at     = EXCLUDED.sent_at
         WHERE (lead_messages.direction, lead_messages.body, lead_messages.subject, lead_messages.pending, lead_messages.sent_at, lead_messages.external_id)
               IS DISTINCT FROM
               (EXCLUDED.direction, EXCLUDED.body, EXCLUDED.subject, EXCLUDED.pending, EXCLUDED.sent_at, COALESCE(EXCLUDED.external_id, lead_messages.external_id))`,
        params
      );
    }
  } catch (e) {
    console.error('[lead-messages] sync failed for lead', lead.id, '-', e.message);
  }
}

async function listMessages(db, userId, leadId, { limit = 200, offset = 0 } = {}) {
  return db.queryAll(
    `SELECT seq, direction, channel, body, subject, external_id, pending, sent_at, created_at
       FROM lead_messages WHERE lead_id = $1 AND user_id = $2 ORDER BY seq LIMIT $3 OFFSET $4`,
    [leadId, userId, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)]
  );
}

module.exports = { syncLeadMessages, listMessages };
