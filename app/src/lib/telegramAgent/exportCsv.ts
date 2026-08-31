import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveHhEmployerId } from '@/lib/parsers/hhEmployerId';

function ensureAdmin() {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');
  return supabaseAdmin;
}

type ExportResult = { buffer: Buffer; filename: string; rowCount: number };

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvBuffer(headers: string[], rows: Record<string, unknown>[]): Buffer {
  const bom = '\uFEFF';
  const headerLine = headers.map(escapeCsvField).join(',');
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCsvField(row[h])).join(','),
  );
  return Buffer.from(bom + [headerLine, ...dataLines].join('\r\n'), 'utf-8');
}

const BATCH_SIZE = 5000;

const PARSER_CONFIGS: Record<string, {
  table: string;
  jobTable: string;
  jobIdCol: string;
  columns: string[];
  headers: string[];
  filePrefix: string;
}> = {
  hh: {
    table: 'hh_vacancies',
    jobTable: 'parser_jobs',
    jobIdCol: 'job_id',
    columns: ['vacancy_id', 'name', 'url', 'company_name', 'company_url', 'employer_id', 'company_site_url', 'company_description', 'area', 'salary_from', 'salary_to', 'salary_currency', 'industries', 'published_at'],
    headers: ['vacancy_id', 'name', 'url', 'company_name', 'company_url', 'employer_id', 'company_site_url', 'company_description', 'area', 'salary_from', 'salary_to', 'salary_currency', 'industries', 'published_at'],
    filePrefix: 'hh_vacancies',
  },
  search: {
    table: 'search_results',
    jobTable: 'search_parser_jobs',
    jobIdCol: 'job_id',
    columns: ['company_name', 'site', 'email', 'description', 'query', 'title', 'link', 'snippet', 'position'],
    headers: ['company_name', 'site', 'email', 'description', 'query', 'title', 'link', 'snippet', 'position'],
    filePrefix: 'search_results',
  },
  yandex_maps: {
    table: 'yandex_maps_organizations',
    jobTable: 'yandex_maps_jobs',
    jobIdCol: 'job_id',
    columns: ['name', 'country', 'city', 'address', 'rating', 'reviews_count', 'website', 'email', 'phone', 'telegram', 'vk', 'instagram', 'whatsapp', 'card_url', 'working_hours', 'categories'],
    headers: ['name', 'country', 'city', 'address', 'rating', 'reviews_count', 'website', 'email', 'phone', 'telegram', 'vk', 'instagram', 'whatsapp', 'card_url', 'working_hours', 'categories'],
    filePrefix: 'yandex_maps',
  },
};

async function resolveParserType(jobId: string): Promise<string | null> {
  const sb = ensureAdmin();

  const { data: hhJob } = await sb
    .from('parser_jobs')
    .select('id')
    .eq('id', jobId)
    .maybeSingle();
  if (hhJob) return 'hh';

  const { data: searchJob } = await sb
    .from('search_parser_jobs')
    .select('id')
    .eq('id', jobId)
    .maybeSingle();
  if (searchJob) return 'search';

  const { data: ymJob } = await sb
    .from('yandex_maps_jobs')
    .select('id')
    .eq('id', jobId)
    .maybeSingle();
  if (ymJob) return 'yandex_maps';

  return null;
}

export async function exportParserResults(
  jobId: string,
  parserType?: string,
): Promise<ExportResult | string> {
  const resolvedType = parserType || await resolveParserType(jobId);
  if (!resolvedType) return 'Задача не найдена. Укажите корректный job_id.';

  const config = PARSER_CONFIGS[resolvedType];
  if (!config) return `Неизвестный тип парсера: ${resolvedType}. Доступны: hh, search, yandex_maps.`;

  const sb = ensureAdmin();

  const allRows: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await sb
      .from(config.table)
      .select(config.columns.join(','))
      .eq(config.jobIdCol, jobId)
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) return `Ошибка при выборке данных: ${error.message}`;
    if (!data || data.length === 0) break;

    allRows.push(...(data as unknown as Record<string, unknown>[]));
    offset += data.length;
    hasMore = data.length === BATCH_SIZE;
  }

  if (allRows.length === 0) return 'Результатов для этой задачи нет. Возможно, парсер ещё работает или задача пуста.';

  if (resolvedType === 'hh') {
    for (const row of allRows) {
      row.employer_id = resolveHhEmployerId(
        row.employer_id as string | null | undefined,
        row.company_url as string | null | undefined,
      );
    }
  }

  const buffer = buildCsvBuffer(config.headers, allRows);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${config.filePrefix}_${dateStr}_${jobId.slice(0, 8)}.csv`;

  return { buffer, filename, rowCount: allRows.length };
}
