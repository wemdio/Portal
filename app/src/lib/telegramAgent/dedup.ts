import { supabaseAdmin } from '@/lib/supabaseAdmin';

function ensureAdmin() {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');
  return supabaseAdmin;
}

type DedupField = 'email' | 'site';

const TABLE_CONFIG: Record<string, {
  resultTable: string;
  jobTable: string;
  emailCol: string | null;
  siteCol: string | null;
}> = {
  hh: {
    resultTable: 'hh_vacancies',
    jobTable: 'parser_jobs',
    emailCol: null,
    siteCol: 'company_site_url',
  },
  search: {
    resultTable: 'search_results',
    jobTable: 'search_parser_jobs',
    emailCol: 'email',
    siteCol: 'site',
  },
  yandex_maps: {
    resultTable: 'yandex_maps_organizations',
    jobTable: 'yandex_maps_jobs',
    emailCol: 'email',
    siteCol: 'website',
  },
};

async function resolveParserType(jobId: string): Promise<string | null> {
  const sb = ensureAdmin();
  for (const [type, cfg] of Object.entries(TABLE_CONFIG)) {
    const { data } = await sb.from(cfg.jobTable).select('id').eq('id', jobId).maybeSingle();
    if (data) return type;
  }
  return null;
}

function countFilled(row: Record<string, unknown>): number {
  return Object.values(row).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').length;
}

export async function deduplicateByField(
  jobId: string,
  field: DedupField,
  parserType?: string,
  removeEmpty?: boolean,
): Promise<{ removed: number; total: number } | string> {
  const sb = ensureAdmin();

  const resolvedType = parserType || await resolveParserType(jobId);
  if (!resolvedType) return 'Задача не найдена.';

  const cfg = TABLE_CONFIG[resolvedType];
  if (!cfg) return `Неизвестный тип парсера: ${resolvedType}`;

  const dedupCol = field === 'email' ? cfg.emailCol : cfg.siteCol;
  if (!dedupCol) {
    if (field === 'email' && cfg.siteCol) {
      return deduplicateByField(jobId, 'site', resolvedType);
    }
    return `Таблица ${cfg.resultTable} не содержит колонки для дедупликации по ${field}.`;
  }

  const { data: rows, error } = await sb
    .from(cfg.resultTable)
    .select('*')
    .eq('job_id', jobId);

  if (error) return `Ошибка: ${error.message}`;
  if (!rows?.length) return 'Нет записей.';

  type Row = Record<string, unknown> & { id: string };
  const typedRows = rows as Row[];

  const groups = new Map<string, Row[]>();
  const noKey: Row[] = [];

  for (const row of typedRows) {
    const val = String(row[dedupCol] ?? '').trim().toLowerCase();
    if (!val) {
      noKey.push(row);
      continue;
    }
    const existing = groups.get(val);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(val, [row]);
    }
  }

  const idsToDelete: string[] = [];

  if (removeEmpty) {
    for (const row of noKey) idsToDelete.push(row.id);
  }

  for (const [, group] of groups) {
    if (group.length <= 1) continue;
    group.sort((a, b) => countFilled(b) - countFilled(a));
    for (let i = 1; i < group.length; i++) {
      idsToDelete.push(group[i].id);
    }
  }

  if (idsToDelete.length === 0) return { removed: 0, total: typedRows.length };

  for (let i = 0; i < idsToDelete.length; i += 500) {
    const batch = idsToDelete.slice(i, i + 500);
    const { error: delErr } = await sb
      .from(cfg.resultTable)
      .delete()
      .in('id', batch);
    if (delErr) return `Ошибка удаления: ${delErr.message}`;
  }

  return { removed: idsToDelete.length, total: typedRows.length };
}
