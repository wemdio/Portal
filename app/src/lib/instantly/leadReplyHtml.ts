import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

export const LEAD_QUOTE_BLOCKS = 'blockquote, .gmail_quote, .yahoo_quoted, .protonmail_quote, .moz-forward-container, .ms-outlook-mobile-reference-message';
export const LEAD_DATED_ATTRIBUTION = /^.{1,160}\s+(?:писал(?:а|\(а\))?|написал(?:а|\(а\))?|пишет|wrote)\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+\d{1,2}:\d{2}(?::\d{2})?\s*:\s*$/iu;
export const LEAD_DATE_FIRST_ATTRIBUTION = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+\d{1,2}:\d{2},?\s+[^\n]{1,160}\s+(?:пишет|писал(?:а|\(а\))?|wrote):\s*$/iu;
const YOU_WROTE = /^Вы\s+писали\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[а-яё]{3,})(?:[^\n]{0,120})?:\s*$/iu;

function previousContent($: CheerioAPI, node: AnyNode): AnyNode | null {
  let previous = node.prev;
  while (previous && (previous.type === 'comment' || $(previous).is('br') ||
    (previous.type === 'text' && !previous.data.trim()))) previous = previous.prev;
  return previous;
}

/** Remove only explicitly closed history and its attached attribution. Unwrapped
 * From/To/forwarding headers must remain boundaries, not expose foreign footers. */
export function removeLeadReplyQuotes($: CheerioAPI, recoverFooter = false): void {
  const quotes = $(LEAD_QUOTE_BLOCKS).toArray().filter((node) => !$(node).parents(LEAD_QUOTE_BLOCKS).length);
  for (const quote of quotes) {
    const previous = previousContent($, quote);
    if (previous) {
      const header = $(previous);
      const label = header.text().trim();
      if (header.is('.gmail_attr, .moz-cite-prefix') ||
        (!/[\r\n]/.test(label) && (/^On\s+.+\s+wrote:\s*$/iu.test(label) || LEAD_DATED_ATTRIBUTION.test(label) || LEAD_DATE_FIRST_ATTRIBUTION.test(label) || YOU_WROTE.test(label)))) {
        header.remove();
      } else if (recoverFooter && /^\d{1,2}[./-]\d{1,2}[./-]\d{4},?\s+\d{1,2}:\d{2}[^\n]{0,400}@[^\n]{0,160}:\s*$/u.test(label)) {
        // Yandex puts To + Subject + dated author OUTSIDE its closed quote.
        // Require the complete adjacent header, not an isolated arbitrary To.
        // For board request text keep this boundary: the post-quote signature
        // is useful for contacts, not part of the customer's request.
        const subject = previousContent($, previous);
        const to = subject && previousContent($, subject);
        if (subject && to && /^(?:Тема|Subject):\s*\S/iu.test($(subject).text().trim()) &&
          /^(?:Кому|To):\s*\S/iu.test($(to).text().trim())) {
          const separator = previousContent($, to);
          if (separator && /^[-_=—–]{3,}$/u.test($(separator).text().trim())) $(separator).remove();
          $(to).remove();
          $(subject).remove();
          header.remove();
        }
      }
    }
    $(quote).replaceWith('\n');
  }
}
