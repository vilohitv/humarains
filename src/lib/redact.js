/**
 * lib/redact.js — a copy of an object with every secret-looking field removed, at any depth.
 * Used for anything sent to the browser: integration settings hold WhatsApp access tokens, mailbox
 * passwords and OAuth tokens that the page never needs, and that a cross-site-scripting bug would leak.
 */
'use strict';
const SECRET_KEY = /token|secret|pass(word|wd|code)?$|^pass|api[_-]?key|private[_-]?key|credential|cookie|authorization|pin$/i;

function redactSecrets(value, depth = 0) {
  if (Array.isArray(value)) return depth > 8 ? [] : value.map(v => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 8) return {};
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { redactSecrets };
