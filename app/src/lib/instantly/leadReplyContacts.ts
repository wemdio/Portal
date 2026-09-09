import { load } from 'cheerio';
import { isPersonName } from '../enrich/extractors/nameQuality';
import type { Email } from './types';

export interface LeadReplyContacts {
  bodyPhone: string | null;
  signaturePhone: string | null;
  companyName: string | null;
  website: string | null;
}

// Unlike qualification, enrichment needs the sender's signature. Only history
// boundaries belong here; an empty current reply must never fall back to history.
const HISTORY_BOUNDARIES = [
  /^>/,
  /^On\s+.+\s+wrote:\s*$/i,
  /^(?:От|От кого|From|Sent|Отправлено|Кому|To|Subject|Тема):\s+.+$/i,
  /^(?:[-_=]{2,}\s*)?(?:Original Message|Forwarded Message|Исходное сообщение|Пересланное сообщение|Перенаправленное сообщение|Пересылаемое сообщение)(?::)?(?:\s*[-_=]{2,})?$/i,
  /^Begin forwarded message:\s*$/i,
  /^.{0,180}(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[а-яё]{3,})[^\n]{0,180}(?:пишет|написал(?:а|\(а\))?|писал(?:а|\(а\))?|wrote):\s*$/iu,
  /^(?:пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье),?\s+\d{1,2}\s+[а-яё]{3,}\.?(?:\s+\d{4})?(?:\s*г\.)?[^\n]{0,160}:\s*$/iu,
  /^(?:Sent\s+from\s+my\s+(?:iPhone|iPad|Android)|Отправлено\s+из\s+(?:мобильной\s+)?(?:Почты\s+Mail|мобильной\s+Яндекс\.Почты))(?:[\s:.]|$)/iu,
];
const SIGNOFF = /^(?:--|—|с\s+(?:уважением|наилучшими\s+пожеланиями)(?:[,.!].*)?|(?:best\s+regards|kind\s+regards|regards|yours\s+sincerely|yours\s+faithfully|sincerely)(?:[,.!].*)?)$/iu;
const PHONE_LABEL = /(?:телефон|тел\s*[.:]|моб(?:ильный)?\s*[.:]|phone|mobile|telephone|whats\s*app|tel:|позвон|звоните|набери|свяжитесь|для\s+связи|(?:мой|наш)\s+номер|контакт|\b(?:call|reach|contact)\b|\b[mtp]\s*:)/iu;
const NON_PHONE_LABEL = /(?:инн|кпп|огрн(?:ип)?|окпо|бик|снилс|р[/.]?с|к[/.]?с|vat|tax\s*(?:id|number)?|order|заказ[а-яё]*|заявк[аи]|сч[её]т[а-яё]*)\s*[:№#.-]?\s*$/iu;
const PHONE_CANDIDATE = /(?:\+?\d|\(\d{2,5}\))[\d \t\u00a0().-]{4,}\d/g;
const WEBSITE_LABEL = /(?:сайт|website|web\s*:|\bour\s+site\b)/iu;
const URL_CANDIDATE = /https?:\/\/[^\s<>"'()[\]{}]+|(?<![\p{L}\p{N}@._-])(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?:\/[^\s<>"'()[\]{}]*)?/giu;
const NON_COMPANY_DOMAINS = [
  'gmail.com', 'google.com', 'googleusercontent.com', 'gstatic.com',
  'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'internet.ru', 'ya.ru',
  'yandex.ru', 'yandex.com', 'rambler.ru', 'outlook.com', 'hotmail.com',
  'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com',
  't.me', 'telegram.me', 'wa.me', 'whatsapp.com', 'vk.com', 'ok.ru',
  'facebook.com', 'instagram.com', 'linkedin.com', 'youtube.com',
  'twitter.com', 'x.com', 'linktr.ee', 'bit.ly', 'tinyurl.com',
  '2gis.ru', 'maps.google.com', 'safelinks.protection.outlook.com',
];

function currentLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n');
  const end = lines.findIndex((line) => HISTORY_BOUNDARIES.some((re) => re.test(line.trim())));
  return lines.slice(0, end < 0 ? lines.length : end).map((line) => line.trim());
}

function companyWebsite(raw: string): string | null {
  const value = raw.replace(/[.,;:!?]+$/, '');
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    if (/\.(?:local|localhost|internal|test|invalid)$/i.test(host)) return null;
    if (NON_COMPANY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return null;
    if (/(?:^|[.-])(?:track(?:ing)?|click|redirect)(?:[.-]|$)/i.test(host)) return null;
    if (/(?:unsubscribe|unsub|optout|opt-out|tracking|redirect)/i.test(url.pathname + url.search)) return null;
    if (/\.(?:png|jpe?g|gif|webp|svg|ico|pdf|docx?|xlsx?)(?:$|[?#])/i.test(url.pathname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function websitesInLine(line: string): string[] {
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
    const visible = node.text().trim();
    const tel = /^tel:/i.test(href) ? href.replace(/^tel:/i, '').split(/[;?]/)[0] : null;
    const site = /^https?:\/\//i.test(href) ? companyWebsite(href) : null;
    const target = tel ? `tel: ${tel}` : site;
    if (target && !visible.includes(target)) node.text(`${visible} ${target}`);
  });
  $('br').replaceWith('\n');
  $('p, div, li, tr, td, th, section, article, header, footer, h1, h2, h3, h4, h5, h6').each((_, element) => {
    $(element).prepend('\n').append('\n');
  });
  return $('body').text();
}

function phoneInLine(line: string, signature: boolean): string | null {
  const framed = PHONE_LABEL.test(line);
  // Keep extensions out of the base number, even when separated only by spaces.
  const withoutExtensions = line.replace(/(?:доб(?:авочный)?\.?|ext(?:ension)?\.?|\bx)\s*[:.#]?\s*\d{1,6}/giu, '');
  for (const match of withoutExtensions.matchAll(PHONE_CANDIDATE)) {
    const value = match[0].trim();
    const digits = value.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || /^(\d)\1+$/.test(digits)) continue;
    const before = withoutExtensions.slice(0, match.index);
    const after = withoutExtensions.slice(match.index + match[0].length);
    if (NON_PHONE_LABEL.test(before) || after.startsWith('@')) continue;
    if (/https?:\/\/\S*$/i.test(before) && !/https?:\/\/wa\.me\/$/i.test(before)) continue;
    if (/(?<!\d)(?:\d{4}[./-](?:0?[1-9]|1[0-2])[./-](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-]\d{2,4})(?!\d)/.test(value)) continue;
    if (digits.length < 10 && !framed) continue;
    const formatted = value.startsWith('+') || /[()]/.test(value) || /\d[ .-]\d/.test(value);
    const russianFull = /^[78]\d{10}$/.test(digits);
    if (!framed && !formatted && !russianFull) continue;
    const residue = (withoutExtensions.slice(0, match.index) + withoutExtensions.slice(match.index + match[0].length))
      .replace(/[:;,|/()<>.]/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').trim();
    if (!signature && !framed && residue && !isPersonName(residue)) continue;
    return value;
  }
  return null;
}

function explicitCompany(line: string): string | null {
  if (/(?:^|\s)(?:оказывает|предоставляет|предлагает|производит|занимается|работает|осуществляет|поставляет|является|provides|offers|specializes|manufactures|works|delivers)(?:\s|$)/iu.test(line)) return null;
  const label = /^(?:компания|организация|company|organisation|organization)\s*:\s*(.+)$/iu.exec(line);
  const legal = /^(?:(?:ООО|АО|ПАО|ЗАО|ОАО|ИП|НКО|АНО|LLC|LTD|GmbH)\s+.+|.{2,80}\s+(?:LLC|Ltd\.?|Inc\.?|Corp\.?|GmbH|Limited|Corporation))$/iu.test(line);
  const value = (label?.[1] ?? (legal ? line : '')).replace(/\s+/g, ' ').trim();
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

function extractFromText(text: string): LeadReplyContacts {
  const lines = currentLines(text).filter(Boolean);
  let signatureStart = lines.findIndex((line) => SIGNOFF.test(line));
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
  }
  const body = signatureStart < 0 ? lines : lines.slice(0, signatureStart);
  const signature = signatureStart < 0 ? [] : lines.slice(signatureStart);
  const signatureSite = signature.flatMap(websitesInLine)[0] ?? null;
  const bodySite = body.flatMap((line) => {
    const sites = websitesInLine(line);
    const standalone = line.replace(URL_CANDIDATE, '').replace(/[\s<>()[\],;:.-]/g, '') === '';
    return WEBSITE_LABEL.test(line) || standalone ? sites : [];
  })[0] ?? null;
  return {
    bodyPhone: body.map((line) => phoneInLine(line, false)).find(Boolean) ?? null,
    signaturePhone: signature.map((line) => phoneInLine(line, true)).find(Boolean) ?? null,
    companyName: signature.map(explicitCompany).find(Boolean)
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
      bodyPhone: primary.bodyPhone ?? fallback.bodyPhone,
      signaturePhone: primary.signaturePhone ?? fallback.signaturePhone,
      companyName: primary.companyName ?? fallback.companyName,
      website: primary.website ?? fallback.website,
    };
  } catch {
    // Bad/deeply nested optional provider HTML must not fail qualification.
    return primary;
  }
}
