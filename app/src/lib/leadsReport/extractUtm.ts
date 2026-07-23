export type Utm = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
};

const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;
type UtmKey = (typeof UTM_KEYS)[number];

const empty = (): Utm => ({
  source: null,
  medium: null,
  campaign: null,
  content: null,
  term: null,
});

/** Извлекает UTM из raw jsonb сделки AMO.
 *  Порядок источников: custom-поля по имени → regex по тексту комментария/примечания.
 *  Все ключи lower-case, префикс "utm_" ищется опционально.
 */
export function extractUtm(raw: unknown): Utm {
  if (!raw || typeof raw !== 'object') return empty();
  const cf = (raw as { custom_fields_values?: unknown[] })
    .custom_fields_values;
  if (!Array.isArray(cf)) return empty();

  const result = empty();

  // Проход 1: custom-поля по имени
  for (const field of cf) {
    if (!field || typeof field !== 'object') continue;
    const name = String(
      (field as { field_name?: unknown }).field_name ?? '',
    ).toLowerCase();
    const values = (field as { values?: unknown[] }).values;
    const rawValue = Array.isArray(values)
      ? (values[0] as { value?: unknown } | undefined)?.value
      : undefined;
    const value = rawValue == null ? null : String(rawValue);
    if (!value) continue;

    for (const key of UTM_KEYS) {
      if (
        (name === `utm_${key}` || name === key) &&
        result[key] === null
      ) {
        result[key] = value;
      }
    }
  }

  // Проход 2: fallback regex по тексту комментариев
  if (UTM_KEYS.every((k) => result[k] === null)) {
    for (const field of cf) {
      const values = (field as { values?: unknown[] }).values;
      const text = Array.isArray(values)
        ? String(
            (values[0] as { value?: unknown } | undefined)?.value ?? '',
          )
        : '';
      if (!text) continue;
      for (const key of UTM_KEYS) {
        if (result[key] !== null) continue;
        const m = new RegExp(`utm_${key}\\s*[:=]\\s*(\\S+)`, 'i').exec(text);
        if (m) result[key] = m[1];
      }
    }
  }

  return result;
}
