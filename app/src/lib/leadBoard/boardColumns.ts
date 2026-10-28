/**
 * Лейблы базовых колонок гостевой таблицы лидов. Порядок/набор зеркалит
 * DEFAULT_COLUMN_CONFIG в leadBoardWriter.ts. Дополнительные контакты хранятся
 * в rows.custom и показываются внутри единой колонки phone, без миграции схемы.
 */
export const BOARD_COLUMN_LABELS: Record<string, string> = {
  phone: 'Контакты',
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

/** Reserved JSONB keys, separate from strict phone values (not visual columns). */
export const ADDITIONAL_CONTACT_COLUMN_KEYS = ['telegram', 'whatsapp', 'address'] as const;

export function isAdditionalContactColumnKey(key: string): boolean {
  return (ADDITIONAL_CONTACT_COLUMN_KEYS as readonly string[]).includes(key);
}
