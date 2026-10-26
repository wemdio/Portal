/**
 * Spam check for /api/demo-lead. A lead it flags still goes to demo_leads and to the
 * Telegram alert, marked as spam with the reasons. It does not become a deal in our AMO
 * and is not copied to the General sales chat (lib/outreachOsLeads). The visitor gets
 * the same success answer as any lead, so a bot learns nothing from the response.
 *
 * Only signs that do not occur in a real request count. Shape signs do not: the
 * outreachos.xyz form puts the company site into both name and company itself, and a
 * plain HTML post or a buyer's AI agent arrives without browser headers.
 *
 *   form_spam_text — the message is an advert for mass mailing through website contact
 *     forms, the first spam the form got (2026-10-25): «Деловые сообщения могут
 *     отправляться в соответствии с применимым законодательством… отправляется через
 *     форму связи… с меньшей вероятностью может попасть в спам». Flagged when the message
 *     has at least two phrases of that template (RU and EN), at least one of them an
 *     anchor found only in the template (SPAM_ANCHOR), or one offer to send *your*
 *     message through contact forms (SPAM_OFFER). The other template phrases
 *     (SPAM_WEAK: spam folders, the recipient's personal data) are ordinary questions
 *     for a cold email service, so even two of them together do not count; nor do
 *     «форма связи», «we tried contact forms» or «contact form marketing» on their own.
 *   no_reply_email — a no-reply address and no phone or Telegram: there is no one to
 *     answer.
 *   placeholder_site — the site given is a placeholder (no-site.com, example.com/.org/.net).
 *
 * New spam templates go into SPAM_ANCHOR, SPAM_WEAK or SPAM_OFFER. An anchor or an
 * offer must be wording a real prospect would not write to us.
 */

export type LeadSpamReason = 'form_spam_text' | 'no_reply_email' | 'placeholder_site';

/** Fixed labels for the Telegram alert, never built from the lead's own text. */
export const LEAD_SPAM_LABEL: Record<LeadSpamReason, string> = {
  form_spam_text: 'реклама рассылок через формы связи',
  no_reply_email: 'почта no-reply, телефона и Telegram нет — ответить некому',
  placeholder_site: 'сайт-заглушка',
};

// Matched against the message lowercased, with ё → е, curly apostrophes → ' and every
// run of whitespace turned into one space.
const SPAM_ANCHOR: RegExp[] = [
  /деловые сообщения могут отправлять/,
  /форм\S* связи,? предназначенн/,
  /business messages (?:can|may) be sent/,
  /form (?:intended|designed|meant) for (?:such |these )?messages/,
];
const SPAM_WEAK: RegExp[] = [
  /меньшей вероятностью (?:может )?попа(?:сть|д\S*) в спам/,
  /личн\S* информаци\S* получател/,
  /less likely to (?:end up|go|get|land|be (?:marked|flagged)) (?:in|into|as) spam/,
  /recipient'?s? personal (?:information|data)|personal (?:information|data) of the recipient/,
];
const SPAM_OFFER: RegExp[] = [
  /(?:рассыл|разосл|разошл|отправ)\S* ваш\S* (?:\S+ ){0,4}(?:по|через) (?:\S+ ){0,3}(?:формам|формы) (?:обратной )?связи/,
  // «we can send your ad to … contact forms», not a prospect's «do you send your messages through contact forms?»
  /(?:\bwe\b|\bi\b|let us|our (?:service|team|system|platform))(?: \S+){0,3} (?:send|deliver|blast|submit)\S* your (?:\S+ ){0,3}(?:to|through|via|into) (?:\S+ ){0,4}contact forms/,
];

// Any local part that starts with noreply / no.reply / no_reply / donotreply: Gmail
// ignores dots, so noreplyname@ and no.reply.name@ are the same mailbox.
const NO_REPLY_LOCAL = /^(?:no|do[._-]?not)[._-]?reply/;

const PLACEHOLDER_HOSTS = new Set(['no-site.com', 'example.com', 'example.org', 'example.net']);

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/\s+/g, ' ');
}

function hostOf(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export interface LeadSpamInput {
  name: string;
  email: string;
  company: string;
  message: string;
  phone: string;
  telegram: string;
}

/** Why the lead looks like spam, in a fixed order; empty for a normal lead. */
export function leadSpamReasons(lead: LeadSpamInput): LeadSpamReason[] {
  const reasons: LeadSpamReason[] = [];
  const message = normalize(lead.message);
  if (message) {
    const anchors = SPAM_ANCHOR.filter((re) => re.test(message)).length;
    const weak = SPAM_WEAK.filter((re) => re.test(message)).length;
    if ((anchors >= 1 && anchors + weak >= 2) || SPAM_OFFER.some((re) => re.test(message))) reasons.push('form_spam_text');
  }
  const local = lead.email.slice(0, lead.email.lastIndexOf('@'));
  if (NO_REPLY_LOCAL.test(local) && !lead.phone && !lead.telegram) reasons.push('no_reply_email');
  if ([lead.name, lead.company].some((v) => PLACEHOLDER_HOSTS.has(hostOf(v)))) reasons.push('placeholder_site');
  return reasons;
}
