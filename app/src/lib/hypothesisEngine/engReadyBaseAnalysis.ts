import { heCompanySiteIdentity, normalizeCompanyForDedup } from './collectionIdentity';
import { readHeEngSourceCountry } from './engCompanyCountry';
import { partitionHeEngCollectionRows, type HeEngCollectionRow, type HeEngCollectionStopReason } from './engCollectionTarget';
import { HeBaseAnalysisSchema } from './schemas';
import type { HeBaseAnalysis, HeDistributionEntry } from './types';

function distribution(values: string[]): HeDistributionEntry[] {
  if (!values.length) return [];
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, 12);
  if (sorted.length > top.length) top.push(['Other recorded categories', sorted.slice(12).reduce((n, [, count]) => n + count, 0)]);
  return top.map(([value, count]) => ({ value, share_pct: Math.round(count / values.length * 10_000) / 100 }));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

/**
 * Factual, free summary of the first ready batch. Call only after the ENG
 * qualification/country/DNC gates. Reserve contacts never influence segments
 * or letter suggestions. Missing roles/services are not inferred from names.
 */
export function buildHeEngReadyBaseAnalysis(
  readyRows: readonly HeEngCollectionRow[],
  options: { reserveCount?: number; stopReason?: HeEngCollectionStopReason | null } = {},
): HeBaseAnalysis {
  // The input has already passed the frozen project/company cap. The maximum
  // here merely avoids imposing a different default cap on a configured base.
  const rows = partitionHeEngCollectionRows(readyRows, { maxEmailsPerCompany: 100 }).readyRows;
  const companies = new Set(rows.map((row) => heCompanySiteIdentity(row.website)?.host ||
    normalizeCompanyForDedup(text(row.company)) || text(row.email)));
  const ok = rows.filter((row) => row._email_status === 'ok').length;
  const catchAll = rows.length - ok;
  const countries = rows.map((row) => readHeEngSourceCountry(row)?.country ?? 'Not recorded');
  const categories = rows.map((row) => text(row.category) || 'Not recorded');
  const reserveCount = typeof options.reserveCount === 'number' && Number.isSafeInteger(options.reserveCount)
    ? Math.max(0, options.reserveCount) : 0;
  return HeBaseAnalysisSchema.parse({
    geo_distribution: distribution(countries),
    industry_distribution: categories.every((value) => value === 'Not recorded') ? [] : distribution(categories),
    company_type_distribution: [],
    title_distribution: [],
    notable_segments: rows.length ? [`${companies.size} companies in the ready contact batch.`] : [],
    data_quality_notes: `${rows.length} unique ready contacts: ${ok} OK and ${catchAll} catch-all. ` +
      `${reserveCount} reserve contacts are stored separately and are not included in this summary. ` +
      (options.stopReason ? 'Collection stopped before filling all requested contacts; see the collection status for the reason. ' : '') +
      'Distributions use recorded metadata only; job roles and company services are not inferred.',
    recommended_angles: [],
  });
}
