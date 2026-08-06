/**
 * Продуктовое разделение по хосту: ENG-кабинет «Движка вертикалей» живёт на
 * app.outreachos.xyz, RU-портал — на polza-portal.ru / app.outreachos.pro.
 *
 * Используется middleware (host/market-гейты) и /api/signup (простановка
 * profiles.market='eng' при регистрации с ENG-хоста). Тип ClientMarket
 * шарится с клиентским кодом через import type (навигация, layout).
 */

export type ClientMarket = 'ru' | 'eng';

/** Хост ENG-кабинета (без порта, lowercase). */
export const ENG_APP_HOST = (process.env.ENG_APP_HOST ?? 'app.outreachos.xyz').toLowerCase();

/** Канонический хост RU-портала — куда уводим «чужую» аудиторию с ENG-хоста. */
export const MAIN_APP_HOST = (process.env.MAIN_APP_HOST ?? 'polza-portal.ru').toLowerCase();

/** Host-заголовок без порта, lowercase. */
export function normalizeHost(raw: string | null | undefined): string {
  return (raw ?? '').split(':')[0].trim().toLowerCase();
}

export function isEngAppHost(raw: string | null | undefined): boolean {
  return normalizeHost(raw) === ENG_APP_HOST;
}

/** Хост из Origin/Referer (абсолютный URL) через тот же normalizeHost. */
function hostOfUrlHeader(raw: string | null): string {
  if (!raw) return '';
  try {
    return normalizeHost(new URL(raw).host);
  } catch {
    return '';
  }
}

/**
 * Рынок по заголовкам запроса (для /api/signup). Надёжнее всего Origin —
 * браузер всегда шлёт его на POST со страницы, с которой идёт fetch; дальше
 * Host, в конце — Referer. Консервативно: любое ENG-совпадение → 'eng',
 * иначе 'ru' (прежнее поведение, колонка уйдёт в default).
 */
export function marketFromRequestHeaders(headers: Headers): ClientMarket {
  if (hostOfUrlHeader(headers.get('origin')) === ENG_APP_HOST) return 'eng';
  if (isEngAppHost(headers.get('host'))) return 'eng';
  if (hostOfUrlHeader(headers.get('referer')) === ENG_APP_HOST) return 'eng';
  return 'ru';
}
