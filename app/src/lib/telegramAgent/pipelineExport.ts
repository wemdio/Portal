import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveHhEmployerId } from '@/lib/parsers/hhEmployerId';
import type { Pipeline, PipelineStep } from './pipeline';

type ExportResult = { buffer: Buffer; filename: string; rowCount: number };

function ensureAdmin() {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');
  return supabaseAdmin;
}

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(headers: string[], rows: Record<string, unknown>[]): Buffer {
  const bom = '\uFEFF';
  const headerLine = headers.map(escapeCsv).join(',');
  const dataLines = rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(','));
  return Buffer.from(bom + [headerLine, ...dataLines].join('\r\n'), 'utf-8');
}

function findStep(pipeline: Pipeline, type: string): PipelineStep | undefined {
  return pipeline.steps.find((s) => s.type === type && s.status === 'completed' && s.job_id);
}

function findParserStep(pipeline: Pipeline): PipelineStep | undefined {
  return pipeline.steps.find(
    (s) => ['parse_hh', 'parse_search', 'parse_yandex_maps'].includes(s.type) && s.status === 'completed' && s.job_id,
  );
}

export async function exportPipelineResults(pipeline: Pipeline): Promise<ExportResult | string> {
  const parserStep = findParserStep(pipeline);
  if (!parserStep?.job_id) return 'Нет завершённого шага парсинга.';

  const enrichStep = findStep(pipeline, 'enrich_emails');
  const validateStep = findStep(pipeline, 'validate_emails');

  switch (parserStep.type) {
    case 'parse_hh':
      return exportHhPipeline(parserStep.job_id, enrichStep?.job_id, validateStep?.job_id, pipeline.name);
    case 'parse_search':
      return exportSearchPipeline(parserStep.job_id, enrichStep?.job_id, validateStep?.job_id, pipeline.name);
    case 'parse_yandex_maps':
      return exportYandexMapsPipeline(parserStep.job_id, enrichStep?.job_id, validateStep?.job_id, pipeline.name);
    default:
      return 'Неизвестный тип парсера для экспорта.';
  }
}

async function loadEnrichmentMap(enrichJobId: string): Promise<Map<string, string[]>> {
  const sb = ensureAdmin();
  const map = new Map<string, string[]>();

  const { data } = await sb
    .from('website_enrichment_queue')
    .select('url_normalized, result_text')
    .eq('job_id', enrichJobId)
    .eq('status', 'completed')
    .not('result_text', 'is', null);

  for (const row of data ?? []) {
    const url = String(row.url_normalized ?? '').toLowerCase();
    const emails = String(row.result_text ?? '')
      .split(/[\n,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@'));
    if (url && emails.length > 0) {
      map.set(url, emails);
    }
  }
  return map;
}

async function loadValidationMap(validateJobId: string): Promise<Map<string, { result: string; quality: string }>> {
  const sb = ensureAdmin();
  const map = new Map<string, { result: string; quality: string }>();

  const { data } = await sb
    .from('email_validation_queue')
    .select('email_normalized, result, quality')
    .eq('job_id', validateJobId)
    // Только финальные строки: с 2026-07 requeueItem сохраняет предварительный
    // вердикт и на PENDING (отложенных) строках — они не должны попадать в
    // экспорт как окончательные.
    .in('status', ['completed', 'failed'])
    .not('result', 'is', null);

  for (const row of data ?? []) {
    const email = String(row.email_normalized ?? '').toLowerCase();
    if (email) {
      map.set(email, { result: String(row.result ?? ''), quality: String(row.quality ?? '') });
    }
  }
  return map;
}

async function exportHhPipeline(
  parserJobId: string,
  enrichJobId?: string | null,
  validateJobId?: string | null,
  _pipelineName?: string,
): Promise<ExportResult | string> {
  const sb = ensureAdmin();

  const { data: vacancies } = await sb
    .from('hh_vacancies')
    .select('company_name, employer_id, company_url, company_site_url, name, url, area, salary_from, salary_to, salary_currency, published_at')
    .eq('job_id', parserJobId);

  if (!vacancies?.length) return 'Нет вакансий для экспорта.';

  const enrichMap = enrichJobId ? await loadEnrichmentMap(enrichJobId) : new Map();
  const validateMap = validateJobId ? await loadValidationMap(validateJobId) : new Map();
  const hasEnrich = enrichMap.size > 0;
  const hasValidate = validateMap.size > 0;

  const headers = ['company_name', 'employer_id', 'company_site_url', 'vacancy', 'vacancy_url', 'area', 'salary_from', 'salary_to', 'salary_currency', 'published_at'];
  if (hasEnrich) headers.push('email');
  if (hasValidate) headers.push('email_result', 'email_quality');

  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const v of vacancies as Record<string, unknown>[]) {
    const siteUrl = String(v.company_site_url ?? '').toLowerCase();
    const emails = enrichMap.get(siteUrl) ?? [];
    const exportVacancy = {
      ...v,
      employer_id: resolveHhEmployerId(
        v.employer_id as string | null | undefined,
        v.company_url as string | null | undefined,
      ),
      vacancy: v.name,
      vacancy_url: v.url,
    };

    if (emails.length === 0) {
      const key = `${v.company_name}|${siteUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...exportVacancy, email: '', email_result: '', email_quality: '' });
    } else {
      for (const email of emails) {
        const key = `${v.company_name}|${email}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const val = validateMap.get(email);
        rows.push({
          ...exportVacancy,
          email, email_result: val?.result ?? '', email_quality: val?.quality ?? '',
        });
      }
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  return { buffer: buildCsv(headers, rows), filename: `pipeline_hh_${dateStr}.csv`, rowCount: rows.length };
}

async function exportSearchPipeline(
  parserJobId: string,
  enrichJobId?: string | null,
  validateJobId?: string | null,
  _pipelineName?: string,
): Promise<ExportResult | string> {
  const sb = ensureAdmin();

  const { data: results } = await sb
    .from('search_results')
    .select('company_name, site, email, title, link, snippet')
    .eq('job_id', parserJobId);

  if (!results?.length) return 'Нет результатов поиска для экспорта.';

  const enrichMap = enrichJobId ? await loadEnrichmentMap(enrichJobId) : new Map();
  const validateMap = validateJobId ? await loadValidationMap(validateJobId) : new Map();
  const hasEnrich = enrichMap.size > 0;
  const hasValidate = validateMap.size > 0;

  const headers = ['company_name', 'site', 'title', 'link'];
  if (hasEnrich) headers.push('email');
  else headers.push('email');
  if (hasValidate) headers.push('email_result', 'email_quality');

  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const r of results as Record<string, unknown>[]) {
    const siteUrl = String(r.site ?? '').toLowerCase();
    const enrichedEmails = enrichMap.get(siteUrl) ?? [];
    const existingEmail = String(r.email ?? '').trim();
    const allEmails = [...new Set([...enrichedEmails, ...(existingEmail ? [existingEmail.toLowerCase()] : [])])];

    if (allEmails.length === 0) {
      const key = `${r.company_name}|${siteUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...r, email: '', email_result: '', email_quality: '' });
    } else {
      for (const email of allEmails) {
        const key = `${r.company_name}|${email}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const val = validateMap.get(email);
        rows.push({ ...r, email, email_result: val?.result ?? '', email_quality: val?.quality ?? '' });
      }
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  return { buffer: buildCsv(headers, rows), filename: `pipeline_search_${dateStr}.csv`, rowCount: rows.length };
}

async function exportYandexMapsPipeline(
  parserJobId: string,
  enrichJobId?: string | null,
  validateJobId?: string | null,
  _pipelineName?: string,
): Promise<ExportResult | string> {
  const sb = ensureAdmin();

  const { data: orgs } = await sb
    .from('yandex_maps_organizations')
    .select('name, city, address, website, email, phone, rating, reviews_count, categories')
    .eq('job_id', parserJobId);

  if (!orgs?.length) return 'Нет организаций для экспорта.';

  const enrichMap = enrichJobId ? await loadEnrichmentMap(enrichJobId) : new Map();
  const validateMap = validateJobId ? await loadValidationMap(validateJobId) : new Map();
  const hasValidate = validateMap.size > 0;

  const headers = ['name', 'city', 'address', 'website', 'email', 'phone', 'rating', 'reviews_count', 'categories'];
  if (hasValidate) headers.push('email_result', 'email_quality');

  const rows: Record<string, unknown>[] = [];

  for (const o of orgs as Record<string, unknown>[]) {
    const siteUrl = String(o.website ?? '').toLowerCase();
    const enrichedEmails = enrichMap.get(siteUrl) ?? [];
    const existingEmail = String(o.email ?? '').trim();
    const allEmails = [...new Set([...enrichedEmails, ...(existingEmail ? [existingEmail.toLowerCase()] : [])])];

    if (allEmails.length === 0) {
      rows.push({ ...o, email_result: '', email_quality: '' });
    } else {
      for (const email of allEmails) {
        const val = validateMap.get(email);
        rows.push({ ...o, email, email_result: val?.result ?? '', email_quality: val?.quality ?? '' });
      }
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  return { buffer: buildCsv(headers, rows), filename: `pipeline_yandex_maps_${dateStr}.csv`, rowCount: rows.length };
}
