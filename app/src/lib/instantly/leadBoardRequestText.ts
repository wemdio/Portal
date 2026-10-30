import { load, type CheerioAPI } from 'cheerio';
import { extractAuthoredReplyText, getBodyText } from './leadQualifier';
import { LEAD_DATED_ATTRIBUTION, LEAD_DATE_FIRST_ATTRIBUTION, LEAD_MONTH_FIRST_ATTRIBUTION, LEAD_MANUAL_QUOTE_ATTRIBUTION, LEAD_QUOTE_BLOCKS, removeLeadReplyQuotes } from './leadReplyHtml';
import { stripLeadReplyContactSignature } from './leadReplyContacts';
import type { Email } from './types';

const YOU_WROTE = /^Вы\s+писали\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[а-яё]{3,})(?:[^\n]{0,120})?:\s*$/iu;
const SPACED_SIGNOFF = /^(?:с\s+(?:уважением|наилучшими\s+пожеланиями)|best\s+regards|kind\s+regards|regards|yours\s+sincerely|sincerely)\s*[:,]/iu;
const GREETING = /^(?:добрый\s+(?:день|вечер)|здравствуйте|hello|hi)[!. ,]/iu;
// Display evidence only: a short authored date is still text, regardless of
// whether qualification ultimately treats it as deferred interest.
const SHORT_DATED_REPLY = /^после\s+\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4}(?:\s+года)?)?[.!]?\s*$/imu;

/** Gmail can wrap a complete new reply in quote classes. Rescue only matching,
 * history-free alternatives whose sole attribution is actually a greeting.
 * This is board display evidence, never a generic quote/plaintext fallback. */
function selfContainedGmailReply($: CheerioAPI, text: string): string | null {
  if (!text.trim()) return null;
  const quotes = $(LEAD_QUOTE_BLOCKS);
  if (quotes.length !== 1 || !quotes.is('.gmail_quote.gmail_quote_container')) return null;
  const attribution = quotes.find('.gmail_attr');
  if (attribution.length !== 1 || $('.gmail_attr').length !== 1 ||
    $('.moz-cite-prefix, #divRplyFwdMsg, #stopSpelling, .OutlookMessageHeader, .gmail_signature').length) return null;
  const firstContent = quotes.contents().toArray().find((node) => $(node).text().trim());
  if (firstContent !== attribution[0]) return null;
  const rawGreeting = attribution.text().trim();
  if (/[\r\n]/u.test(rawGreeting)) return null;
  const greeting = rawGreeting.replace(/\s+/gu, ' ');
  if (!GREETING.test(greeting)) return null;
  const addressee = greeting.replace(/^(?:добрый\s+(?:день|вечер)|здравствуйте|hello|hi)/iu, '');
  if (!/^[!,. ]*(?:[А-ЯЁA-Z][а-яёa-z’'-]*(?:[ \t]+[А-ЯЁA-Z][а-яёa-z’'-]*){0,2})?[!,. ]*$/u.test(addressee)) return null;

  const outside = $('body').clone();
  outside.find(LEAD_QUOTE_BLOCKS).remove();
  if (outside.text().trim()) return null;
  const visible = getBodyText({ html: quotes.html() ?? '' });
  const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
  if (normalize(visible) !== normalize(text)) return null;
  // Even a matching text alternative can be old history. Keep every actual
  // attribution/envelope/signature boundary, rather than deleting it to match.
  if (/^\s*(?:>|(?:from|to|subject|sent|от|от\s+кого|кому|тема|дата):|[-_=—–]{2,}[^\n]*(?:forward|пересыл|исходн))/imu.test(visible)) return null;
  const cleaned = cleanRequestText(text);
  if (!cleaned || normalize(cleaned) !== normalize(text)) return null;
  const content = quotes.clone();
  content.find('.gmail_attr').remove();
  if (!/\p{L}{2}/u.test(content.text())) return null;
  return cleaned;
}

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
      const selfContainedReply = selfContainedGmailReply($, text);
      if (selfContainedReply) return selfContainedReply;
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
        const authoredInSignature = onlySignatureHasText && GREETING.test(visible.trim()) &&
          (/(?:напишите|подскажите|пришлите|возможно\s+ли|интересует|please\s+send)/iu.test(visible) || SHORT_DATED_REPLY.test(visible));
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
  text = recoverBottomPostedBoardReply(text);
  // Some senders type a greeting and material request after an initial "--".
  // Ignore that decoration only for a recognizable message, never for an
  // ordinary signature/contact card or a quoted request below the signature.
  const withoutLeadingDivider = text.replace(/^\s*--[ \t]*\r?\n/u, '');
  if (withoutLeadingDivider !== text) {
    const candidate = stripLeadReplyContactSignature(extractAuthoredReplyText(withoutLeadingDivider));
    if (GREETING.test(candidate.trim()) && /^(?:направьте|пришлите|вышлите|отправьте|please\s+send)(?=\s|[!.]|$)/imu.test(candidate)) {
      text = withoutLeadingDivider;
    }
  }
  // Another common dated attribution: "Name писал 2026-09-18 12:49:".
  // This display-only boundary must not change classifier behaviour.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const attribution = lines.findIndex((line) => LEAD_DATED_ATTRIBUTION.test(line.trim()) || LEAD_DATE_FIRST_ATTRIBUTION.test(line.trim()) || LEAD_MONTH_FIRST_ATTRIBUTION.test(line.trim()) || LEAD_MANUAL_QUOTE_ATTRIBUTION.test(line.trim()) || YOU_WROTE.test(line.trim()) || SPACED_SIGNOFF.test(line.trim()) || /^От кого:\s*.+@/iu.test(line.trim()));
  const current = attribution < 0 ? text : lines.slice(0, attribution).join('\n');
  // Empty means there is no separable current answer; do not resurrect history.
  const authored = stripLeadReplyContactSignature(extractAuthoredReplyText(current)).split('\n')
    .filter((line) => !/^\s*\[?cid:[^\s\]]+\]?\s*$/iu.test(line));
  // A divider before history/signature is not part of the customer's request.
  // Preserve separators inside substantive text, only trim the empty tail.
  while (authored.length && /^(?:\s*|\s*[-_=—–]{2,}\s*)$/u.test(authored[authored.length - 1])) authored.pop();
  return authored.join('\n').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim() || null;
}

/** Board-only recovery of an answer below a fully marked, closed quotation.
 * Never recover through an unquoted envelope or interleaved foreign history. */
function recoverBottomPostedBoardReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return text;
  const header = lines[first].trim();
  if (!(LEAD_DATED_ATTRIBUTION.test(header) || LEAD_DATE_FIRST_ATTRIBUTION.test(header) ||
      LEAD_MONTH_FIRST_ATTRIBUTION.test(header) || YOU_WROTE.test(header) || /^On\s+.+\s+wrote:\s*$/iu.test(header))) return text;
  const lastQuoted = lines.findLastIndex((line) => /^>/.test(line.trim()));
  if (lastQuoted <= first || !lines.slice(first + 1, lastQuoted + 1)
    .every((line) => !line.trim() || /^>/.test(line.trim()))) return text;
  return lines.slice(lastQuoted + 1).join('\n').trim() || text;
}
