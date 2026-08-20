/**
 * Поля обогащения тула /tools/inn-enrich: набор колонок итогового xlsx и
 * подсчёт статистики. Зеркалят SELECT inn_enrich_fetch RPC — при добавлении
 * поля в RPC добавить и здесь.
 */

export interface EnrichRow {
  [key: string]: unknown;
}

export interface EnrichField {
  key: string;
  label: string;
}

/** Порядок колонок в выгрузке (после исходных колонок файла и «Найдено»). */
export const ENRICH_FIELDS: readonly EnrichField[] = [
  { key: 'name', label: 'Название' },
  { key: 'inn', label: 'ИНН (база)' },
  { key: 'kpp', label: 'КПП' },
  { key: 'ogrn', label: 'ОГРН' },
  { key: 'registry_status', label: 'Статус в реестре' },
  { key: 'registration_date', label: 'Дата регистрации' },
  { key: 'director', label: 'Руководитель' },
  { key: 'address', label: 'Адрес' },
  { key: 'phones', label: 'Телефоны' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Сайт' },
  { key: 'okved_code', label: 'Код ОКВЭД' },
  { key: 'okved_name', label: 'ОКВЭД (название)' },
  { key: 'activity_type', label: 'Вид деятельности' },
  { key: 'employees_count', label: 'Сотрудники' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'cost', label: 'Расходы' },
  { key: 'edo_id', label: 'ЭДО' },
  { key: 'egais', label: 'ЕГАИС' },
  { key: 'okpo', label: 'ОКПО' },
  { key: 'pf_reg_number', label: 'Рег. номер ПФР' },
  { key: 'branch_code', label: 'Код подразделения' },
  { key: 'gln', label: 'GLN' },
] as const;

/** Виртуальное поле «Руководитель» — склейка трёх колонок ФИО из RPC. */
export function directorFio(row: EnrichRow): string {
  return [row.director_last_name, row.director_first_name, row.director_middle_name]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ');
}

function cellValue(row: EnrichRow, key: string): string | number | null {
  if (key === 'director') return directorFio(row) || null;
  const v = row[key];
  if (v === null || v === undefined || v === '') return null;
  return v as string | number;
}

/** Значения колонок обогащения для одной найденной строки (порядок ENRICH_FIELDS). */
export function enrichValues(row: EnrichRow): Array<string | number | null> {
  return ENRICH_FIELDS.map((f) => cellValue(row, f.key));
}

function isFilled(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

export function hasAnyContact(row: EnrichRow): boolean {
  return isFilled(row.phones) || isFilled(row.email) || isFilled(row.website);
}

export interface EnrichmentStats {
  totalRows: number;
  uniqueInns: number;
  invalidValues: number;
  matchedRows: number;
  matchedUniqueInns: number;
  withAnyContact: number;
  /** Заполненность ключевых полей среди найденных уникальных ИНН. */
  fillRates: Array<{ label: string; filled: number; pct: number }>;
}

const FILL_RATE_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'address', label: 'Адрес' },
  { key: 'okved_code', label: 'ОКВЭД' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'email', label: 'Email' },
  { key: 'phones', label: 'Телефоны' },
  { key: 'website', label: 'Сайт' },
];

export function buildEnrichmentStats(args: {
  totalRows: number;
  uniqueInns: number;
  invalidValues: number;
  matchedRows: number;
  matched: EnrichRow[];
}): EnrichmentStats {
  const { matched } = args;
  const matchedUniqueInns = matched.length;
  const withAnyContact = matched.filter(hasAnyContact).length;
  const fillRates = FILL_RATE_FIELDS.map(({ key, label }) => {
    const filled = matched.filter((r) => isFilled(r[key])).length;
    return {
      label,
      filled,
      pct: matchedUniqueInns > 0 ? Math.round((filled / matchedUniqueInns) * 1000) / 10 : 0,
    };
  });
  return {
    totalRows: args.totalRows,
    uniqueInns: args.uniqueInns,
    invalidValues: args.invalidValues,
    matchedRows: args.matchedRows,
    matchedUniqueInns,
    withAnyContact,
    fillRates,
  };
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}
