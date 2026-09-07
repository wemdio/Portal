/** Derived presentation data only. `company` stays unchanged for identity and relevance. */
export interface VeCompanyName {
  version: 1;
  source: string;
  website: string;
  status: 'ready' | 'failed';
  value: string;
}

export interface VeCompanyNameCleanupSummary {
  status: 'complete' | 'partial';
  companies: number;
  checked: number;
  failed: number;
  error?: string;
}

export const VE_COMPANY_NAME_FIELD = '_ve_company_name';

export function companyNameSource(row: Record<string, unknown>): { source: string; website: string } {
  return { source: String(row.company ?? '').trim(), website: String(row.website ?? '').trim() };
}

/** Missing metadata is legacy/upload data; never reinterpret an old base at read time. */
export function isCompanyNameReady(row: Record<string, unknown>): boolean {
  if (!(VE_COMPANY_NAME_FIELD in row)) return true;
  const meta = row[VE_COMPANY_NAME_FIELD] as Partial<VeCompanyName> | null;
  const current = companyNameSource(row);
  return !!meta && meta.version === 1 && meta.status === 'ready'
    && meta.source === current.source && meta.website === current.website
    && typeof meta.value === 'string' && meta.value.trim().length > 0;
}

/** Only the canonical auto-base company column is projected; custom mappings keep their meaning. */
export function companyNameCell(row: Record<string, unknown>, column: string): unknown {
  if (column !== 'company' || !(VE_COMPANY_NAME_FIELD in row)) return row[column];
  return isCompanyNameReady(row) ? (row[VE_COMPANY_NAME_FIELD] as VeCompanyName).value : '';
}

export function projectCompanyNames(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => VE_COMPANY_NAME_FIELD in row ? { ...row, company: companyNameCell(row, 'company') } : row);
}
