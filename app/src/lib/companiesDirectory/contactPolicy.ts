import { parseEmailList } from '@/lib/clientCampaignReplies/validate';
import { normalizeWebsiteUrl } from '@/lib/clientBrief/autofill/fetchWebsiteHtml';
import { checkSyntax, isDisposable } from '@/lib/emailValidation/shared';

const BLOCKED_WEBSITE_DOMAINS = [
  '2gis.ru',
  'avito.ru',
  'biziq.ru',
  'company.aspx',
  'dikidi.net',
  'facebook.com',
  'flamp.ru',
  'instagram.com',
  'jivo.chat',
  'linktr.ee',
  'list-org.com',
  'maps.google.com',
  'ok.ru',
  'ozon.ru',
  'rusprofile.ru',
  'sbis.ru',
  't.me',
  'taplink.cc',
  'telegram.me',
  'vk.com',
  'wa.me',
  'wildberries.ru',
  'yandex.com',
  'yandex.ru',
  'yell.ru',
  'youtube.com',
  'zoon.ru',
] as const;

const BLOCKED_EMAIL_DOMAINS = [
  'eo.tensor.ru',
  'diadoc.ru',
  'saby.ru',
] as const;

const PLACEHOLDER_EMAILS = new Set([
  '000@000.ru',
  'example@example.com',
  'net@net.ru',
  'no@mail.ru',
  'test@test.ru',
  'unknown@mail.ru',
  'your@mail.com',
]);

function matchesDomain(hostname: string, blockedDomain: string): boolean {
  return hostname === blockedDomain || hostname.endsWith(`.${blockedDomain}`);
}

export function isBlockedCompanyWebsiteDomain(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  return BLOCKED_WEBSITE_DOMAINS.some((domain) =>
    matchesDomain(normalized, domain),
  );
}

export function isBlockedTechnicalEmailDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  return BLOCKED_EMAIL_DOMAINS.some((blockedDomain) =>
    matchesDomain(normalized, blockedDomain),
  );
}

export function normalizeStrictWebsiteList(
  value: string | null | undefined,
): string[] {
  const domains = String(value ?? '')
    .split(/[,;\r\n]+/)
    .map((part) => normalizeWebsiteUrl(part.trim()))
    .filter((url): url is string => Boolean(url))
    .map((url) => new URL(url).hostname.toLowerCase().replace(/^www\./, ''))
    .filter(
      (hostname) =>
        hostname.includes('.') && !isBlockedCompanyWebsiteDomain(hostname),
    );
  return [...new Set(domains)].sort();
}

export function normalizeStrictEmailList(
  value: string | null | undefined,
): string[] {
  const parsed = parseEmailList(String(value ?? '').replace(/[\r\n]+/g, ','));
  const emails = parsed.valid.filter((email) => {
    if (PLACEHOLDER_EMAILS.has(email) || !checkSyntax(email).valid) return false;
    const domain = email.slice(email.lastIndexOf('@') + 1);
    return !isDisposable(domain) && !isBlockedTechnicalEmailDomain(domain);
  });
  return [...new Set(emails)].sort();
}

function normalizeStrictRussianPhonePart(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `7${digits}`;
  }
  return /^7[3489]\d{9}$/.test(digits) ? `+${digits}` : null;
}

export function normalizeStrictRussianPhoneList(
  value: string | null | undefined,
): string[] {
  const phones = String(value ?? '')
    .split(/[,;\r\n]+/)
    .map((part) => normalizeStrictRussianPhonePart(part.trim()))
    .filter((phone): phone is string => Boolean(phone));
  return [...new Set(phones)].sort();
}
