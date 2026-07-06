/**
 * Suppression-список OutreachOS: наши клиенты (выгрузка AMO CRM) НИКОГДА не
 * должны получать наш self-outreach. Хранится в outreachos_suppression
 * (kind: 'email' | 'domain'), сидируется скриптом из выгрузки, читается
 * каждым прогоном пайплайна.
 *
 * Матчинг (чистые функции, без server-only — используются и в gridMapping):
 *  - email: точное совпадение адреса (ловит клиентов на gmail/mail.ru,
 *    НЕ блокируя весь бесплатный провайдер);
 *  - domain: корп-домен из почты ИЛИ сайта клиента — блокирует ЛЮБОЙ ящик
 *    на домене (info@, sales@, новые сотрудники) и компанию по её сайту.
 *    Сравнение по хосту (без www) и по корню (последние 2 метки), чтобы
 *    suppressed «example.ru» ловил и «promo.example.ru».
 */

export interface OutreachOsSuppression {
  emails: ReadonlySet<string>;
  domains: ReadonlySet<string>;
}

export const EMPTY_SUPPRESSION: OutreachOsSuppression = {
  emails: new Set<string>(),
  domains: new Set<string>(),
};

/** Хост из URL/домена: без протокола, www и пути, lowercase. '' если мусор. */
export function suppressionHostOf(url: string): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Корень хоста: последние 2 метки (shop.example.ru → example.ru). */
function rootOf(host: string): string {
  const parts = host.split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

function domainSuppressed(host: string, s: OutreachOsSuppression): boolean {
  if (!host) return false;
  return s.domains.has(host) || s.domains.has(rootOf(host));
}

/** true, если email или сайт принадлежит нашему клиенту из suppression-списка. */
export function isSuppressedLead(
  email: string,
  websiteUrl: string,
  s: OutreachOsSuppression,
): boolean {
  const e = (email ?? '').trim().toLowerCase();
  if (e && s.emails.has(e)) return true;
  const at = e.indexOf('@');
  if (at > 0 && domainSuppressed(e.slice(at + 1), s)) return true;
  return domainSuppressed(suppressionHostOf(websiteUrl ?? ''), s);
}

/** true, если КОМПАНИЯ (по сайту) в suppression — отсев до конструктора. */
export function isSuppressedCompany(websiteUrl: string, s: OutreachOsSuppression): boolean {
  return domainSuppressed(suppressionHostOf(websiteUrl ?? ''), s);
}
