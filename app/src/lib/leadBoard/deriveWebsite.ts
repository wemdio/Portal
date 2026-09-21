import { isFreeProvider } from '@/lib/emailValidation/shared';

/**
 * Фолбэк сайта компании для авто-строк гостевой таблицы лидов.
 *
 * Instantly Lead API возвращает website только когда сайт был в залитой базе
 * лидов — по факту (сентябрь 2026, 2268 строк) он заполнен у ~20% лидов, при
 * этом у большинства лидов корпоративная почта на собственном домене, и сайт
 * компании = домен почты. Для персональных ящиков (mail.ru, gmail и т.п. —
 * общий список isFreeProvider) и сервисных релеев (zendesk и т.п.) сайта не
 * выводим: домен ничего не говорит о компании лида.
 */

/** Сервисные/релейные домены: сайт по ним — не сайт компании лида. */
const SERVICE_DOMAIN_SUFFIXES = [
  'zendesk.com', 'freshdesk.com', 'intercom.io', 'helpscout.net',
  'hubspot.com', 'forwarding.email', 'mailinator.com', 'mediacat.email',
];

export function deriveWebsiteFromEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!domain || domain.includes('..') || !domain.includes('.')) return null;
  if (isFreeProvider(domain)) return null;
  if (SERVICE_DOMAIN_SUFFIXES.some((sfx) => domain === sfx || domain.endsWith(`.${sfx}`))) {
    return null;
  }
  return domain;
}
