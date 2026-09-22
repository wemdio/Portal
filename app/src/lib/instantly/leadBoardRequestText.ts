import { load } from 'cheerio';
import { extractAuthoredReplyText, getBodyText } from './leadQualifier';
import type { Email } from './types';

const QUOTE_BLOCKS = 'blockquote, .gmail_quote, .yahoo_quoted, .protonmail_quote, .moz-forward-container, .ms-outlook-mobile-reference-message';
const ATTRIBUTION = /^.{1,160}\s+(?:писал(?:а|\(а\))?|написал(?:а|\(а\))?|пишет|wrote)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*:\s*$/iu;
const YOU_WROTE = /^Вы\s+писали\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[а-яё]{3,})(?:[^\n]{0,120})?:\s*$/iu;
const COLON_SIGNOFF = /^(?:с\s+(?:уважением|наилучшими\s+пожеланиями)|best\s+regards|kind\s+regards|regards|yours\s+sincerely|sincerely)\s*:/iu;

/** Board-only projection. Never replace the original email used for contacts,
 * qualification or handoff context with this cleaned text. No AI paraphrasing. */
export function leadBoardRequestText(body: Email['body']): string | null {
  let text = typeof body === 'string' ? body : body?.text ?? '';
  let html = typeof body === 'object' && body ? body.html ?? '' : '';
  if (typeof body === 'string' && /<\/?(?:html|body|div|p|br|table|span|blockquote)\b/i.test(body)) {
    html = body;
    text = '';
  }
  if (html) {
    try {
      const $ = load(html);
      $('script, style, head').remove();
      const quotes = $(QUOTE_BLOCKS);
      // With explicit closed quote blocks, HTML preserves authorship better
      // than a flattened text alternative, including inline/bottom replies.
      if (text.trim() && !quotes.length) return cleanRequestText(text);
      quotes.each((_, quote) => {
        let previous = quote.prev;
        while (previous && ((previous.type === 'text' && !previous.data.trim()) ||
          previous.type === 'comment' || $(previous).is('br'))) previous = previous.prev;
        if (previous) {
          const header = $(previous);
          const label = header.text().trim();
          // Only remove an attribution immediately attached to a closed quote.
          // Standalone From/To headers must remain terminal history boundaries.
          if (header.is('.gmail_attr, .moz-cite-prefix') ||
            (!/[\r\n]/.test(label) && (/^On\s+.+\s+wrote:\s*$/iu.test(label) || ATTRIBUTION.test(label) || YOU_WROTE.test(label)))) {
            header.remove();
          }
        }
        $(quote).replaceWith('\n');
      });
      // Unlike a closed quote, these markers start unwrapped old history. Keep
      // the terminal boundary: deleting just the label would expose old prose.
      $('.gmail_attr, .moz-cite-prefix, #divRplyFwdMsg, #stopSpelling, .OutlookMessageHeader')
        .before('\n> \n');
      $('.gmail_signature').before('\n--\n');
      text = getBodyText({ html: $.html() });
    } catch {
      // Never fall back to dumping unparsed HTML/history into the board.
      return text.trim() ? cleanRequestText(text) : null;
    }
  }
  return cleanRequestText(text);
}

function cleanRequestText(text: string): string | null {
  // Another common dated attribution: "Name писал 2026-09-18 12:49:".
  // This display-only boundary must not change classifier behaviour.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const attribution = lines.findIndex((line) => ATTRIBUTION.test(line.trim()) || YOU_WROTE.test(line.trim()) || COLON_SIGNOFF.test(line.trim()));
  const current = attribution < 0 ? text : lines.slice(0, attribution).join('\n');
  // Empty means there is no separable current answer; do not resurrect history.
  return extractAuthoredReplyText(current).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim() || null;
}
