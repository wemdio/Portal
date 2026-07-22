import type { LeadCreatePayload } from '@/lib/instantly/types';
import type { ClientLaunchColumnMapping } from './types';

export interface MapCsvRowsInput {
  headers: string[];
  rows: string[][];
  mapping: ClientLaunchColumnMapping;
}

const STANDARD_FIELDS = [
  'email',
  'first_name',
  'last_name',
  'company_name',
  'website',
  'phone',
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Convert raw spreadsheet rows into Instantly lead payloads using the column
 * mapping the client provided. Unmapped columns become custom_variables (keyed
 * by header name unless overridden via mapping.custom_variables_mapping).
 */
export function mapCsvRowsToLeads(input: MapCsvRowsInput): LeadCreatePayload[] {
  const { headers, rows, mapping } = input;

  const indexByHeader = new Map<string, number>();
  headers.forEach((h, i) => indexByHeader.set(h, i));

  const emailIdx = indexByHeader.get(mapping.email);
  if (emailIdx === undefined) return [];

  const mappingRecord = mapping as unknown as Record<string, string | undefined>;

  const standardIdx: Partial<Record<(typeof STANDARD_FIELDS)[number], number>> = {};
  for (const field of STANDARD_FIELDS) {
    const header = mappingRecord[field];
    if (typeof header === 'string') {
      const idx = indexByHeader.get(header);
      if (idx !== undefined) standardIdx[field] = idx;
    }
  }

  // Headers explicitly mapped (so they should NOT auto-flow into custom_variables)
  const mappedHeaders = new Set<string>();
  for (const field of STANDARD_FIELDS) {
    const v = mappingRecord[field];
    if (typeof v === 'string') mappedHeaders.add(v);
  }
  const customMapping = mapping.custom_variables_mapping ?? {};
  for (const header of Object.values(customMapping)) {
    if (header) mappedHeaders.add(header);
  }

  const result: LeadCreatePayload[] = [];
  const seenEmails = new Set<string>();

  for (const row of rows) {
    const rawEmail = (row[emailIdx] ?? '').trim().toLowerCase();
    if (!rawEmail || !EMAIL_RE.test(rawEmail)) continue;
    if (seenEmails.has(rawEmail)) continue;
    seenEmails.add(rawEmail);

    const lead: LeadCreatePayload = { email: rawEmail };

    const leadRecord = lead as unknown as Record<string, unknown>;
    // Параллельно собираем «зеркало» стандартных полей в custom_variables
    // под snake_case ключами. Зачем: Instantly умеет подставлять
    // стандартные поля в шаблон ТОЛЬКО через camelCase (`{{firstName}}`,
    // `{{companyName}}`). Если в body клиента остался старый чип
    // `{{company_name}}` (так показывал портал до фикса), без зеркала
    // плейсхолдер уйдёт литералом в письмо. С зеркалом — подставится
    // через custom_variable с тем же snake_case ключом.
    const snakeCaseMirror: Record<string, string> = {};
    for (const field of STANDARD_FIELDS) {
      if (field === 'email') continue;
      const idx = standardIdx[field];
      if (idx === undefined) continue;
      const val = (row[idx] ?? '').toString().trim();
      if (val) {
        leadRecord[field] = val;
        snakeCaseMirror[field] = val;
      }
    }

    const customVars: Record<string, string> = { ...snakeCaseMirror };

    for (const [varKey, headerName] of Object.entries(customMapping)) {
      const idx = indexByHeader.get(headerName);
      if (idx === undefined) continue;
      const val = (row[idx] ?? '').toString().trim();
      if (val) customVars[varKey] = val;
    }

    headers.forEach((header, i) => {
      if (mappedHeaders.has(header)) return;
      const val = (row[i] ?? '').toString().trim();
      if (val) customVars[header] = val;
    });

    if (Object.keys(customVars).length > 0) {
      lead.custom_variables = customVars;
    }

    result.push(lead);
  }

  return result;
}
