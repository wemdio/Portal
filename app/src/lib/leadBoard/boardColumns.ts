/**
 * Лейблы базовых колонок гостевой таблицы лидов. Порядок/набор зеркалит
 * DEFAULT_COLUMN_CONFIG в leadBoardWriter.ts и DEFAULT в миграции 20260726_0001.
 */
export const BOARD_COLUMN_LABELS: Record<string, string> = {
  phone: 'Контакт',
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
