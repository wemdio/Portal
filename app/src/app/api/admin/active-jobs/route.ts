import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isClient } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * Список job-таблиц, по которым агрегируем «активные задачи» в админке
 * /admin/traces. Зеркалирует services/health-check/main.py:_JOB_TABLES
 * чтобы счётчики в боте и в админке совпадали — если добавляешь новую
 * таблицу здесь, добавь и туда (и наоборот).
 *
 * `activeStatuses` — какие статусы считаются «в работе» для данной таблицы
 * (у разных воркеров терминология отличается: где-то pending+running,
 * где-то processing, у DFYB вообще planning/parsing/processing).
 *
 * `failedStatuses` — какие статусы трактуем как «ошибку» для 24h-секции.
 * По умолчанию `['failed']`, но у некоторых таблиц может быть свой набор.
 *
 * `timestampField` — какое поле использовать для фильтра «за последние 24ч».
 * По умолчанию `created_at`, у некоторых — `finished_at`/`completed_at`.
 */
type JobTableConfig = {
  table: string;
  label: string;
  activeStatuses: string[];
  failedStatuses?: string[];
  timestampField?: string;
};

const JOB_TABLES: JobTableConfig[] = [
  { table: 'ai_caller_jobs',          label: 'AI Звонилка',      activeStatuses: ['pending', 'running'] },
  { table: 'ai_campaigns',            label: 'AI Кампании',      activeStatuses: ['running'] },
  { table: 'parser_jobs',             label: 'HH Парсер',        activeStatuses: ['pending', 'running'] },
  { table: 'search_parser_jobs',      label: 'Поисковый парсер', activeStatuses: ['pending', 'running'] },
  { table: 'tg_outreach_jobs',        label: 'TG Аутрич',        activeStatuses: ['pending', 'running'] },
  { table: 'tg_outreach_campaigns',   label: 'TG Кампании',      activeStatuses: ['running'] },
  { table: 'email_validation_jobs',   label: 'Email валидация',  activeStatuses: ['pending', 'running'] },
  { table: 'website_enrichment_jobs', label: 'Обогащение',       activeStatuses: ['preparing', 'pending', 'running'] },
  { table: 'brief_scoring_jobs',      label: 'Скоринг брифов',   activeStatuses: ['pending', 'running'] },
  { table: 'yandex_maps_jobs',        label: 'Яндекс Карты',     activeStatuses: ['pending', 'running'] },
  { table: 'lead_import_jobs',        label: 'Импорт лидов',     activeStatuses: ['pending', 'running'] },
  { table: 'sales_copilot_jobs',      label: 'Sales Copilot',    activeStatuses: ['pending', 'running'] },
  { table: 'tg_scan_jobs',            label: 'TG Сканер',        activeStatuses: ['pending', 'running'] },
  { table: 'lpr_jobs',                label: 'LPR Discovery',    activeStatuses: ['pending', 'running'] },
  { table: 'dfyb_jobs',               label: 'DFYB',             activeStatuses: ['planning', 'parsing', 'processing'] },
  { table: 'base_constructor_jobs',   label: 'Конструктор баз',  activeStatuses: ['pending', 'processing'] },
];

type RawActiveRow = { user_id: string | null; status: string };
type RawFailedRow = { id: string; user_id: string | null; error_message: string | null; created_at: string };

type AggregatedToolEntry = {
  table: string;
  label: string;
  total: number;
  breakdown: Record<string, number>;
};

type FailedItem = {
  id: string;
  user_id: string | null;
  user_name: string | null;
  error_message: string | null;
  created_at: string;
};

type FailedToolEntry = {
  table: string;
  label: string;
  count: number;
  items: FailedItem[];
};

type Bucket = 'specialists' | 'clients';

async function fetchTableStats(
  cfg: JobTableConfig,
): Promise<{ active: RawActiveRow[]; failed: RawFailedRow[] }> {
  if (!supabaseAdmin) return { active: [], failed: [] };

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const failedStatuses = cfg.failedStatuses ?? ['failed'];
  const timestampField = cfg.timestampField ?? 'created_at';

  // Каждый запрос в try-catch: если таблица отсутствует в текущей схеме,
  // или у неё нет user_id / error_message / created_at — мы не валим
  // весь endpoint, просто скипаем эту таблицу (как делает health-check).
  let active: RawActiveRow[] = [];
  try {
    const { data, error } = await supabaseAdmin
      .from(cfg.table)
      .select('user_id, status')
      .in('status', cfg.activeStatuses);
    if (!error && data) active = data as RawActiveRow[];
  } catch {
    /* skip — таблица или колонка отсутствует */
  }

  let failed: RawFailedRow[] = [];
  try {
    const { data, error } = await supabaseAdmin
      .from(cfg.table)
      .select(`id, user_id, error_message, ${timestampField}`)
      .in('status', failedStatuses)
      .gte(timestampField, cutoff)
      .order(timestampField, { ascending: false })
      .limit(50);
    if (!error && data) {
      failed = (data as unknown as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        user_id: (row.user_id as string | null) ?? null,
        error_message: (row.error_message as string | null) ?? null,
        created_at: String(row[timestampField] ?? new Date().toISOString()),
      }));
    }
  } catch {
    /* skip */
  }

  return { active, failed };
}

function classifyBucket(role: UserRole | null | undefined): Bucket {
  // user_id=null или роль без записи в profiles → considered "specialist"
  // (worker-only jobs, internal automation). Только явные клиенты идут в
  // клиентскую колонку.
  return isClient(role ?? null) ? 'clients' : 'specialists';
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  // 1. Параллельно опрашиваем все 16 таблиц.
  const perTable = await Promise.all(
    JOB_TABLES.map((cfg) => fetchTableStats(cfg).then((res) => ({ cfg, ...res }))),
  );

  // 2. Собираем все уникальные user_id, чтобы одним запросом подтянуть
  //    роли + имена. Без этого пришлось бы делать N+1 запросов.
  const userIds = new Set<string>();
  for (const { active, failed } of perTable) {
    for (const r of active) if (r.user_id) userIds.add(r.user_id);
    for (const r of failed) if (r.user_id) userIds.add(r.user_id);
  }

  const userMap = new Map<string, { role: UserRole | null; full_name: string | null }>();
  if (userIds.size > 0) {
    const { data: profs } = await supabaseAdmin
      .from('profiles')
      .select('id, role, full_name')
      .in('id', Array.from(userIds));
    for (const p of profs ?? []) {
      userMap.set(p.id as string, {
        role: (p.role as UserRole | null) ?? null,
        full_name: (p.full_name as string | null) ?? null,
      });
    }
  }

  // 3. Агрегируем активные задачи по колонкам.
  const activeBy: Record<Bucket, AggregatedToolEntry[]> = {
    specialists: [],
    clients: [],
  };
  const errorsBy: Record<Bucket, FailedToolEntry[]> = {
    specialists: [],
    clients: [],
  };

  for (const { cfg, active, failed } of perTable) {
    // ── активные ───
    const bucketRows: Record<Bucket, Record<string, number>> = {
      specialists: {},
      clients: {},
    };
    for (const row of active) {
      const role = row.user_id ? userMap.get(row.user_id)?.role ?? null : null;
      const bucket = classifyBucket(role);
      bucketRows[bucket][row.status] = (bucketRows[bucket][row.status] ?? 0) + 1;
    }
    for (const bucket of ['specialists', 'clients'] as Bucket[]) {
      const breakdown = bucketRows[bucket];
      const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
      if (total > 0) {
        activeBy[bucket].push({ table: cfg.table, label: cfg.label, total, breakdown });
      }
    }

    // ── ошибки 24ч ───
    const bucketFailed: Record<Bucket, FailedItem[]> = {
      specialists: [],
      clients: [],
    };
    for (const row of failed) {
      const profile = row.user_id ? userMap.get(row.user_id) : null;
      const bucket = classifyBucket(profile?.role ?? null);
      bucketFailed[bucket].push({
        id: row.id,
        user_id: row.user_id,
        user_name: profile?.full_name ?? null,
        error_message: row.error_message,
        created_at: row.created_at,
      });
    }
    for (const bucket of ['specialists', 'clients'] as Bucket[]) {
      const items = bucketFailed[bucket];
      if (items.length > 0) {
        errorsBy[bucket].push({
          table: cfg.table,
          label: cfg.label,
          count: items.length,
          items,
        });
      }
    }
  }

  // 4. Сортируем по total убывая (как health-check bot).
  for (const bucket of ['specialists', 'clients'] as Bucket[]) {
    activeBy[bucket].sort((a, b) => b.total - a.total);
    errorsBy[bucket].sort((a, b) => b.count - a.count);
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    active: activeBy,
    errors_24h: errorsBy,
    totals: {
      active_specialists: activeBy.specialists.reduce((s, e) => s + e.total, 0),
      active_clients: activeBy.clients.reduce((s, e) => s + e.total, 0),
      errors_specialists: errorsBy.specialists.reduce((s, e) => s + e.count, 0),
      errors_clients: errorsBy.clients.reduce((s, e) => s + e.count, 0),
    },
  });
}
