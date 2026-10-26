/**
 * Модели, которыми инструмент пишет ценности и письма — ровно те, что
 * предлагает экран (EmailSequenceV2View).
 *
 * Сервер не доверяет модели из запроса (аудит 26.10.2026): инструмент открыт
 * клиентам, и любая строка в `model` уходила в платный вызов как есть — клиент
 * мог выбрать самую дорогую модель из одобренных в Requesty.
 */
export const EMAIL_SEQUENCE_MODELS = ['gpt-5.2', 'gpt-4.1', 'gpt-4.1-mini'] as const;

export const DEFAULT_EMAIL_SEQUENCE_MODEL = 'gpt-5.2';

/** Модель из запроса или сохранённого прогона; чужая строка — модель по умолчанию. */
export function pickEmailSequenceModel(...candidates: Array<string | null | undefined>): string {
  for (const value of candidates) {
    const model = value?.trim();
    if (model && (EMAIL_SEQUENCE_MODELS as readonly string[]).includes(model)) return model;
  }
  return DEFAULT_EMAIL_SEQUENCE_MODEL;
}
