/** Возвращает первое значение custom-поля AMO по имени. */
export function extractCustomField(
  raw: unknown,
  fieldName: string,
): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const customFields = (raw as { custom_fields_values?: unknown[] })
    .custom_fields_values;
  if (!Array.isArray(customFields)) return null;

  for (const field of customFields) {
    if (!field || typeof field !== 'object') continue;
    if ((field as { field_name?: unknown }).field_name !== fieldName) continue;

    const values = (field as { values?: unknown[] }).values;
    if (!Array.isArray(values) || values.length === 0) return null;

    const firstValue = values[0];
    if (!firstValue || typeof firstValue !== 'object') return null;
    const value = (firstValue as { value?: unknown }).value;
    return value == null ? null : String(value);
  }

  return null;
}
