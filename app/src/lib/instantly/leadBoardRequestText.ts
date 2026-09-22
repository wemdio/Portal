import { load } from 'cheerio';
import { extractAuthoredReplyText, getBodyText } from './leadQualifier';
import type { Email } from './types';

/** Board-only projection. Never replace the original email used for contacts,
 * qualification or handoff context with this cleaned text. No AI paraphrasing. */
export function leadBoardRequestText(body: Email['body']): string | null {
  let text = typeof body === 'string' ? body : body?.text ?? '';
  let html = typeof body === 'object' && body ? body.html ?? '' : '';
  if (typeof body === 'string' && /<\/?(?:html|body|div|p|br|table|span|blockquote)\b/i.test(body)) {
    html = body;
    text = '';
  }
  if (!text.trim() && html) {
    try {
      const $ = load(html);
      $('script, style, head').remove();
      // Preserve a boundary rather than delete a quote and accidentally join
      // old text below it to the current answer. Signature contacts are read
      // separately from the full body by leadContactMetadata.
      $('blockquote, .gmail_quote, .gmail_attr, .yahoo_quoted, .protonmail_quote, .moz-forward-container, .moz-cite-prefix, .ms-outlook-mobile-reference-message, #divRplyFwdMsg, #stopSpelling, .OutlookMessageHeader')
        .before('\n> \n');
      $('.gmail_signature').before('\n--\n');
      text = getBodyText({ html: $.html() });
    } catch {
      // Never fall back to dumping unparsed HTML/history into the board.
      return null;
    }
  }
  // Another common dated attribution: "Name писал 2026-09-18 12:49:".
  // This display-only boundary must not change classifier behaviour.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const attribution = lines.findIndex((line) => /^.{1,160}\s+(?:писал(?:а|\(а\))?|написал(?:а|\(а\))?|пишет|wrote)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*:\s*$/iu.test(line.trim()));
  const current = attribution < 0 ? text : lines.slice(0, attribution).join('\n');
  // Empty means there is no separable current answer; do not resurrect history.
  return extractAuthoredReplyText(current).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim() || null;
}
