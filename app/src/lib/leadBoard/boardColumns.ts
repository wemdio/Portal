/**
 * Лейблы базовых колонок гостевой таблицы лидов. Порядок/набор зеркалит
 * DEFAULT_COLUMN_CONFIG в leadBoardWriter.ts. Дополнительные контакты —
 * встроенные колонки поверх существующего rows.custom, без миграции схемы.
 */
export const BOARD_COLUMN_LABELS: Record<string, string> = {
  phone: 'Контакт',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  address: 'Адрес',
  email: 'Email',
  name: 'Имя',
  company: 'Организация',
  website: 'Сайт',
  request: 'Запрос клиента',
  quality: 'Качество лида',
  comment: 'Комментарий',
  campaign: 'Из какой кампании',
  step: 'После какого письма',
  date: 'Дата лида',
  taken: 'Взяли в работу',
};

/** Reserved builtin keys stored in JSONB, separate from strict phone values. */
export const ADDITIONAL_CONTACT_COLUMN_KEYS = ['telegram', 'whatsapp', 'address'] as const;

export function isAdditionalContactColumnKey(key: string): boolean {
  return (ADDITIONAL_CONTACT_COLUMN_KEYS as readonly string[]).includes(key);
}
