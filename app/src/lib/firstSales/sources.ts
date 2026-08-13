/**
 * Источник сделки AMO для дашборда первички.
 *
 * Раньше здесь (в `sourceChannels.ts`) жила свёртка источника в «канал» через
 * справочник `lead_source_channels`. Справочник удалён: таксономию источников
 * ведят продажи в самом AMO — поле «Источник» там `select` с фиксированным
 * списком значений (`field_id = 1314379`), — а портал только группирует по
 * ней и второго списка у себя не заводит. Спека:
 * docs/superpowers/specs/2026-08-12-first-sales-sources-instead-of-channels-design.md
 *
 * **Почему ключом служит `enum_id`, а не текст названия:**
 * Поле `amo_leads.raw` хранит снимок сделки на момент последней синхронизации.
 * Если продажи переименуют пункт списка в AMO (например, «Партнер» в «Партнёрка»),
 * старые, давно не менявшиеся сделки останутся с прежним названием в `raw`. Если
 * группировать по тексту, история одного источника разрезалась бы на две строки
 * в дашборде. Группировка по `enum_id` сохраняет историю целой. На момент написания
 * у всех 22 значений источников ровно по одному написанию — мера профилактическая.
 */

/** Ключ сделки без заполненного «Источник». Числовым `enum_id` не бывает. */
export const NO_SOURCE_KEY = 'none';
export const NO_SOURCE_LABEL = 'Без источника';

export type ResolvedSource = {
  /**
   * Ключ группировки, он же значение параметра `source` в API:
   * `<enum_id>` — обычный источник;
   * `text:<нормализованное значение>` — защитный случай для значения без
   * `enum_id` (поле `select`, такого быть не должно, но потерять сделку хуже,
   * чем держать лишнюю ветку);
   * `none` — поле не заполнено.
   */
  key: string;
  /** Название ровно как заведено в AMO. Для незаполненного — NO_SOURCE_LABEL. */
  label: string;
};

const NONE: ResolvedSource = { key: NO_SOURCE_KEY, label: NO_SOURCE_LABEL };

/** Только для текстового ключа: два написания одного значения не должны дать
 *  две строки в разбивке. Название при этом остаётся исходным. */
function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

export function resolveSource(raw: unknown): ResolvedSource {
  if (!raw || typeof raw !== 'object') return NONE;

  const fields = (raw as { custom_fields_values?: unknown }).custom_fields_values;
  if (!Array.isArray(fields)) return NONE;

  for (const field of fields) {
    if (!field || typeof field !== 'object') continue;
    if ((field as { field_name?: unknown }).field_name !== 'Источник') continue;

    const values = (field as { values?: unknown }).values;
    if (!Array.isArray(values) || values.length === 0) return NONE;

    const first = values[0];
    if (!first || typeof first !== 'object') return NONE;

    const rawValue = (first as { value?: unknown }).value;
    const label = rawValue == null ? '' : String(rawValue).trim();
    if (label === '') return NONE;

    const enumId = (first as { enum_id?: unknown }).enum_id;
    if (typeof enumId === 'number' && Number.isInteger(enumId)) {
      return { key: String(enumId), label };
    }
    if (typeof enumId === 'string' && /^\d+$/.test(enumId)) {
      return { key: enumId, label };
    }
    return { key: `text:${normalizeText(label)}`, label };
  }

  return NONE;
}
