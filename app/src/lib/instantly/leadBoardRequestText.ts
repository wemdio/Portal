import { load } from 'cheerio';
import { extractAuthoredReplyText, getBodyText } from './leadQualifier';
import { LEAD_DATED_ATTRIBUTION, LEAD_DATE_FIRST_ATTRIBUTION, LEAD_MONTH_FIRST_ATTRIBUTION, LEAD_QUOTE_BLOCKS, removeLeadReplyQuotes } from './leadReplyHtml';
import { stripLeadReplyContactSignature } from './leadReplyContacts';
import type { Email } from './types';

const YOU_WROTE = /^Вы\s+писали\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[а-яё]{3,})(?:[^\n]{0,120})?:\s*$/iu;
const SPACED_SIGNOFF = /^(?:с\s+(?:уважением|наилучшими\s+пожеланиями)|best\s+regards|kind\s+regards|regards|yours\s+sincerely|sincerely)\s*[:,]/iu;

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
      const quotes = $(LEAD_QUOTE_BLOCKS);
      // With explicit closed quote blocks, HTML preserves authorship better
      // than a flattened text alternative, including inline/bottom replies.
      if (text.trim() && !quotes.length) return cleanRequestText(text);
      removeLeadReplyQuotes($);
      // Unlike a closed quote, these markers start unwrapped old history. Keep
      // the terminal boundary: deleting just the label would expose old prose.
      $('.gmail_attr, .moz-cite-prefix, #divRplyFwdMsg, #stopSpelling, .OutlookMessageHeader')
        .before('\n> \n');
      const outsideSignatures = $('body').clone();
      outsideSignatures.find('.gmail_signature').remove();
      const onlySignatureHasText = !/\p{L}/u.test(outsideSignatures.text());
      $('.gmail_signature').each((_, signature) => {
        const node = $(signature);
        // A sender may type the entire answer inside Gmail's signature editor.
        // The CSS class alone must not erase a substantive request. Closed
        // history has already been removed; still cut the contact table below.
        const visible = getBodyText({ html: node.html() ?? '' });
        const authoredInSignature = onlySignatureHasText && /^(?:добрый\s+(?:день|вечер)|здравствуйте|hello|hi)[!. ,]/iu.test(visible.trim()) &&
          /(?:напишите|подскажите|пришлите|возможно\s+ли|интересует|please\s+send)/iu.test(visible);
        if (!authoredInSignature) node.before('\n--\n');
        else node.find('table').first().before('\n--\n');
      });
      // Block boundaries must survive conversion: a linked name in one div
      // must not concatenate with the business descriptor in the next one.
      $('br').replaceWith('\n');
      $('p, div, li, tr, td, th, section, article, header, footer').each((_, element) => {
        $(element).prepend('\n').append('\n');
      });
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
  const attribution = lines.findIndex((line) => LEAD_DATED_ATTRIBUTION.test(line.trim()) || LEAD_DATE_FIRST_ATTRIBUTION.test(line.trim()) || LEAD_MONTH_FIRST_ATTRIBUTION.test(line.trim()) || YOU_WROTE.test(line.trim()) || SPACED_SIGNOFF.test(line.trim()) || /^От кого:\s*.+@/iu.test(line.trim()));
  const current = attribution < 0 ? text : lines.slice(0, attribution).join('\n');
  // Empty means there is no separable current answer; do not resurrect history.
  const authored = stripLeadReplyContactSignature(extractAuthoredReplyText(current)).split('\n')
    .filter((line) => !/^\s*\[?cid:[^\s\]]+\]?\s*$/iu.test(line));
  // A divider before history/signature is not part of the customer's request.
  // Preserve separators inside substantive text, only trim the empty tail.
  while (authored.length && /^(?:\s*|\s*[-_=—–]{2,}\s*)$/u.test(authored[authored.length - 1])) authored.pop();
  return authored.join('\n').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim() || null;
}
