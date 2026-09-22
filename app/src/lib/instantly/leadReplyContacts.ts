import { load } from 'cheerio';
import { isPersonName, isRoleTitle } from '../enrich/extractors/nameQuality';
import { joinLeadPhones, leadPhoneCandidates, normalizeLeadWebsite } from './leadContactValues';
import type { Email } from './types';

export interface LeadReplyContacts {
  leadName: string | null;
  bodyPhone: string | null;
  signaturePhone: string | null;
  companyName: string | null;
  website: string | null;
}

/** Sender display names are weaker than a signed name: keep plausible full
 * names (including uncommon ones), but never copy a mailbox/brand/role into
 * the board's personal-name column. */
export function senderDisplayLeadName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/\s+/g, ' ').trim();
  // Display names sometimes append a role, organization or address. Accept
  // only a self-contained personal prefix; the suffix is not part of a name.
  const prefix = value.split(/[,(]/u)[0].trim();
  if (prefix && prefix !== value) {
    const personal = senderDisplayLeadName(prefix);
    if (personal) return personal;
  }
  if (!value || value.length > 80 || /[@<>/:\d]/u.test(value) ||
    /\.(?:ru|com|net|org|by|kz|online|io)\b/iu.test(value) || isRoleTitle(value)) return null;
  const words = value.split(' ');
  if (words.some((word) => /^(?:info|support|contact|sales|admin|noreply|no-reply|service|team|company|agency|group|digital|solutions|generation|inbox|help|change|mister|bit|компания|организация|отдел|команда|служба|секретарь|агентство|группа|центр|магазин|решения|завод|стоматология|студия|эквайринг|фабрика|коммуникации)$/iu.test(word))) return null;
  if (isPersonName(value)) return value;
  if (words.length < 2 || words.length > 3) return null;
  const cyrillic = words.every((word) => /^[А-ЯЁ][а-яё’-]{1,50}$/u.test(word));
  const latin = words.every((word) => /^[A-Z][a-z’-]{1,50}$/.test(word));
  if (latin) return value;
  if (!cyrillic) return null;
  if (words.length === 3 && words.some((word) => /(?:ович|евич|ьевич|овна|евна|ьевна|инична)$/iu.test(word))) return value;
  return words.length === 2 && words.some((word) => /(?:ов|ев|ин|ова|ева|ина|ский|ская|енко|юк|ич|ян|дзе|швили)$/iu.test(word))
    ? value : null;
}

// Unlike qualification, enrichment needs the sender's signature. Only history
// boundaries belong here; an empty current reply must never fall back to history.
const HISTORY_BOUNDARIES = [
  /^>/,
  /^On\s+.+\s+wrote:\s*$/i,
  /^On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s/i,
  /^Вы\s+писали\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[а-яё]{3,})(?:[^\n]{0,120})?:\s*$/iu,
  /^(?:Van|Verzonden|Aan|Onderwerp|De|Envoyé|À|Objet|Von|Gesendet|An|Betreff):\s+.+$/iu,
  /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4},?\s+\d{1,2}:\d{2}.*(?:@|mailto:)/iu,
  /^(?:От|От кого|From|Sent|Отправлено|Кому|To|Subject|Тема):\s+.+$/i,
  /^(?:[-_=]{2,}\s*)?(?:Original Message|Forwarded Message|Исходное сообщение|Пересланное сообщение|Перенаправленное сообщение|Пересылаемое сообщение)(?::)?(?:\s*[-_=]{2,})?$/i,
  /^Begin forwarded message:\s*$/i,
  /^.{0,180}(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[а-яё]{3,})[^\n]{0,180}(?:пишет|написал(?:а|\(а\))?|писал(?:а|\(а\))?|wrote):\s*$/iu,
  /^(?:пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье),?\s+\d{1,2}\s+[а-яё]{3,}\.?(?:\s+\d{4})?(?:\s*г\.)?[^\n]{0,160}:\s*$/iu,
  /^(?:Sent\s+from\s+my\s+(?:iPhone|iPad|Android)|Отправлено\s+из\s+(?:мобильной\s+)?(?:Почты\s+Mail|мобильной\s+Яндекс\.Почты))(?:[\s:.]|$)/iu,
];
const SIGNOFF = /^(?:--|—|с\s+(?:уважением|наилучшими\s+пожеланиями)(?:[,.!:].*)?|(?:best\s+regards|kind\s+regards|regards|yours\s+sincerely|yours\s+faithfully|sincerely)(?:[,.!:].*)?)$/iu;
const SIGNOFF_PREFIX = /^(?:с\s+(?:уважением|наилучшими\s+пожеланиями)|best\s+regards|kind\s+regards|regards|yours\s+sincerely|yours\s+faithfully|sincerely)(?:[\s,.!:-]+|$)/iu;
const PHONE_LABEL = /(?:телефон|тел\s*[.:]|моб(?:ильный)?\s*[.:]|phone|mobile|telephone|whats\s*app|tel:|позвон|звоните|набери|свяжитесь|для\s+связи|(?:мой|наш)\s+номер|контакт|\b(?:call|reach|contact)\b|\b[mtp]\s*:)/iu;
const NON_PHONE_LABEL = /(?:инн|кпп|огрн(?:ип)?|окпо|бик|снилс|р[/.]?с|к[/.]?с|vat|tax\s*(?:id|number)?|order|заказ[а-яё]*|заявк[аи]|сч[её]т[а-яё]*)\s*[:№#.-]?\s*$/iu;
const WEBSITE_LABEL = /(?:сайт|website|web\s*:|\bour\s+site\b)/iu;
const URL_CANDIDATE = /https?:\/\/[^\s<>"'()[\]{}]+|(?<![\p{L}\p{N}@._-])(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?:\/[^\s<>"'()[\]{}]*)?/giu;

function currentLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n');
  const end = lines.findIndex((line) => HISTORY_BOUNDARIES.some((re) => re.test(line.trim())));
  if (end < 0) return lines.map((line) => line.trim());
  const current = lines.slice(0, end);
  // Some clients put the current author's signature AFTER the quoted thread.
  // Recover only an explicitly unquoted sign-off after a fully marked quote
  // block. An unquoted From/To/forwarding header opens another author's
  // message; even its nested quotes do not make the footer ours again.
  const lastQuoted = lines.findLastIndex((line) => /^>/.test(line.trim()));
  if (lastQuoted >= end && lines.slice(end, lastQuoted + 1).every((line) =>
    !line.trim() || /^>/.test(line.trim()))) {
    const tail = lines.slice(lastQuoted + 1);
    const first = tail.find((line) => line.trim())?.trim() ?? '';
    if (SIGNOFF.test(first) || (SIGNOFF_PREFIX.test(first) && signatureNameInLine(first) !== null)) {
      // Apply the same history boundary to the recovered footer, too.
      current.push(...currentLines(tail.join('\n')));
    }
  }
  return current.map((line) => line.trim());
}

function companyWebsite(raw: string): string | null {
  const value = normalizeLeadWebsite(raw);
  return value ? new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).origin : null;
}

function websitesInLine(line: string): string[] {
  // A mail client can render "first.last <mailto:first.last@host> @host".
  // The display label must not be interpreted as a company website.
  line = line.replace(/[^\s<>]+\s*<mailto:[^>]+>\s*(?:@[^\s<>]+)?/giu, '')
    .replace(/mailto:[^\s<>]+/giu, '')
    .replace(/[^\s<>]+\s+@[^\s<>]+/gu, '')
    .replace(/[^\s<>]+@[^\s<>]+/gu, '');
  return [...line.matchAll(URL_CANDIDATE)]
    .filter((match) => line[match.index + match[0].length] !== '@')
    .map((match) => companyWebsite(match[0]))
    .filter((value): value is string => value !== null);
}

function htmlText(html: string): string {
  const $ = load(html);
  $('script, style, head, blockquote, .gmail_quote, .yahoo_quoted, .protonmail_quote, .moz-forward-container, .ms-outlook-mobile-reference-message').remove();
  // Outlook's reply marker is a sibling of the old message, not its wrapper.
  // Remove following siblings at every enclosing level without losing the top reply.
  $('#divRplyFwdMsg, #stopSpelling, .OutlookMessageHeader, .moz-cite-prefix').each((_, marker) => {
    let node = $(marker);
    while (node.length && !node.is('body, html')) {
      node.nextAll().remove();
      node = node.parent();
    }
    $(marker).remove();
  });
  $('.gmail_signature').prepend('\n--\n');
  $('a[href]').each((_, anchor) => {
    const node = $(anchor);
    const href = (node.attr('href') ?? '').trim();
    if (/^mailto:/i.test(href)) {
      // Keep a linked personal name, but not email/local-part labels that can
      // look like websites ("first.last"). Never expose the mailto target.
      const visible = node.text().replace(/\s+/g, ' ').trim();
      if (signatureNameInLine(visible)) node.text(visible).before(' ').after(' ');
      else node.remove();
      return;
    }
    const visible = node.text().trim();
    const tel = /^tel:/i.test(href) ? href.replace(/^tel:/i, '').split(/[;?]/)[0] : null;
    const site = /^https?:\/\//i.test(href) ? companyWebsite(href) : null;
    const target = tel ? `tel: ${tel}` : site;
    if (target && !visible.includes(target)) node.text(`${visible} ${target}`);
    // Adjacent anchors/text must not produce "first.rusecond.com" or "site.ruнаш".
    node.before(' ').after(' ');
  });
  $('br').replaceWith('\n');
  $('p, div, li, tr, td, th, section, article, header, footer, h1, h2, h3, h4, h5, h6').each((_, element) => {
    $(element).prepend('\n').append('\n');
  });
  return $('body').text();
}

function phoneInLine(line: string, signature: boolean): string | null {
  // "Наш номер в реестре ..." is an identifier, not an invitation to call.
  if (/(?:^|\s)номер\s+(?:в\s+)?реестр(?:е|а|ов[а-яё]*)?(?=\s|[.:,;!?]|$)/iu.test(line) &&
    !/(?:телефон|тел\s*[.:]|моб(?:ильный)?\s*[.:]|phone|mobile|tel:)/iu.test(line)) return null;
  const framed = PHONE_LABEL.test(line);
  const phones: string[] = [];
  const candidates = leadPhoneCandidates(line);
  for (const { value, digits, start, end } of candidates) {
    const before = line.slice(0, start);
    const after = line.slice(end);
    if (NON_PHONE_LABEL.test(before) || after.startsWith('@')) continue;
    if (/https?:\/\/\S*$/i.test(before) && !/https?:\/\/wa\.me\/$/i.test(before)) continue;
    if (digits.length < 10 && !framed) continue;
    const formatted = value.startsWith('+') || /[()]/.test(value) || /\d[ .-]\d/.test(value);
    const russianFull = /^[78]\d{10}$/.test(digits);
    if (!framed && !formatted && !russianFull) continue;
    const residue = (line.slice(0, start) + line.slice(end))
      .replace(/[:;,|/()<>.]/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').trim();
    if (!signature && !framed && residue && !isPersonName(residue)) continue;
    phones.push(value);
  }
  return joinLeadPhones(phones);
}

function explicitCompany(line: string): string | null {
  if (/(?:переписк|конфиденциал|подлежит|disclaimer|confidential)/iu.test(line)) return null;
  if (/(?:^|\s)(?:оказывает|предоставляет|предлагает|производит|занимается|работает|осуществляет|поставляет|является|provides|offers|specializes|manufactures|works|delivers)(?:\s|$)/iu.test(line)) return null;
  const label = /^(?:компания|организация|company|organisation|organization|магазин)(?:\s*:\s*|\s+)(.+)$/iu.exec(line);
  // Accept a legal name inside a job title, not arbitrary narrative mentions.
  const role = /^(?:специалист|менеджер|руководитель|директор|начальник|помощник|ассистент|заместитель|генеральный директор|региональный менеджер)\s+.{0,100}?\s+((?:ООО|АО|ПАО|ЗАО|ОАО|ИП|ТОО)\s+[«"“].+?[»"”])\s*$/iu.exec(line);
  const legal = /^(?:(?:ООО|АО|ПАО|ЗАО|ОАО|ИП|ТОО|НКО|АНО|LLC|LTD|GmbH)\s+.+|.{2,80}\s+(?:LLC|Ltd\.?|Inc\.?|Corp\.?|GmbH|Limited|Corporation))$/iu.test(line);
  const value = (label?.[1] ?? role?.[1] ?? (legal ? line : '')).replace(/\s+/g, ' ').trim()
    .replace(/^\*{1,2}(.+?)\*{1,2}$/, '$1');
  if (value.length < 2 || value.length > 120 || /[@/:!?\n]/.test(value)) return null;
  if (!/[\p{L}]/u.test(value) || PHONE_LABEL.test(value) || websitesInLine(value).length) return null;
  if (/^(?:мы|нам|вам|we|please|our|you)\s/iu.test(value)) return null;
  return value || null;
}

function brandedCompany(line: string, website: string | null): string | null {
  const display = line.replace(URL_CANDIDATE, '').trim();
  if (!website || display.length < 3 || display.length > 70 || !/^[\p{L}\p{N} &'’.,-]+$/u.test(display)) return null;
  const brand = display.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const hostParts = new URL(website).hostname.replace(/^www\./, '').split('.').slice(0, -1);
  return hostParts.some((part) => part.replace(/-/g, '') === brand) ? display : null;
}

function signatureNameInLine(line: string): string | null {
  const value = line.replace(/\s+/g, ' ').trim()
    .replace(SIGNOFF_PREFIX, '')
    .replace(/^(?:фио|имя|name)\s*:\s*/iu, '')
    .replace(/[.,;:!]+$/u, '').trim();
  return isPersonName(value) && !isRoleTitle(value) &&
    !/(?:^|\s)(?:команда|компания|организация|магазин|отдел|team|company|department)(?:\s|$)/iu.test(value) &&
    value.split(/\s+/).every((word) => /^\p{Lu}[\p{L}’'-]*$/u.test(word)) ? value : null;
}

/** Only the current sender's signature, not greetings, body mentions or quoted
 * contacts. Require a recognized personal name and keep ambiguous signatures
 * empty instead of choosing one of several people. Structured data wins later. */
function signatureLeadName(signature: string[]): string | null {
  const candidates = signature.slice(0, 5).map(signatureNameInLine)
    .filter((name): name is string => name !== null);
  const unique = new Map(candidates.map((name) => [name.toLowerCase(), name]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

/** Explicit self-introductions belong to the current author; a greeting or a
 * colleague mentioned in prose does not. History has already been stripped.
 * Start at a sentence/line boundary, not inside reported or quoted speech. */
function introducedLeadName(body: string[]): string | null {
  const text = body.join('\n');
  const intro = /(?:^|[.!?\n])\s*(?:(?:здравствуйте|привет|добрый\s+(?:день|вечер)|доброе\s+утро|доброго\s+дня|hello|hi)[,!]\s*)?(?:меня\s+зовут|мо[её]\s+имя|my\s+name\s+is)(?:\s+|\s*[:—–-]\s*)/giu;
  const candidates = new Map<string, string>();
  for (const match of text.matchAll(intro)) {
    const rest = text.slice(match.index + match[0].length);
    // Keep the case-sensitive name check separate from the case-insensitive
    // marker. Stop before a role/comma, never include arbitrary prose.
    const candidate = /^(\p{Lu}[\p{L}’'-]{1,50}(?:[ \t]+\p{Lu}[\p{L}’'-]{1,50}){0,2})(?=$|[\s,.;:!?—–()])/u.exec(rest)?.[1];
    if (!candidate || /^\s*(?:\?|(?:или|or)\s)/iu.test(rest.slice(candidate.length))) continue;
    const name = signatureNameInLine(candidate);
    if (name) candidates.set(name.toLowerCase(), name);
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

function replyLeadName(body: string[], signature: string[]): string | null {
  const introduced = introducedLeadName(body);
  const signed = signatureLeadName(signature);
  if (!introduced || !signed) return signed ?? introduced;
  // "Меня зовут Евгений" + "Евгений Иванов" is one person; two different
  // names are not a reason to guess. Keep the more complete compatible form.
  const introducedWords = introduced.toLowerCase().split(/\s+/);
  const signedWords = signed.toLowerCase().split(/\s+/);
  if (introducedWords.every((word) => signedWords.includes(word))) return signed;
  if (signedWords.every((word) => introducedWords.includes(word))) return introduced;
  return null;
}

function extractFromText(text: string): LeadReplyContacts {
  const lines = currentLines(text).filter(Boolean);
  // A missing comma is fine only when the rest of the line is a name, not
  // narrative such as "С уважением относимся к вашему предложению".
  let signatureStart = lines.findIndex((line) => SIGNOFF.test(line) ||
    (SIGNOFF_PREFIX.test(line) && signatureNameInLine(line) !== null));
  let nameStart = signatureStart;
  if (signatureStart < 0) {
    // Unmarked signatures still commonly contain a standalone company line
    // immediately above their contact details. Do not mine narrative mentions.
    signatureStart = lines.findIndex((line, index) => {
      if (index < lines.length - 10) return false;
      const tail = lines.slice(index + 1);
      const site = tail.flatMap(websitesInLine)[0] ?? null;
      const company = explicitCompany(line) || brandedCompany(line, site);
      return Boolean(company && tail.some((item) => websitesInLine(item).length || phoneInLine(item, true) || /\S+@\S+\.\S+/.test(item)));
    });
    // Include standalone names immediately above a confirmed company/contact
    // footer. Stop at prose; keep multiple names so ambiguity is not hidden.
    // Do not expand the company/phone/site extraction window into the body.
    nameStart = signatureStart;
    while (nameStart > Math.max(0, signatureStart - 3) && signatureNameInLine(lines[nameStart - 1])) nameStart--;
  }
  const body = signatureStart < 0 ? lines : lines.slice(0, signatureStart);
  const signature = signatureStart < 0 ? [] : lines.slice(signatureStart);
  const signatureSite = signature.filter((line) => WEBSITE_LABEL.test(line)).flatMap(websitesInLine)[0]
    ?? signature.flatMap(websitesInLine)[0] ?? null;
  const bodySite = body.flatMap((line) => {
    const sites = websitesInLine(line);
    const standalone = line.replace(URL_CANDIDATE, '').replace(/[\s<>()[\],;:.-]/g, '') === '';
    return WEBSITE_LABEL.test(line) || standalone ? sites : [];
  })[0] ?? null;
  return {
    leadName: replyLeadName(body, nameStart < 0 ? [] : lines.slice(nameStart)),
    bodyPhone: joinLeadPhones(body.map((line) => phoneInLine(line, false))),
    signaturePhone: joinLeadPhones(signature.map((line) => phoneInLine(line, true))),
    companyName: signature.flatMap((_, index) => [1, 2, 3].map((length) =>
      explicitCompany(signature.slice(Math.max(0, index - length + 1), index + 1).join(' ')))).find(Boolean)
      ?? signature.map((line) => brandedCompany(line, signatureSite)).find(Boolean) ?? null,
    website: signatureSite ?? bodySite,
  };
}

/** Synchronous, local-only hints. Callers retain persisted/structured metadata precedence. */
export function extractLeadReplyContacts(body: Email['body']): LeadReplyContacts {
  const maxLength = 64_000;
  let text = '';
  let html = '';
  if (typeof body === 'string') {
    const value = body.slice(0, maxLength);
    if (/<\/?(?:html|body|div|p|br|table|span|a|blockquote)\b/i.test(value)) html = value;
    else text = value;
  } else if (body) {
    text = typeof body.text === 'string' ? body.text.slice(0, maxLength) : '';
    html = typeof body.html === 'string' ? body.html.slice(0, maxLength) : '';
  }
  const primary = extractFromText(text);
  if (!html) return primary;
  try {
    const fallback = extractFromText(htmlText(html));
    return {
      leadName: primary.leadName ?? fallback.leadName,
      bodyPhone: joinLeadPhones([primary.bodyPhone, fallback.bodyPhone]),
      signaturePhone: joinLeadPhones([primary.signaturePhone, fallback.signaturePhone]),
      companyName: primary.companyName ?? fallback.companyName,
      website: primary.website ?? fallback.website,
    };
  } catch {
    // Bad/deeply nested optional provider HTML must not fail qualification.
    return primary;
  }
}
