import { FEDERAL_DISTRICTS } from '@/lib/companiesSearch/regions';
import { getOkvedByCode } from '@/lib/companiesSearch/okved2';
import {
  normalizeStrictEmailList,
  normalizeStrictWebsiteList,
} from '@/lib/companiesDirectory/contactPolicy';

export interface SbisDirectoryInputRow {
  rowNumber: number;
  name?: unknown;
  inn?: unknown;
  kpp?: unknown;
  address?: unknown;
  director_last_name?: unknown;
  director_first_name?: unknown;
  director_middle_name?: unknown;
  activity_type?: unknown;
  source_activity?: unknown;
  employees_count?: unknown;
  phones?: unknown;
  email?: unknown;
  revenue?: unknown;
  cost?: unknown;
  edo_id?: unknown;
  okpo?: unknown;
  pf_reg_number?: unknown;
  branch_code?: unknown;
  website?: unknown;
  egais?: unknown;
  gln?: unknown;
  ogrn?: unknown;
}

type DirectoryValue = string | number | null;

export interface ExistingDirectoryRow {
  id: number | string;
  inn: unknown;
  name?: DirectoryValue;
  kpp?: DirectoryValue;
  address?: DirectoryValue;
  director_last_name?: DirectoryValue;
  director_first_name?: DirectoryValue;
  director_middle_name?: DirectoryValue;
  activity_type?: DirectoryValue;
  employees_count?: DirectoryValue;
  phones?: DirectoryValue;
  email?: DirectoryValue;
  revenue?: DirectoryValue;
  cost?: DirectoryValue;
  edo_id?: DirectoryValue;
  okpo?: DirectoryValue;
  pf_reg_number?: DirectoryValue;
  branch_code?: DirectoryValue;
  website?: DirectoryValue;
  egais?: DirectoryValue;
  gln?: DirectoryValue;
  ogrn?: DirectoryValue;
  region_code?: DirectoryValue;
  okved_code?: DirectoryValue;
  okved_code_exact?: DirectoryValue;
  okved_exact_source?: DirectoryValue;
  source_file?: DirectoryValue;
}

export interface NormalizedSbisCompany {
  name: string | null;
  inn: string;
  kpp: string | null;
  address: string | null;
  director_last_name: string | null;
  director_first_name: string | null;
  director_middle_name: string | null;
  activity_type: string | null;
  source_activity: string | null;
  employees_count: number | null;
  phones: string | null;
  email: string | null;
  revenue: number | null;
  cost: number | null;
  edo_id: string | null;
  okpo: string | null;
  pf_reg_number: string | null;
  branch_code: string | null;
  website: string | null;
  egais: string | null;
  gln: string | null;
  ogrn: string | null;
  region_code: string | null;
  rowNumbers: number[];
  locations: Array<{
    rowNumber: number;
    name: string | null;
    kpp: string | null;
    address: string | null;
  }>;
}

interface NormalizedSbisRow extends Omit<
  NormalizedSbisCompany,
  'rowNumbers' | 'locations' | 'region_code'
> {
  rowNumber: number;
}

export interface ImportConflict {
  inn: string;
  kind:
    | 'source_scalar_conflict'
    | 'existing_value_preserved'
    | 'duplicate_existing_inn';
  field?: string;
  selected?: DirectoryValue;
  incoming?: DirectoryValue;
  existing?: DirectoryValue;
  values?: DirectoryValue[];
  rowNumbers?: number[];
  existingIds?: Array<number | string>;
}

export interface SkippedSbisCompany {
  inn: string;
  reason: 'missing_website_or_email';
  rowNumbers: number[];
}

export interface RejectedSbisRow {
  rowNumber: number;
  reason: 'invalid_inn';
  rawInn: unknown;
}

export interface DirectoryInsert extends Omit<
  NormalizedSbisCompany,
  'rowNumbers' | 'locations' | 'source_activity'
> {
  okved_code: string | null;
  okved_code_exact: null;
  okved_exact_source: null;
  source_file: string;
}

export interface DirectoryUpdate {
  id: number | string;
  inn: string;
  patch: Partial<Record<FillableField, DirectoryValue>>;
}

export interface SbisImportMetrics {
  inputRows: number;
  acceptedRows: number;
  rejectedRows: number;
  uniqueIncomingInns: number;
  duplicateIncomingRows: number;
  inserts: number;
  updates: number;
  noops: number;
  blockedExistingDuplicates: number;
  skippedMissingContact: number;
  conflicts: number;
}

export interface SbisImportPlan {
  inserts: DirectoryInsert[];
  updates: DirectoryUpdate[];
  noops: string[];
  skipped: SkippedSbisCompany[];
  rejected: RejectedSbisRow[];
  conflicts: ImportConflict[];
  metrics: SbisImportMetrics;
}

export interface SbisImportOptions {
  approximateOkvedCode?: string | null;
  approximateOkvedResolver?: (
    activityType: string | null,
    company?: NormalizedSbisCompany,
  ) => string | null;
  eligibility?: 'all' | 'website_or_email';
  sourceFile: string;
}

export interface SbisContactImportOptions {
  sourceFile: string;
}

export const SBIS_APPROXIMATE_OKVED_BY_ACTIVITY = {
  'Программное обеспечение': '62.0',
  'Компьютеры и комплектующие, вычислительная техника, оргтехника': '46.51',
} as const;

const SBIS_HEADER_TO_FIELD = {
  Название: 'name',
  ИНН: 'inn',
  КПП: 'kpp',
  Адрес: 'address',
  'Фамилия руководителя': 'director_last_name',
  'Имя руководителя': 'director_first_name',
  'Отчество руководителя': 'director_middle_name',
  'Вид деятельности': 'activity_type',
  'Источник': 'source_activity',
  'Количество сотрудников': 'employees_count',
  Телефоны: 'phones',
  email: 'email',
  Выручка: 'revenue',
  Стоимость: 'cost',
  'Идентификатор ЭДО': 'edo_id',
  ОКПО: 'okpo',
  'Рег. номер ПФ': 'pf_reg_number',
  'Код филиала': 'branch_code',
  Сайт: 'website',
  ЕГАИС: 'egais',
  GLN: 'gln',
  ОГРН: 'ogrn',
} as const satisfies Record<string, keyof SbisDirectoryInputRow>;

const REQUIRED_SBIS_HEADERS = [
  'Название',
  'ИНН',
  'Адрес',
  'Количество сотрудников',
  'Телефоны',
  'email',
  'Выручка',
  'Сайт',
] as const;

const TEXT_FIELDS = [
  'name',
  'kpp',
  'address',
  'director_last_name',
  'director_first_name',
  'director_middle_name',
  'activity_type',
  'edo_id',
  'okpo',
  'pf_reg_number',
  'branch_code',
  'egais',
  'gln',
  'ogrn',
] as const;

const NUMERIC_FIELDS = [
  'employees_count',
  'revenue',
  'cost',
] as const;

const SOURCE_ONLY_FIELDS = [
  'source_activity',
] as const;

const SOURCE_SCALAR_FIELDS = [
  ...TEXT_FIELDS,
  ...SOURCE_ONLY_FIELDS,
  ...NUMERIC_FIELDS,
] as const;

const FILLABLE_FIELDS = [
  ...TEXT_FIELDS,
  ...NUMERIC_FIELDS,
  'phones',
  'email',
  'website',
  'region_code',
  'okved_code',
] as const;

type FillableField = typeof FILLABLE_FIELDS[number];

const regionTokens = FEDERAL_DISTRICTS.flatMap((district) =>
  district.regions.flatMap((region) =>
    region.matchTokens.map((token) => ({
      code: region.code,
      token: token.toLocaleLowerCase('ru-RU'),
    })),
  ),
).sort((left, right) => right.token.length - left.token.length);

function isBlank(value: unknown): boolean {
  return value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '');
}

export function validateSbisWorksheetHeaders(headers: string[]): void {
  const normalized = new Set(headers.map((header) => header.trim()));
  const missing = REQUIRED_SBIS_HEADERS.filter(
    (header) => !normalized.has(header),
  );
  if (missing.length > 0) {
    throw new Error(`В XLSX отсутствуют обязательные колонки: ${missing.join(', ')}`);
  }
}

export function mapSbisWorksheetRecord(
  record: Record<string, unknown>,
  rowNumber: number,
): SbisDirectoryInputRow {
  const mapped: SbisDirectoryInputRow = { rowNumber };
  for (const [header, field] of Object.entries(SBIS_HEADER_TO_FIELD)) {
    if (Object.prototype.hasOwnProperty.call(record, header)) {
      mapped[field] = record[header];
    }
  }
  return mapped;
}

function normalizeText(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  const text = String(value).trim();
  return text || null;
}

const normalizedSbisActivityOkved = new Map(
  Object.entries(SBIS_APPROXIMATE_OKVED_BY_ACTIVITY).map(
    ([activityType, okvedCode]) => [
      activityType.toLocaleLowerCase('ru-RU'),
      okvedCode,
    ],
  ),
);

export function resolveSbisApproximateOkved(
  activityType: string | null,
): string | null {
  const normalized = normalizeText(activityType)?.toLocaleLowerCase('ru-RU');
  return normalized
    ? normalizedSbisActivityOkved.get(normalized) ?? null
    : null;
}

function resolveSourceParentApproximateOkved(
  sourceActivity: string | null,
): string | null {
  const normalized = normalizeText(sourceActivity);
  const parentCode = normalized
    ?.match(/^(\d{2})(?:\.\d{1,2})?(?=\D|$)/)?.[1] ?? null;
  return parentCode && getOkvedByCode(parentCode) ? parentCode : null;
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/[\s\u00a0]/g, '');
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function hasValidInnChecksum(inn: string): boolean {
  if (inn.length === 10) {
    const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
    const check = weights.reduce(
      (sum, weight, index) => sum + Number(inn[index]) * weight,
      0,
    ) % 11 % 10;
    return check === Number(inn[9]);
  }
  if (inn.length === 12) {
    const weights11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    const weights12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    const check11 = weights11.reduce(
      (sum, weight, index) => sum + Number(inn[index]) * weight,
      0,
    ) % 11 % 10;
    const check12 = weights12.reduce(
      (sum, weight, index) => sum + Number(inn[index]) * weight,
      0,
    ) % 11 % 10;
    return check11 === Number(inn[10]) && check12 === Number(inn[11]);
  }
  return false;
}

export function normalizeSbisInn(value: unknown): string | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  if (!/^(?:\d{10}|\d{12})$/.test(text)) return null;
  return hasValidInnChecksum(text) ? text : null;
}

function splitList(value: unknown): string[] {
  const text = normalizeText(value);
  if (!text) return [];
  return text
    .split(/[,;\r\n]+/)
    .map((part) => part.trim().replace(/^["']+|["']+$/g, '').trim())
    .filter(Boolean);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, 'ru-RU'),
  );
}

function normalizeWebsitePart(value: string): string | null {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    let hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const withoutWww = hostname.startsWith('www.') ? hostname.slice(4) : '';
    if (withoutWww.includes('.')) hostname = withoutWww;
    if (!hostname.includes('.') || /\s/.test(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
}

function normalizeWebsiteList(value: unknown): string | null {
  const websites = sortedUnique(
    splitList(value)
      .map(normalizeWebsitePart)
      .filter((item): item is string => Boolean(item)),
  );
  return websites.length ? websites.join(', ') : null;
}

const PLACEHOLDER_EMAILS = new Set([
  '000@000.ru',
  'example@example.com',
  'net@net.ru',
  'no@mail.ru',
  'test@test.ru',
  'unknown@mail.ru',
  'your@mail.com',
]);

const PLACEHOLDER_EMAIL_LOCAL_PARTS = new Set([
  '000',
  'do-not-reply',
  'donotreply',
  'example',
  'no',
  'no-reply',
  'noreply',
  'test',
  'unknown',
  'your',
]);

const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.ru',
  'invalid.invalid',
  'no.no',
  'test.com',
  'test.ru',
]);

function normalizeEmailPart(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || PLACEHOLDER_EMAILS.has(email)) {
    return null;
  }

  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator !== email.indexOf('@')) return null;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (
    local.length > 64
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || PLACEHOLDER_EMAIL_LOCAL_PARTS.has(local)
    || PLACEHOLDER_EMAIL_DOMAINS.has(domain)
  ) {
    return null;
  }
  if (!/^[a-z\d.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return null;

  const labels = domain.split('.');
  if (
    labels.length < 2
    || !/^[a-z]{2,63}$/i.test(labels.at(-1) ?? '')
    || labels.some(
      (label) =>
        !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label),
    )
  ) {
    return null;
  }

  return email;
}

function normalizeEmailList(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  const emails = sortedUnique(
    [...text.matchAll(
      /[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+/gi,
    )]
      .map((match) => match[0])
      .map(normalizeEmailPart)
      .filter((item): item is string => Boolean(item)),
  );
  return emails.length ? emails.join(', ') : null;
}

type ContactNormalizationMode = 'legacy' | 'strict';

function normalizeSbisWebsite(
  value: unknown,
  mode: ContactNormalizationMode,
): string | null {
  if (mode === 'legacy') return normalizeWebsiteList(value);
  const websites = normalizeStrictWebsiteList(normalizeText(value));
  return websites.length ? websites.join(', ') : null;
}

function normalizeSbisEmail(
  value: unknown,
  mode: ContactNormalizationMode,
): string | null {
  if (mode === 'legacy') return normalizeEmailList(value);
  const emails = normalizeStrictEmailList(normalizeText(value));
  return emails.length ? emails.join(', ') : null;
}

function normalizePhonePart(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `7${digits}`;
  }
  if (digits.length < 5 || digits.length > 15) return null;
  return `+${digits}`;
}

function normalizePhoneList(value: unknown): string | null {
  const phones = sortedUnique(
    splitList(value)
      .map(normalizePhonePart)
      .filter((item): item is string => Boolean(item)),
  );
  return phones.length ? phones.join(', ') : null;
}

function deriveRegionCode(address: string | null): string | null {
  if (!address) return null;
  const normalized = address.toLocaleLowerCase('ru-RU');
  const federalCities: Array<[RegExp, string]> = [
    [/(?:^|[\s,])(?:г\.\s*москва|москва\s+г)(?=$|[\s,])/i, '77'],
    [
      /(?:^|[\s,])(?:г\.\s*санкт-петербург|санкт-петербург\s+г)(?=$|[\s,])/i,
      '78',
    ],
    [/(?:^|[\s,])(?:г\.\s*севастополь|севастополь\s+г)(?=$|[\s,])/i, '92'],
  ];
  const federalCity = federalCities.find(([pattern]) => pattern.test(normalized));
  if (federalCity) return federalCity[1];
  return regionTokens.find(({ token }) => normalized.includes(token))?.code ?? null;
}

function normalizeSbisRow(
  input: SbisDirectoryInputRow,
  contactNormalization: ContactNormalizationMode,
): NormalizedSbisRow | RejectedSbisRow {
  const inn = normalizeSbisInn(input.inn);
  if (!inn) {
    return {
      rowNumber: input.rowNumber,
      reason: 'invalid_inn',
      rawInn: input.inn,
    };
  }

  const normalized = {
    rowNumber: input.rowNumber,
    inn,
    name: normalizeText(input.name),
    kpp: normalizeText(input.kpp),
    address: normalizeText(input.address),
    director_last_name: normalizeText(input.director_last_name),
    director_first_name: normalizeText(input.director_first_name),
    director_middle_name: normalizeText(input.director_middle_name),
    activity_type: normalizeText(input.activity_type),
    source_activity: normalizeText(input.source_activity),
    employees_count: normalizeInteger(input.employees_count),
    phones: normalizePhoneList(input.phones),
    email: normalizeSbisEmail(input.email, contactNormalization),
    revenue: normalizeInteger(input.revenue),
    cost: normalizeInteger(input.cost),
    edo_id: sortedUnique(splitList(input.edo_id)).join(', ') || null,
    okpo: normalizeText(input.okpo),
    pf_reg_number: normalizeText(input.pf_reg_number),
    branch_code: normalizeText(input.branch_code),
    website: normalizeSbisWebsite(input.website, contactNormalization),
    egais: sortedUnique(splitList(input.egais)).join(', ') || null,
    gln: sortedUnique(splitList(input.gln)).join(', ') || null,
    ogrn: normalizeText(input.ogrn),
  } satisfies NormalizedSbisRow;
  return normalized;
}

function isRejected(
  row: NormalizedSbisRow | RejectedSbisRow,
): row is RejectedSbisRow {
  return 'reason' in row;
}

function isBranchLikeName(name: string | null): boolean {
  return Boolean(
    name && /(филиал|подразделени|представительств)/i.test(name),
  );
}

function canonicalScore(row: NormalizedSbisRow): number {
  let score = 0;
  if (!isBranchLikeName(row.name)) score += 10_000;
  if (row.ogrn) score += 1_000;
  if (row.kpp) score += 500;
  if (row.address) score += 250;
  if (row.director_last_name || row.director_first_name) score += 100;
  for (const field of [...TEXT_FIELDS, ...NUMERIC_FIELDS] as const) {
    if (!isBlank(row[field])) score += 1;
  }
  return score;
}

function chooseCanonicalRow(rows: NormalizedSbisRow[]): NormalizedSbisRow {
  const withRevenue = rows.filter((row) => row.revenue !== null);
  if (withRevenue.length === 1) return withRevenue[0];
  return [...rows].sort((left, right) => {
    const scoreDelta = canonicalScore(right) - canonicalScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    return left.rowNumber - right.rowNumber;
  })[0];
}

function distinctValues(
  rows: NormalizedSbisRow[],
  field: typeof SOURCE_SCALAR_FIELDS[number],
): DirectoryValue[] {
  const values = rows
    .map((row) => row[field])
    .filter((value): value is string | number => !isBlank(value));
  return [...new Map(values.map((value) => [String(value), value])).values()]
    .sort((left, right) => String(left).localeCompare(String(right), 'ru-RU'));
}

function unionNormalizedLists(
  rows: NormalizedSbisRow[],
  field: 'phones' | 'email' | 'website',
): string | null {
  const values = sortedUnique(
    rows.flatMap((row) => splitList(row[field])),
  );
  return values.length ? values.join(', ') : null;
}

function collapseSbisRowsByInnWithMode(
  inputs: SbisDirectoryInputRow[],
  contactNormalization: ContactNormalizationMode,
): {
  companies: NormalizedSbisCompany[];
  rejected: RejectedSbisRow[];
  conflicts: ImportConflict[];
  acceptedRows: number;
  duplicateRows: number;
} {
  const rejected: RejectedSbisRow[] = [];
  const rowsByInn = new Map<string, NormalizedSbisRow[]>();

  for (const input of inputs) {
    const normalized = normalizeSbisRow(input, contactNormalization);
    if (isRejected(normalized)) {
      rejected.push(normalized);
      continue;
    }
    const group = rowsByInn.get(normalized.inn) ?? [];
    group.push(normalized);
    rowsByInn.set(normalized.inn, group);
  }

  const conflicts: ImportConflict[] = [];
  const companies = [...rowsByInn.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([inn, rows]) => {
      const canonical = chooseCanonicalRow(rows);
      for (const field of SOURCE_SCALAR_FIELDS) {
        const values = distinctValues(rows, field);
        if (values.length > 1) {
          conflicts.push({
            inn,
            kind: 'source_scalar_conflict',
            field,
            selected: canonical[field],
            values,
            rowNumbers: rows.map((row) => row.rowNumber).sort((a, b) => a - b),
          });
        }
      }

      return {
        name: canonical.name,
        inn,
        kpp: canonical.kpp,
        address: canonical.address,
        director_last_name: canonical.director_last_name,
        director_first_name: canonical.director_first_name,
        director_middle_name: canonical.director_middle_name,
        activity_type: canonical.activity_type,
        source_activity: canonical.source_activity,
        employees_count: canonical.employees_count,
        phones: unionNormalizedLists(rows, 'phones'),
        email: unionNormalizedLists(rows, 'email'),
        revenue: canonical.revenue,
        cost: canonical.cost,
        edo_id: canonical.edo_id,
        okpo: canonical.okpo,
        pf_reg_number: canonical.pf_reg_number,
        branch_code: canonical.branch_code,
        website: unionNormalizedLists(rows, 'website'),
        egais: canonical.egais,
        gln: canonical.gln,
        ogrn: canonical.ogrn,
        region_code: deriveRegionCode(canonical.address),
        rowNumbers: rows.map((row) => row.rowNumber).sort((a, b) => a - b),
        locations: rows.map((row) => ({
          rowNumber: row.rowNumber,
          name: row.name,
          kpp: row.kpp,
          address: row.address,
        })),
      } satisfies NormalizedSbisCompany;
    });

  return {
    companies,
    rejected,
    conflicts,
    acceptedRows: inputs.length - rejected.length,
    duplicateRows: inputs.length - rejected.length - companies.length,
  };
}

export function collapseSbisRowsByInn(
  inputs: SbisDirectoryInputRow[],
): ReturnType<typeof collapseSbisRowsByInnWithMode> {
  return collapseSbisRowsByInnWithMode(inputs, 'legacy');
}

function normalizeComparable(
  field: FillableField,
  value: DirectoryValue,
): DirectoryValue {
  if (field === 'website') return normalizeWebsiteList(value);
  if (field === 'email') return normalizeEmailList(value);
  if (field === 'phones') return normalizePhoneList(value);
  if (NUMERIC_FIELDS.includes(field as typeof NUMERIC_FIELDS[number])) {
    return normalizeInteger(value);
  }
  return normalizeText(value);
}

function valuesEqual(
  field: FillableField,
  left: DirectoryValue,
  right: DirectoryValue,
): boolean {
  return normalizeComparable(field, left) === normalizeComparable(field, right);
}

function resolveApproximateOkved(
  company: NormalizedSbisCompany,
  options: SbisImportOptions,
): string | null {
  if (options.approximateOkvedResolver) {
    return options.approximateOkvedResolver(company.activity_type, company);
  }
  return options.approximateOkvedCode ?? null;
}

function insertFromCompany(
  company: NormalizedSbisCompany,
  options: SbisImportOptions,
): DirectoryInsert {
  const {
    rowNumbers: _rowNumbers,
    locations: _locations,
    source_activity: _sourceActivity,
    ...directoryFields
  } = company;
  return {
    ...directoryFields,
    okved_code: resolveApproximateOkved(company, options),
    okved_code_exact: null,
    okved_exact_source: null,
    source_file: options.sourceFile,
  };
}

function buildSbisImportPlan(
  inputs: SbisDirectoryInputRow[],
  existingRows: ExistingDirectoryRow[],
  options: SbisImportOptions,
  updateFields: readonly FillableField[],
  contactNormalization: ContactNormalizationMode = 'legacy',
): SbisImportPlan {
  const collapsed = collapseSbisRowsByInnWithMode(
    inputs,
    contactNormalization,
  );
  const conflicts = [...collapsed.conflicts];
  const existingByInn = new Map<string, ExistingDirectoryRow[]>();
  for (const existing of existingRows) {
    const inn = normalizeSbisInn(existing.inn);
    if (!inn) continue;
    const group = existingByInn.get(inn) ?? [];
    group.push(existing);
    existingByInn.set(inn, group);
  }

  const inserts: DirectoryInsert[] = [];
  const updates: DirectoryUpdate[] = [];
  const noops: string[] = [];
  const skipped: SkippedSbisCompany[] = [];
  let blockedExistingDuplicates = 0;

  for (const company of collapsed.companies) {
    if (
      options.eligibility === 'website_or_email'
      && !company.website
      && !company.email
    ) {
      skipped.push({
        inn: company.inn,
        reason: 'missing_website_or_email',
        rowNumbers: company.rowNumbers,
      });
      continue;
    }

    const matches = existingByInn.get(company.inn) ?? [];
    if (matches.length === 0) {
      inserts.push(insertFromCompany(company, options));
      continue;
    }
    if (matches.length > 1) {
      blockedExistingDuplicates += 1;
      conflicts.push({
        inn: company.inn,
        kind: 'duplicate_existing_inn',
        existingIds: matches.map((row) => row.id),
      });
      continue;
    }

    const existing = matches[0];
    const incomingWithOkved = {
      ...company,
      okved_code: resolveApproximateOkved(company, options),
    } satisfies NormalizedSbisCompany & { okved_code: string | null };
    const patch: Partial<Record<FillableField, DirectoryValue>> = {};

    for (const field of updateFields) {
      if (!Object.prototype.hasOwnProperty.call(existing, field)) continue;
      const incoming = incomingWithOkved[field] ?? null;
      if (isBlank(incoming)) continue;
      const current = existing[field] ?? null;
      if (isBlank(current)) {
        patch[field] = incoming;
      } else if (!valuesEqual(field, current, incoming)) {
        conflicts.push({
          inn: company.inn,
          kind: 'existing_value_preserved',
          field,
          existing: current,
          incoming,
        });
      }
    }

    if (Object.keys(patch).length > 0) {
      updates.push({ id: existing.id, inn: company.inn, patch });
    } else {
      noops.push(company.inn);
    }
  }

  return {
    inserts,
    updates,
    noops,
    skipped,
    rejected: collapsed.rejected,
    conflicts,
    metrics: {
      inputRows: inputs.length,
      acceptedRows: collapsed.acceptedRows,
      rejectedRows: collapsed.rejected.length,
      uniqueIncomingInns: collapsed.companies.length,
      duplicateIncomingRows: collapsed.duplicateRows,
      inserts: inserts.length,
      updates: updates.length,
      noops: noops.length,
      blockedExistingDuplicates,
      skippedMissingContact: skipped.length,
      conflicts: conflicts.length,
    },
  };
}

export function buildSbisIndustryImportPlan(
  inputs: SbisDirectoryInputRow[],
  existingRows: ExistingDirectoryRow[],
  options: SbisImportOptions,
): SbisImportPlan {
  return buildSbisImportPlan(
    inputs,
    existingRows,
    options,
    FILLABLE_FIELDS,
  );
}

export function buildSbisContactImportPlan(
  inputs: SbisDirectoryInputRow[],
  existingRows: ExistingDirectoryRow[],
  options: SbisContactImportOptions,
): SbisImportPlan {
  return buildSbisImportPlan(
    inputs,
    existingRows,
    {
      ...options,
      approximateOkvedResolver: resolveSbisApproximateOkved,
      eligibility: 'website_or_email',
    },
    ['phones', 'email', 'website', 'okved_code'],
  );
}

export function buildStrictSbisContactImportPlan(
  inputs: SbisDirectoryInputRow[],
  existingRows: ExistingDirectoryRow[],
  options: SbisContactImportOptions,
): SbisImportPlan {
  const plan = buildSbisImportPlan(
    inputs,
    existingRows,
    {
      ...options,
      approximateOkvedResolver: (_activityType, company) =>
        resolveSourceParentApproximateOkved(company?.source_activity ?? null),
      eligibility: 'website_or_email',
    },
    ['email', 'website'],
    'strict',
  );
  return {
    ...plan,
    inserts: plan.inserts.map((insert) => ({
      ...insert,
      phones: null,
    })),
  };
}

export function applySbisImportPlan(
  existingRows: ExistingDirectoryRow[],
  plan: SbisImportPlan,
): ExistingDirectoryRow[] {
  const updatesById = new Map(
    plan.updates.map((update) => [String(update.id), update.patch]),
  );
  const updated = existingRows.map((row) => ({
    ...row,
    ...(updatesById.get(String(row.id)) ?? {}),
  }));
  const inserted = plan.inserts.map((row) => ({
    id: `dry-run-insert:${row.inn}`,
    ...row,
  }));
  return [...updated, ...inserted];
}
