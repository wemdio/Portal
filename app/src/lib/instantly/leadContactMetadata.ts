import { isDisposable, isFreeProvider } from '@/lib/emailValidation/shared';
import { extractLeadReplyContacts, type LeadReplyContacts } from './leadReplyContacts';
import type { Email, Lead } from './types';

export interface LeadContactMetadata {
  leadName: string | null;
  companyName: string | null;
  phone: string | null;
  website: string | null;
}

const COMPANY_KEYS = ['company_name', 'company', 'organization', 'organization_name',
  'organisation', 'organisation_name', 'business_name', 'legal_name',
  'компания', 'название компании', 'наименование компании', 'организация',
  'название организации', 'наименование организации', 'название'];
const PHONE_KEYS = ['phone', 'phone_number', 'phone_numbers', 'telephone', 'mobile',
  'mobile_phone', 'contact_phone', 'company_phone', 'телефон', 'телефоны',
  'номер телефона', 'телефон компании', 'телефон контакта', 'телефон ЛПР', 'мобильный',
  'мобильный телефон', 'основной телефон'];
const WEBSITE_KEYS = ['website', 'company_website', 'website_url', 'company_url',
  'site', 'url', 'web_site', 'сайт',
  'сайт компании', 'ссылка на сайт'];
const DOMAIN_KEYS = ['company_domain', 'domain', 'домен', 'домен компании'];
const NON_COMPANY_DOMAINS = ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com',
  'x.com', 'youtube.com', 'youtu.be', 't.me', 'telegram.me', 'wa.me', 'whatsapp.com',
  'vk.com', 'ok.ru', 'max.ru', 'bit.ly', 'tinyurl.com', 'goo.gl', 'clck.ru'];

const normalizeKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^a-zа-яё0-9]/g, '').replace(/\d+$/, '');
const normalizeEmail = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function cleanValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || /^(?:[-–—]+|null|none|n\/?a|nan|undefined|unknown|not available|нет(?: данных)?|не указан[оа]?|#n\/a)$/i.test(text)) return null;
  return text;
}

function fieldValues(source: Record<string, unknown>, aliases: readonly string[]): unknown[] {
  const entries = Object.entries(source);
  return aliases.flatMap((alias) => entries
    .filter(([key]) => normalizeKey(key) === normalizeKey(alias))
    .flatMap(([, value]) => Array.isArray(value) ? value.slice(0, 20) : [value]));
}

/** Provider search is fuzzy: never enrich with the first unrelated result. */
function matchedLeads(leads: readonly Lead[], email: string, campaignId: string): Lead[] {
  const exact = leads.filter((lead) => {
    if (!record(lead)) return false;
    if (normalizeEmail(lead.email) !== normalizeEmail(email)) return false;
    const campaigns = [lead.campaign_id, lead.campaign]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    return campaigns.every((id) => id.trim() === campaignId);
  });
  const scoped = exact.filter((lead) => lead.campaign_id === campaignId || lead.campaign === campaignId);
  // A scoped API response may omit campaign entirely. Only use those records
  // when there is no positively scoped match for this same email.
  return scoped.length ? scoped : exact;
}

function sourcesForLead(lead: Lead): Record<string, unknown>[] {
  const payload = record(lead.payload);
  return [record(lead), record(lead.custom_variables), payload, record(payload?.custom_variables)]
    .filter((source): source is Record<string, unknown> => source !== null);
}

function firstField(
  sources: Record<string, unknown>[], aliases: readonly string[],
  normalize: (value: unknown) => string | null,
): string | null {
  for (const source of sources) {
    for (const value of fieldValues(source, aliases)) {
      const normalized = normalize(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

function companyValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = cleanValue(value);
  return text && /\p{L}/u.test(text) && !/^(?:ооо|оао|пао|зао|ао|ип|llc|ltd|company name|название компании)$/i.test(text) && !/^(?:https?:|www\.)|@/i.test(text)
    ? text.slice(0, 200) : null;
}

function phoneValue(value: unknown): string | null {
  const text = cleanValue(value);
  if (!text) return null;
  // Uploaded phone columns are trusted as phone fields, but not arbitrary text
  // or dates/IDs. Keep international formatting and an explicitly labelled ext.
  const phones = String(value).split(/[;,/\n]+/).flatMap((part) => {
    const formatted = part.trim().replace(/^(?:телефон|тел\.?|phone|mobile|telephone)\s*[:.]?\s*/i, '').trim();
    const number = formatted.replace(/\s*(?:доб\.?|ext\.?|extension|x)\s*\d+\s*$/i, '').trim();
    if (!/^\+?[\d ()\-.]+$/.test(number) || /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{4})$/.test(number)) return [];
    const digits = number.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return [];
    return [formatted];
  });
  return phones.length ? [...new Set(phones)].join('; ').slice(0, 200) : null;
}

function blockedDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split('.');
  return labels.some((_, index) => {
    const suffix = labels.slice(index).join('.');
    return isFreeProvider(suffix) || isDisposable(suffix) || NON_COMPANY_DOMAINS.includes(suffix);
  });
}

export function normalizeLeadWebsite(value: unknown): string | null {
  const text = cleanValue(value)?.replace(/^["'<]+|[>"',;]+$/g, '');
  if (!text || /\s|@/.test(text) || text.length > 1000) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase();
    if (url.username || url.password || url.port || !host.includes('.') ||
      !/^[a-z\d.-]+$/.test(host) || !/[a-z]{2,}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(host) || blockedDomain(host) ||
      /(?:unsubscribe|email-tracking|\/track\/|\/open\/)|\.(?:png|jpe?g|gif|svg|webp)(?:$|\?)/i.test(url.pathname)) return null;
    // Keep existing bare-domain formatting while validating a safe HTTP(S) URL.
    url.hash = '';
    return (/^https?:\/\//i.test(text) ? url.href : `${url.host}${url.pathname}${url.search}`)
      .replace(/\/$/, '').slice(0, 300);
  } catch {
    return null;
  }
}

/** Local only: same API lookup, no extra AI/crawl/Instantly calls or DB writes. */
export function resolveLeadContactMetadata(input: {
  leads: readonly Lead[];
  leadEmail: string;
  campaignId: string;
  replyBody: Email['body'];
}): LeadContactMetadata {
  const sources = matchedLeads(input.leads, input.leadEmail, input.campaignId).flatMap(sourcesForLead);
  let reply: LeadReplyContacts = { bodyPhone: null, signaturePhone: null, companyName: null, website: null };
  try {
    reply = extractLeadReplyContacts(input.replyBody);
  } catch {
    // Optional signature enrichment must not discard a qualified lead or its
    // structured upload metadata if a malformed email cannot be parsed.
  }
  const firstName = firstField(sources, ['first_name', 'имя'], cleanValue);
  const lastName = firstField(sources, ['last_name', 'фамилия'], cleanValue);
  const emailDomain = normalizeEmail(input.leadEmail).match(/^[^@\s]+@([^@\s]+)$/)?.[1];
  return {
    leadName: [firstName, lastName].filter(Boolean).join(' ') || null,
    companyName: firstField(sources, COMPANY_KEYS, companyValue) || companyValue(reply.companyName),
    phone: firstField(sources, PHONE_KEYS, phoneValue) || phoneValue(reply.bodyPhone) || phoneValue(reply.signaturePhone),
    // An explicit uploaded website is stronger than a provider's inferred
    // company domain, even when that domain is in the top-level lead fields.
    website: firstField(sources, WEBSITE_KEYS, normalizeLeadWebsite) ||
      firstField(sources, DOMAIN_KEYS, normalizeLeadWebsite) || normalizeLeadWebsite(reply.website) ||
      (emailDomain ? normalizeLeadWebsite(emailDomain) : null),
  };
}
