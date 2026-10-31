'use strict';
/**
 * crypto-utils.js — password-reset token helpers.
 *
 * Reset tokens are 32 random bytes (256 bits of entropy), so a plain SHA-256 is
 * enough for storage: there is nothing to brute-force through the hash.
 * (Customer mailbox passwords are encrypted separately in services/mailbox.js.)
 */
const crypto = require('crypto');

/** Hash a raw reset token for safe storage. */
function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/** Timing-safe check of a submitted token against the stored hash. */
function verifyResetToken(rawToken, storedHash) {
  if (!rawToken || !storedHash) return false;
  const incoming = hashResetToken(rawToken);
  try {
    return crypto.timingSafeEqual(Buffer.from(incoming, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { hashResetToken, verifyResetToken };
