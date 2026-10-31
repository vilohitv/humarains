/**
 * services/wa-state.js — small, targeted writes to integrations.whatsapp.
 *
 * Background jobs (health checks, delivery-receipt alerts) update single keys of the stored WhatsApp
 * connection. A targeted jsonb_set means a background write can never overwrite other integration
 * changes the owner makes at the same moment (connect, disconnect, Google Calendar, ...).
 */
'use strict';

async function writeWaKey(db, userId, key, value) {
  await db.query(
    `UPDATE users
        SET integrations = jsonb_set(integrations, ARRAY['whatsapp', $2::text], $3::jsonb, true)
      WHERE id = $1 AND jsonb_typeof(integrations) = 'object' AND integrations->'whatsapp' IS NOT NULL`,
    [userId, key, JSON.stringify(value)]
  );
}

module.exports = { writeWaKey };
