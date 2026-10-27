/**
 * Номер сделки из ссылки AmoCRM — той, что в адресной строке открытой сделки:
 * `https://<аккаунт>.amocrm.ru/leads/detail/35468409`.
 *
 * Сделку к ручной записи привязывают ссылкой, а не поиском (решение от
 * 27.10.2026): ссылку берут прямо из AMO, и ошибиться сделкой труднее, чем в
 * выпадающем списке однофамильцев. null — это не ссылка на сделку.
 */
export function parseAmoDealLink(value: string): number | null {
  const match = value
    .trim()
    .match(/^https?:\/\/[a-z0-9-]+\.amocrm\.(?:ru|com)\/leads\/detail\/(\d{1,15})\/?(?:[?#].*)?$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
