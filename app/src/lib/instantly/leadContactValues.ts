import { parse } from 'tldts';
import { isDisposable, isFreeProvider } from '@/lib/emailValidation/shared';

const NON_COMPANY_DOMAINS = [
  'google.com', 'googleusercontent.com', 'gstatic.com', 'linkedin.com', 'facebook.com',
  'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 't.me',
  'telegram.me', 'wa.me', 'whatsapp.com', 'vk.com', 'ok.ru', 'max.ru', 'aka.ms',
  'bit.ly', 'tinyurl.com', 'goo.gl', 'clck.ru', 'linktr.ee', '2gis.ru',
  'safelinks.protection.outlook.com', 'jivo.chat', 'jivosite.com',
];

/** Shared by uploaded fields and signatures; no network/DNS or paid lookup. */
export function normalizeLeadWebsite(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^["'<]+|[>"',;]+$/g, '').replace(/[.,;!?]+$/, '');
  if (!text || /\s|@|\\/.test(text) || text.length > 1000) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase();
    const domain = parse(host);
    // URL accepts postal addresses such as г.Минск as IDNs. Require an actual
    // public suffix, while preserving real IDNs (.рф etc.) and hosted subdomains.
    if (!domain.isIcann || !domain.domain || domain.isIp || url.username || url.password || url.port ||
      host.split('.').some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) return null;
    const labels = host.split('.');
    if (labels.some((_, index) => {
      const suffix = labels.slice(index).join('.');
      return isFreeProvider(suffix) || isDisposable(suffix) || NON_COMPANY_DOMAINS.includes(suffix);
    })) return null;
    if (/(?:^|[.-])(?:track(?:ing)?|click|redirect)(?:[.-]|$)/i.test(host) ||
      /(?:unsubscribe|unsub|optout|opt-out|email-tracking|\/track\/|\/open\/|redirect)/i.test(url.pathname + url.search) ||
      /\.(?:png|jpe?g|gif|svg|webp|ico|pdf|docx?|xlsx?)(?:$|\?)/i.test(url.pathname)) return null;
    url.hash = '';
    const result = (/^https?:\/\//i.test(text) ? url.href : `${url.host}${url.pathname}${url.search}`).replace(/\/$/, '');
    return result.length <= 300 ? result : null;
  } catch {
    return null;
  }
}

/** Never cut a number/extension in half to fit the board/Telegram field. */
export function joinLeadPhones(values: readonly (string | null)[], limit = 200): string | null {
  const unique = new Map<string, string>();
  // Older saved values can be comma-separated. Keep commas before an extension
  // label intact, but do not treat several numbers as one oversized number.
  for (const value of values.flatMap((item) => item?.split(/;|,\s*(?=\+?\d|\()/u) ?? [])) {
    const phone = value.trim();
    const extension = /\s+доб\.\s*(\d+)$/.exec(phone);
    const digits = (extension ? phone.slice(0, extension.index) : phone).replace(/\D/g, '');
    const base = /^[78]\d{10}$/.test(digits) ? `7${digits.slice(1)}` : digits;
    const key = `${base}:${extension?.[1] ?? ''}`;
    if (!phone || !base || unique.has(key)) continue;
    if (!extension && [...unique.keys()].some((existing) => existing.startsWith(`${base}:`))) continue;
    if (extension) unique.delete(`${base}:`);
    unique.set(key, phone);
  }
  const result: string[] = [];
  for (const phone of unique.values()) {
    if ([...result, phone].join('; ').length > limit) continue;
    result.push(phone);
  }
  return result.length ? result.join('; ') : null;
}

export interface LeadPhoneCandidate { value: string; digits: string; start: number; end: number }

/** Retain explicit extensions and separate multiple numbers on the same line. */
export function leadPhoneCandidates(line: string): LeadPhoneCandidate[] {
  const result: LeadPhoneCandidate[] = [];
  const candidate = /(?:\+?\d|\(\d{2,5}\))[\d \t\u00a0().-]{4,}\d\)?/g;
  let consumed = 0;
  for (const match of line.matchAll(candidate)) {
    if (match.index < consumed) continue;
    let base = match[0].trim().replace(/[.]+$/, '');
    let extension: string | undefined;
    let end = match.index + match[0].length;
    const suffix = /^(?:\s*[,;]?\s*\(?\s*(?:доб(?:авочный|\.)?|доп\.?|внутр\.?|ext(?:ension|\.)?|x)\s*[:.#]?\s*(\d{1,6})(?!\d)\)?)/iu.exec(line.slice(end));
    if (suffix) { extension = suffix[1]; end += suffix[0].length; }
    // Legacy Russian signatures: +7(391)206-18-17(102). Only interpret the
    // trailing group as extension after a complete 11-digit Russian number.
    const parenthesized = /^(.*\d)\s*\((\d{1,6})\)$/.exec(base);
    if (!extension && parenthesized && /^[78]\d{10}$/.test(parenthesized[1].replace(/\D/g, ''))) {
      base = parenthesized[1].trim(); extension = parenthesized[2];
    }
    consumed = end;
    const digits = base.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || /^(\d)\1+$/.test(digits) ||
      /^\d{1,2}[.:]\d{2}\s*[-–—]\s*\d{1,2}[.:]\d{2}$/.test(base) ||
      /^(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})$/.test(base) ||
      (base.match(/\(/g)?.length ?? 0) !== (base.match(/\)/g)?.length ?? 0)) continue;
    result.push({ value: extension ? `${base} доб. ${extension}` : base, digits, start: match.index, end });
  }
  return result;
}

/** Only labelled upload fields call this; arbitrary text is not a phone field. */
export function normalizeLeadPhone(value: unknown): string | null {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  const text = String(value);
  if (text.length > 5000) return null;
  const phones = leadPhoneCandidates(text);
  let residue = text;
  for (const phone of [...phones].reverse()) residue = residue.slice(0, phone.start) + residue.slice(phone.end);
  residue = residue.replace(/(?:телефон|тел\.?|моб\.?|phone|mobile|telephone|tel|[tm]):?/giu, '').replace(/[\s,;:/|.-]/g, '');
  return residue ? null : joinLeadPhones(phones.map((phone) => phone.value));
}
