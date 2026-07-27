/**
 * Статусы «Качество лида» на гостевой таблице лидов — список из Google-таблиц
 * спецов (скриншоты АДК Транс / Asti Group, 07.2026). Колонку правит клиент
 * через публичный API; воркер её никогда не трогает.
 */
export const LEAD_QUALITY_OPTIONS = [
  'ответил',
  'не отвечает',
  'назначили звонок',
  'обсуждаем сотрудничество',
  'есть интерес',
  'не заинтересован',
  'отказался',
  'лид не релевантный',
  'уже в работе',
  'оплатил услугу/товар',
  'просит связаться позже',
] as const;

export type LeadQuality = (typeof LEAD_QUALITY_OPTIONS)[number];

export function isLeadQuality(value: unknown): value is LeadQuality {
  return typeof value === 'string' && (LEAD_QUALITY_OPTIONS as readonly string[]).includes(value);
}
