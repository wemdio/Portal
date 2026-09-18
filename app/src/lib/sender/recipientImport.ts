import type { FileRow } from './fileParse';

/**
 * Разбор загруженной базы получателей. Колонка с адресом определяется по
 * названию, остальные колонки уезжают в переменные письма как есть: в тексте
 * их можно подставить через {{название_колонки}}.
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

const EMAIL_HEADERS = ['email', 'e-mail', 'mail', 'почта', 'емейл', 'емайл', 'адрес'];
const NAME_HEADERS = ['name', 'fullname', 'full name', 'имя', 'контакт', 'фио', 'first_name', 'firstname'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(header: string): string {
  return header.trim().toLowerCase();
}

function findHeader(headers: string[], candidates: string[]): string | null {
  for (const header of headers) {
    if (candidates.includes(normalize(header))) return header;
  }
  // Запасной вариант: колонка, в названии которой есть «mail» — у выгрузок
  // часто встречается «Work Email», «Email Address» и подобное.
  return headers.find((h) => normalize(h).includes('mail')) ?? null;
}

/** Ключ переменной: «Company Name» → company_name. */
function varKey(header: string): string {
  return normalize(header).replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_+|_+$/g, '');
}

export function parseRecipientRows(rows: FileRow[]): RecipientImportResult {
  const headers = Object.keys(rows[0] ?? {});
  const emailHeader = findHeader(headers, EMAIL_HEADERS);
  const nameHeader = findHeader(headers, NAME_HEADERS);

  const recipients: ParsedRecipient[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;

  if (!emailHeader) return { recipients, invalid: rows.length, duplicates };

  for (const row of rows) {
    const email = (row[emailHeader] ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      invalid += 1;
      continue;
    }
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);

    const vars: Record<string, string> = {};
    for (const [header, value] of Object.entries(row)) {
      if (header === emailHeader) continue;
      const key = varKey(header);
      if (key && value) vars[key] = value;
    }

    recipients.push({
      email,
      name: nameHeader ? (row[nameHeader] ?? '').trim() || null : null,
      vars,
    });
  }

  return { recipients, invalid, duplicates };
}
