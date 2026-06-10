// "Crunchbase-style" funded-companies catalog (YC OSS + SEC Form D + PDL enrich):
// row type, Russian labels, funding formatting, and the synthesized description.
// Shared by the filter UI and the API routes.

import { countryLabelRu } from '@/lib/companyBase/labels';

export { countryLabelRu };

export interface FundedCompanyRow {
  id: string;
  source: string;
  name: string;
  website: string | null;
  description: string | null;
  short_description: string | null;
  industry: string | null;
  country: string | null;
  region: string | null;
  locality: string | null;
  founded: number | null;
  linkedin_url: string | null;
  total_funding_usd: number | null;
  last_funding_usd: number | null;
  last_funding_type: string | null;
  last_funding_date: string | null;
  num_funding_rounds: number | null;
  investors: string | null;
  funding_detail: unknown;
  source_url: string | null;
  batch: string | null;
  stage: string | null;
  team_size: number | null;
  tags: string[] | null;
  created_at?: string;
  updated_at?: string;
}

export interface FundedFilters {
  source?: string[];
  country?: string[];
  industry?: string[];
  stage?: string[];
  hasFunding?: boolean;
  minFunding?: number;
  fundedSince?: string; // YYYY-MM-DD
  name?: string;
  limit?: number;
  offset?: number;
}

// ── Sources ────────────────────────────────────────────────────────────────
export const SOURCES: { code: string; label: string; attribution: string }[] = [
  { code: 'yc', label: 'Y Combinator', attribution: 'Y Combinator (yc-oss/api), public dataset' },
  { code: 'sec_formd', label: 'SEC Form D (US)', attribution: 'U.S. SEC EDGAR Form D — public domain' },
  { code: 'pdl', label: 'People Data Labs', attribution: 'People Data Labs, CC BY 4.0' },
  { code: 'brightdata', label: 'Bright Data (Crunchbase)', attribution: 'Bright Data Crunchbase dataset' },
];
const SOURCE_LABEL = new Map(SOURCES.map((s) => [s.code, s.label]));
export function sourceLabelRu(code: string | null | undefined): string {
  if (!code) return '';
  return SOURCE_LABEL.get(code) ?? code;
}

// Attribution lines for whichever sources are present in an export.
export function attributionFor(sourceCodes: string[]): string {
  const set = new Set(sourceCodes.filter(Boolean));
  const lines = SOURCES.filter((s) => set.has(s.code)).map((s) => s.attribution);
  return lines.length ? lines.join(' | ') : 'Sources: YC, SEC EDGAR, People Data Labs';
}

// ── Funding stage / type ─────────────────────────────────────────────────────
const STAGE_LABELS_RU: Record<string, string> = {
  pre_seed: 'Pre-seed',
  seed: 'Seed',
  angel: 'Ангел',
  series_a: 'Series A',
  series_b: 'Series B',
  series_c: 'Series C',
  series_d: 'Series D',
  series_unknown: 'Венчурный раунд',
  grant: 'Грант',
  debt: 'Долговое финансирование',
  convertible_note: 'Конвертируемый заём',
  ipo: 'IPO',
  reg_d: 'Reg D (Form D)', // SEC private placement
  equity: 'Equity (Form D)',
  other: 'Прочее',
};
export function stageLabelRu(value: string | null | undefined): string {
  if (!value) return '';
  return STAGE_LABELS_RU[value] ?? value.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

// ── Industry (mixed enums across sources) ────────────────────────────────────
const INDUSTRY_LABELS_RU: Record<string, string> = {
  // YC-style
  fintech: 'Финтех',
  'b2b': 'B2B',
  'consumer': 'Потребительский',
  healthcare: 'Здравоохранение',
  'real estate and construction': 'Недвижимость и строительство',
  education: 'Образование',
  'government': 'Госсектор',
  'industrials': 'Промышленность',
  // SEC Form D industry groups (lowercased)
  technology: 'Технологии',
  'health care': 'Здравоохранение',
  'commercial': 'Коммерция',
  'real estate': 'Недвижимость',
  energy: 'Энергетика',
  'financial services': 'Финансовые услуги',
  manufacturing: 'Производство',
  retailing: 'Розница',
  'travel': 'Путешествия',
  agriculture: 'Сельское хозяйство',
};
export function industryLabelRu(value: string | null | undefined): string {
  if (!value) return '';
  return INDUSTRY_LABELS_RU[value.toLowerCase()] ?? value.replace(/\b\w/g, (m) => m.toUpperCase());
}

// ── Funding amount formatting ────────────────────────────────────────────────
// Human-readable ($1.2M / $3.4B) for the UI; raw integer USD for exports.
export function fundingHuman(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return '';
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(usd >= 10_000_000_000 ? 0 : 1)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd >= 10_000_000 ? 0 : 1)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${usd}`;
}

// Best single funding number for a row (last round, else cumulative).
export function bestFundingUsd(r: Pick<FundedCompanyRow, 'last_funding_usd' | 'total_funding_usd'>): number | null {
  return r.last_funding_usd ?? r.total_funding_usd ?? null;
}

export function hasFunding(r: Pick<FundedCompanyRow, 'last_funding_usd' | 'total_funding_usd' | 'last_funding_date'>): boolean {
  return r.last_funding_usd != null || r.total_funding_usd != null || r.last_funding_date != null;
}

// Tier-1 synthesized description when prose is missing: industry + place + stage.
export function synthDescription(
  row: Pick<FundedCompanyRow, 'short_description' | 'industry' | 'country' | 'locality' | 'last_funding_type'>,
): string {
  if (row.short_description) return row.short_description;
  const place = [row.locality, countryLabelRu(row.country)].filter(Boolean).join(', ');
  const parts = [industryLabelRu(row.industry), place, stageLabelRu(row.last_funding_type)].filter(Boolean);
  return parts.join(' · ');
}

export function descriptionOf(r: FundedCompanyRow): string {
  return r.description || synthDescription(r);
}

// ── Export ───────────────────────────────────────────────────────────────────
// Name / Site / Description first (the must-haves), then enrichment, then funding.
export const EXPORT_HEADER = [
  'Company',
  'Site',
  'Description',
  'Industry',
  'Country',
  'City',
  'Founded',
  'TotalFundingUSD',
  'LastRoundUSD',
  'LastRoundType',
  'LastRoundDate',
  'Rounds',
  'Investors',
  'Batch',
  'LinkedIn',
  'Source',
  'SourceURL',
] as const;

export function exportRow(r: FundedCompanyRow): string[] {
  return [
    r.name,
    r.website ?? '',
    descriptionOf(r),
    industryLabelRu(r.industry),
    countryLabelRu(r.country),
    r.locality ?? '',
    r.founded != null ? String(r.founded) : '',
    r.total_funding_usd != null ? String(r.total_funding_usd) : '',
    r.last_funding_usd != null ? String(r.last_funding_usd) : '',
    stageLabelRu(r.last_funding_type),
    r.last_funding_date ?? '',
    r.num_funding_rounds != null ? String(r.num_funding_rounds) : '',
    r.investors ?? '',
    r.batch ?? '',
    r.linkedin_url ?? '',
    sourceLabelRu(r.source),
    r.source_url ?? '',
  ];
}
