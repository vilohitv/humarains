/**
 * lib/ai-cache.js: prompt caching for Claude calls.
 *
 * Claude re-reads the whole prompt on every call. Anything marked cacheable and repeated within about five
 * minutes is billed at a tenth of the normal input price on later calls (the first call pays a 25% premium to
 * write it). A prompt prefix is only cached once it passes a minimum length (4,096 tokens on Haiku 4.5), so a
 * short block is simply sent as usual: marking it never costs extra and never changes the answer.
 *
 *   cachedSystem(stable, dynamic?)   system blocks: the stable text is cached, the dynamic text (changes per call) is not
 *   cacheTools(tools)                the tool list, with the last tool marked (tools come first in the prompt)
 *   cacheTail(messages)              marks the end of a growing conversation so the next tool round reads it from cache
 *   logUsage(label, res)             with AI_USAGE_LOG=1, one line per call: tokens in/out and cache writes/reads
 *
 * Order matters: Claude builds the prompt as tools, then system, then messages, and a cache hit needs an identical
 * prefix. Keep what is the same across calls first and what changes last.
 */
'use strict';

const EPHEMERAL = { type: 'ephemeral' };

function cachedSystem(stable, dynamic) {
  const blocks = [];
  if (stable && String(stable).trim()) blocks.push({ type: 'text', text: String(stable), cache_control: EPHEMERAL });
  if (dynamic && String(dynamic).trim()) blocks.push({ type: 'text', text: String(dynamic) });
  return blocks.length ? blocks : undefined;
}

function cacheTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t));
}

/** A copy of the messages with the last block marked. Never mutates the originals, so marks cannot pile up past the limit of four. */
function cacheTail(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const blocks = typeof last.content === 'string'
    ? (last.content ? [{ type: 'text', text: last.content }] : [])
    : (last.content || []).map(b => ({ ...b }));
  if (!blocks.length) return messages;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

function logUsage(label, res) {
  if (process.env.AI_USAGE_LOG !== '1' || !res || !res.usage) return;
  const u = res.usage;
  console.log(`[AI usage] ${label} ${res.model || ''} in=${u.input_tokens || 0} out=${u.output_tokens || 0} ` +
    `cache_write=${u.cache_creation_input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0}`);
}

module.exports = { cachedSystem, cacheTools, cacheTail, logUsage };
