import type { FileRow } from './fileParse';
import { recipientVars } from './template';
import { EMAIL_VAR, NAME_VARS, varKey } from './templateVars';

/**
 * Разбор загруженной базы получателей. Колонка с адресом определяется по
 * названию, остальные колонки уезжают в переменные письма как есть: в тексте
 * их можно подставить через {{название_колонки}} (правило имён — templateVars).
 */

export interface ParsedRecipient {
  email: string;
  name: string | null;
  vars: Record<string, string>;
}

export interface RecipientImportResult {
  recipients: ParsedRecipient[];
  invalid: number;
  duplicates: number;
}

/** Переменная, доступная в письме после загрузки базы, — для подсказок в форме. */
export interface RecipientVariable {
  key: string;
  /** Заголовок колонки в файле; null — служебная (email, name, first_name). */
  header: string | null;
  /** У скольких получателей значение непустое. */
  filled: number;
  /** Первое непустое значение — чтобы было видно, что подставится. */
  sample: string | null;
}

export interface RecipientColumnsSummary {
  emailHeader: string | null;
  nameHeader: string | null;
  /** Корректных уникальных адресов — столько писем уйдёт (до стоп-листа). */
  recipients: number;
  invalid: number;
  duplicates: number;
  variables: RecipientVariable[];
}

const EMAIL_HEADERS = ['email', 'e-mail', 'mail', 'почта', 'емейл', 'емайл', 'адрес'];
const NAME_HEADERS = ['name', 'fullname', 'full name', 'имя', 'контакт', 'фио', 'first_name', 'firstname', 'first name'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(header: string): string {
  return header.trim().toLowerCase();
}

function findHeader(headers: string[], candidates: string[]): string | null {
  return headers.find((header) => candidates.includes(normalize(header))) ?? null;
}

function findEmailHeader(headers: string[]): string | null {
  // Запасной вариант: колонка, в названии которой есть «mail» — у выгрузок
  // часто встречается «Work Email», «Email Address» и подобное. Только для
  // почты: раньше тот же запасной поиск стоял и у имени, и база без колонки
  // имени получала «имя», равное адресу.
  return findHeader(headers, EMAIL_HEADERS) ?? headers.find((h) => normalize(h).includes('mail')) ?? null;
}

/**
 * Строка базы до проверки — так её отдаёт файл (recipientRowsFromFile) или
 * заливка из автоаутрича. Ключи vars — как в источнике: к именам переменных
 * письма их приводит normalizeRecipients.
 */
export interface RecipientInput {
  email: string;
  name?: string | null;
  vars: Record<string, string>;
}

/** Адрес в том виде, в каком он хранится в базе; null — адрес некорректный. */
export function normalizeRecipientEmail(raw: string | null | undefined): string | null {
  const email = String(raw ?? '').trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

/**
 * Строки файла → строки базы: колонки адреса и имени находятся по названию,
 * остальные колонки уезжают в переменные. Адреса здесь ещё не проверяются.
 */
export function recipientRowsFromFile(rows: FileRow[]): RecipientInput[] {
  const headers = Object.keys(rows[0] ?? {});
  const emailHeader = findEmailHeader(headers);
  const nameHeader = findHeader(headers, NAME_HEADERS);

  return rows.map((row) => {
    const vars: Record<string, string> = {};
    for (const [header, value] of Object.entries(row)) {
      if (header !== emailHeader) vars[header] = value;
    }
    return {
      // Нет колонки адреса — все строки файла окажутся некорректными.
      email: emailHeader ? (row[emailHeader] ?? '') : '',
      name: nameHeader ? (row[nameHeader] ?? null) : null,
      vars,
    };
  });
}

/**
 * Проверка строк базы — одно правило для файла и для заливки из аутрича:
 * адрес без пробелов и строчными, некорректный отбрасывается, повтор адреса
 * внутри одной заливки тоже (остаётся первое вхождение). Ключи переменных
 * приводятся через varKey, пустые значения не храним — при подстановке
 * отсутствующая переменная и так даёт пусто.
 */
export function normalizeRecipients(rows: RecipientInput[]): RecipientImportResult {
  const recipients: ParsedRecipient[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;

  for (const row of rows) {
    const email = normalizeRecipientEmail(row.email);
    if (!email) {
      invalid += 1;
      continue;
    }
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);

    const vars: Record<string, string> = {};
    for (const [header, value] of Object.entries(row.vars ?? {})) {
      const key = varKey(header);
      if (key && value) vars[key] = value;
    }

    recipients.push({ email, name: String(row.name ?? '').trim() || null, vars });
  }

  return { recipients, invalid, duplicates };
}

export function parseRecipientRows(rows: FileRow[]): RecipientImportResult {
  return normalizeRecipients(recipientRowsFromFile(rows));
}

/**
 * Что нашлось в базе: какая колонка — почта, какая — имя, и какие переменные
 * можно подставить в письмо. Считается по тем же получателям, что потом
 * лягут в кампанию, поэтому подсказка и отправка не разойдутся.
 */
export function describeRecipientColumns(rows: FileRow[]): RecipientColumnsSummary {
  const headers = Object.keys(rows[0] ?? {});
  const emailHeader = findEmailHeader(headers);
  const nameHeader = findHeader(headers, NAME_HEADERS);
  const parsed = parseRecipientRows(rows);

  const variables: RecipientVariable[] = [];
  const add = (key: string, header: string | null, values: (string | null | undefined)[]) => {
    if (!key || variables.some((v) => v.key === key)) return;
    const filled = values.filter((v) => v && v.trim());
    variables.push({ key, header, filled: filled.length, sample: filled[0] ?? null });
  };

  if (emailHeader) add(EMAIL_VAR, null, parsed.recipients.map((r) => r.email));
  if (nameHeader) {
    const names = parsed.recipients.map((r) => r.name);
    add(NAME_VARS[0], null, names);
    add(NAME_VARS[1], null, names.map((n) => n?.split(/\s+/)[0] ?? null));
  }
  for (const header of headers) {
    if (header === emailHeader) continue;
    const key = varKey(header);
    add(key, header, parsed.recipients.map((r) => r.vars[key]));
  }

  return {
    emailHeader,
    nameHeader,
    recipients: parsed.recipients.length,
    invalid: parsed.invalid,
    duplicates: parsed.duplicates,
    variables,
  };
}

/**
 * То же описание колонок, но по уже загруженной базе кампании — для формы
 * редактирования, где файла на руках нет.
 *
 * Заголовки исходного файла при импорте не сохраняются (в vars лежат уже
 * приведённые ключи), поэтому header у всех переменных null, а сам список
 * строится тем же recipientVars, которым подставляет значения отправщик:
 * подсказка в форме и реальная отправка не разойдутся по определению.
 */
export function describeSavedRecipients(
  rows: { email: string; name: string | null; vars: Record<string, string> }[],
): RecipientColumnsSummary {
  const variables: RecipientVariable[] = [];
  const index = new Map<string, RecipientVariable>();

  for (const row of rows) {
    for (const [key, value] of Object.entries(recipientVars(row))) {
      let variable = index.get(key);
      if (!variable) {
        variable = { key, header: null, filled: 0, sample: null };
        index.set(key, variable);
        variables.push(variable);
      }
      if (value && value.trim()) {
        variable.filled += 1;
        variable.sample ??= value;
      }
    }
  }

  sortVariables(variables);

  return {
    emailHeader: null,
    nameHeader: null,
    recipients: rows.length,
    invalid: 0,
    duplicates: 0,
    variables,
  };
}

/**
 * Порядок как в форме после загрузки файла: сначала почта и имя, дальше
 * колонки базы по алфавиту — иначе набор чипов прыгает от выборки к выборке.
 */
function sortVariables(variables: RecipientVariable[]): void {
  const fixed = [EMAIL_VAR, ...NAME_VARS] as string[];
  variables.sort((a, b) => {
    const ai = fixed.indexOf(a.key);
    const bi = fixed.indexOf(b.key);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? fixed.length : ai) - (bi === -1 ? fixed.length : bi);
    return a.key.localeCompare(b.key);
  });
}

/**
 * Дополнить сводку по выборке точными цифрами по всей базе.
 *
 * `stats` — ключи колонок базы и у скольких они заполнены (по всем строкам).
 * Ключ, которого не было в выборке, добавляется без примера значения: главное,
 * что форма его знает и не считает переменную письма «неизвестной». Почта есть
 * у всех; имя и first_name берутся из колонки имени, если в базе нет своих.
 */
export function mergeVariableStats(
  summary: RecipientColumnsSummary,
  stats: { key: string; filled: number }[],
  counts: { total: number; named: number },
): RecipientColumnsSummary {
  const variables = summary.variables.map((v) => ({ ...v }));
  const index = new Map(variables.map((v) => [v.key, v]));
  const upsert = (key: string, filled: number) => {
    const existing = index.get(key);
    if (existing) {
      existing.filled = filled;
      return;
    }
    const added: RecipientVariable = { key, header: null, filled, sample: null };
    index.set(key, added);
    variables.push(added);
  };

  const fromBase = new Map(stats.map((s) => [s.key, Number(s.filled) || 0]));
  for (const [key, filled] of fromBase) upsert(key, filled);
  upsert(EMAIL_VAR, counts.total);
  if (counts.named > 0) {
    for (const key of NAME_VARS) upsert(key, Math.max(fromBase.get(key) ?? 0, counts.named));
  }

  sortVariables(variables);
  return { ...summary, recipients: counts.total, variables };
}
