/**
 * ai-style.js — shared output-style rules for every AI-written text.
 *
 *   const { STYLE_RULES, withStyle, cleanAiText } = require('./ai-style');
 *
 *   system: withStyle(yourSystemPrompt)   // tell the AI how to write
 *   text  = cleanAiText(modelOutput)      // safety net on what comes back
 */

const STYLE_RULES = `OUTPUT STYLE (applies to every word you write):
- Never use bold. No asterisks or underscores for emphasis, no **double asterisks**, no __double underscores__. Emphasise with word choice and sentence structure instead.
- Format the text so it is neat and pleasant to read: short paragraphs of one to three sentences with a blank line between them, natural sentence case, consistent punctuation, and no stray symbols, repeated punctuation or all-caps shouting.
- Keep line breaks tidy. Put a greeting on its own line, then the body, then the sign-off on its own line. Use a plain hyphen list only when the content is truly a list, and keep every item parallel and brief.
- No markdown headings, no tables and no code fences unless the owner explicitly asked for them.
- Sound warm, clear and professional. Do not pad, do not repeat yourself.`;

function withStyle(systemPrompt) {
  return `${systemPrompt || ''}\n\n${STYLE_RULES}`.trim();
}

/**
 * Safety net: strip bold/emphasis markers and tidy whitespace, in case the
 * model slips. Leaves single-asterisk bullets and normal text alone.
 */
function cleanAiText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\*\*\*(.+?)\*\*\*/gs, '$1')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/gs, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// ── The owner's Agent chat ─────────────────────────────────────────────────────────────────────────────────────────────────
// Replies to the OWNER in the dashboard chat are shown formatted (headings, bullets, bold). Everything written to CUSTOMERS keeps the
// plain rules above, because email and WhatsApp clients do not render markdown.
const AGENT_STYLE_RULES = `OUTPUT STYLE for the owner chat (the app renders this formatting):
- A simple answer or confirmation is one to three plain sentences with no formatting at all.
- When the answer has several parts, make it easy to scan. Use "## Heading" for a short section title (never "#"), "- " bullets for three or more parallel items, "1. " numbers for steps in order, and **bold** for the one or two key words, names or figures a reader should not miss.
- Leave a blank line between a heading, a paragraph and a list. Keep paragraphs to one to three sentences and bullets to one line each.
- Never use tables, code fences, emojis, horizontal rules or HTML. Do not put a heading on a short answer. Do not bold whole sentences.`;

function withAgentStyle(systemPrompt) {
  return `${systemPrompt || ''}\n\n${AGENT_STYLE_RULES}`.trim();
}

/**
 * Safety net for the owner chat. Keeps headings, bullets, numbers and **bold**; removes what the chat cannot show (code fences, tables,
 * rules, HTML), normalises bullet characters and heading levels, and tidies spacing so lists and headings sit on their own lines.
 */
function cleanAgentText(text) {
  if (typeof text !== 'string') return text;
  let t = text.replace(/\r\n?/g, '\n')
    .replace(/```[a-z]*\n?/gi, '')                                   // code fences
    .replace(/<\/?[a-z][^>]*>/gi, '')                                // HTML
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')                          // horizontal rules
    .replace(/^\s*\|.*\|\s*$/gm, line => line.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim()).filter(c => c && !/^:?-{2,}:?$/.test(c)).join(' - '))   // tables become plain lines
    .replace(/\*\*\*(.+?)\*\*\*/gs, '**$1**')                        // bold-italic -> bold
    .replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/gs, '$1**$2**')          // __bold__ -> **bold**
    .replace(/^#{1}\s+/gm, '## ')                                    // "#" -> "##"
    .replace(/^#{4,6}\s+/gm, '### ')                                 // deeper headings -> "###"
    .replace(/^[ \t]*[*\u2022\u2013]\s+/gm, '- ')                    // * and bullet characters -> "- "
    .replace(/^[ \t]+(?=[-\d])/gm, '')                               // no indentation
    .replace(/[ \t]+$/gm, '');
  // Headings, and the start and end of a list, sit in their own paragraph; items of one list stay together.
  const kind = l => !l.trim() ? 'blank' : /^#{2,3} /.test(l) ? 'head' : /^- /.test(l) ? 'bullet' : /^\d+[.)] /.test(l) ? 'number' : 'text';
  const out = []; let prev = 'blank';
  for (let line of t.split('\n')) {
    const k = kind(line);
    if (k === 'number') line = line.replace(/^(\d+)\) /, '$1. ');
    const listy = x => x === 'bullet' || x === 'number';
    const needGap = k !== 'blank' && prev !== 'blank' && (k === 'head' || prev === 'head' || (listy(k) && !listy(prev)) || (listy(prev) && !listy(k)));
    if (needGap) out.push('');
    out.push(line);
    prev = k;
  }
  t = out.join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Text that goes to a CUSTOMER (email or WhatsApp reply, follow-up, workflow message). No bold and no emphasis of any kind:
 * strips **bold**, __bold__, *italic*, _italic_ markers and <b>/<strong>/<i>/<em>/<u> tags, plus markdown headings,
 * and tidies spacing. The words are kept. Plain hyphen lists and normal punctuation are left alone.
 */
function cleanCustomerText(text) {
  if (typeof text !== 'string') return text;
  return cleanAiText(text)
    .replace(/<\/?(?:b|strong|i|em|u)\b[^>]*>/gi, '')
    .replace(/(^|[\s(\["'])\*([^\s*][^*\n]*?)\*(?=[\s).,;:!?\]"']|$)/g, '$1$2')     // *italic*
    .replace(/(^|[\s(\["'])_([^\s_][^_\n]*?)_(?=[\s).,;:!?\]"']|$)/g, '$1$2')     // _italic_
    .replace(/\*{2,}/g, '')                                                         // any stray ** left over
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// One sentence for every customer-facing prompt, so the model is told, and cleanCustomerText catches any slip.
const NO_EMPHASIS_RULE = 'Never use bold or any emphasis: no asterisks or underscores around words, no HTML tags. Plain words only.';

module.exports = { STYLE_RULES, withStyle, cleanAiText, cleanCustomerText, NO_EMPHASIS_RULE, AGENT_STYLE_RULES, withAgentStyle, cleanAgentText };
