/**
 * Отчётные запросы дашборда gisSignalOutreach.
 *
 * Источники:
 *   - gis_signal_runs.funnel (jsonb { perSegment, total }) — воронка прогонов;
 *   - gis_signal_company_signals — per-сигнальный срез (16 сигналов) и
 *     скоринг-разрез (score/grade) всех проверенных компаний;
 *   - client_campaign_append_batches — durable факты заливок в Instantly
 *     (не зависят от чистки лидов у провайдера);
 *   - gis_signal_seen_companies + gis_signal_company_signals — объединение
 *     «уже обработано» для остатка пула.
 *
 * ПУБЛИЧНЫЙ КОНТРАКТ (дэшборд строится против него параллельно):
 * сигнатуры/поля интерфейсов не менять без синхронизации с фронтом.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface GisSignalFunnelRow {
  runDate: string;
  segmentKey: string;
  pulled: number;
  signalsOk: number;
  /** Прошли online-гейт. У старых прогонов (до require_online) поля нет → fallback на signalsOk. */
  onlineOk: number;
  bcIn: number;
  validContacts: number;
  appended: number;
}

/**
 * Все 16 сигнальных булевых колонок архива: 6 базовых + 10 скоринговых
 * (миграции 20260811_0003 — legal, 20260815_0001 — accounting/consulting,
 * 20260822_0001 — medicine). Срез/статы считаются по всем шестнадцати;
 * у строк, проверенных до появления колонки, значение false (DEFAULT
 * миграции) — это «сигнал не искали», и на периодных отчётах по старым
 * датам новые сигналы будут пустыми.
 */
const SIGNAL_BOOL_COLUMNS = [
  'signal_general_phone',
  'signal_contact_form',
  'signal_sales_dept',
  'signal_target_vacancy',
  'signal_high_volume',
  'signal_multi_office',
  'signal_legal_relevance',
  'signal_crm_calltracking',
  'signal_accounting_relevance',
  'signal_consulting_relevance',
  'signal_pricing_packages',
  'signal_client_segments',
  'signal_medicine_relevance',
  'signal_medicine_promo',
  'signal_medicine_premium',
  'signal_medicine_marketing_team',
] as const;

export type GisSignalBoolKey = (typeof SIGNAL_BOOL_COLUMNS)[number];

export interface GisSignalSliceRow {
  segmentKey: string;
  signalKey: GisSignalBoolKey;
  companies: number;
}

/** Диапазон по времени для периодных отчётов: [fromUtc; toExclusiveUtc), null = без границы. */
export interface GisReportRange {
  fromUtc: Date | null;
  toExclusiveUtc: Date | null;
}

/**
 * Статистика проверенных компаний за период (архив gis_signal_company_signals):
 * срез по 16 сигналам + скоринг-разрез (грейды A/B/C, отсев, медианный скор).
 * У сегментов без скоринг-профиля scored=0 и medianScore=null (грейдов нет).
 */
export interface GisSignalSegmentStats {
  segmentKey: string;
  /** Всего проверено компаний в периоде (все строки архива сегмента). */
  companies: number;
  /** Хиты каждого из 16 сигналов (bool=true). */
  signalHits: Record<GisSignalBoolKey, number>;
  /** Строк со score (только скоринг-сегменты, напр. legal). */
  scored: number;
  gradeA: number;
  gradeB: number;
  gradeC: number;
  /** score не NULL, а grade NULL — скор ниже порога профиля (отсев). */
  rejected: number;
  /** Медиана score по скоренным строкам; null, если скоринга не было. */
  medianScore: number | null;
}

/** Факты заливки в Instantly за период из client_campaign_append_batches. */
export interface GisAppendBatchTotals {
  campaignId: string;
  requested: number;
  accepted: number;
  skipped: number;
}

/** Остаток пула: сколько компаний сегмента уже обработано за всё время. */
export interface GisPoolProcessedRow {
  segmentKey: string;
  /** Компаний в дедуп-журнале (залиты в Instantly). */
  seenCount: number;
  /** Уникальных компаний в архиве проверок (twogis_id — PK/unique). */
  archiveCount: number;
  /**
   * |seen ∪ archive|: множества пересекаются (залитая компания всегда
   * проверена → есть в архиве), поэтому НЕ сумма, а объединение.
   */
  processed: number;
}

/** PostgREST режет выборку ~1000 строками — читаем страницами. */
const PAGE = 1000;

/**
 * Чанк для .in() lookup'ов по twogis_id: длинные 2GIS id (16-17 цифр) в
 * query-string упираются в 8K-лимит URL nginx (seenCompanies.ts, 06.08.2026).
 */
const SEEN_LOOKUP_CHUNK = 100;

interface RunFunnelRow {
  started_at: string;
  funnel: {
    perSegment?: Record<string, Partial<Record<'pulled' | 'signalsOk' | 'onlineOk' | 'bcIn' | 'validContacts' | 'appended', number>>>;
  } | null;
}

async function fetchRuns(sinceIso: string | null, untilIso: string | null = null): Promise<RunFunnelRow[]> {
  if (!supabaseAdmin) return [];
  const out: RunFunnelRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabaseAdmin
      .from('gis_signal_runs')
      .select('started_at, funnel')
      .not('funnel', 'is', null)
      .order('started_at', { ascending: true });
    if (sinceIso) q = q.gte('started_at', sinceIso);
    if (untilIso) q = q.lt('started_at', untilIso);
    const { data, error } = await q.range(from, from + PAGE - 1);
    // Ошибку НЕ глотаем: тихий return отдавал бы дашборду усечённые числа
    // под видом полных. Throw → роут отвечает 500.
    if (error) throw new Error(`gis_signal_runs read failed: ${error.message}`);
    const rows = (data ?? []) as RunFunnelRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function addFunnel(
  acc: Map<string, GisSignalFunnelRow>,
  key: string,
  runDate: string,
  segmentKey: string,
  counts: Record<string, number | undefined>,
): void {
  const existing = acc.get(key) ?? {
    runDate,
    segmentKey,
    pulled: 0,
    signalsOk: 0,
    onlineOk: 0,
    bcIn: 0,
    validContacts: 0,
    appended: 0,
  };
  existing.pulled += Number(counts.pulled ?? 0);
  existing.signalsOk += Number(counts.signalsOk ?? 0);
  // Старые прогоны (до require_online) не писали onlineOk — для них
  // online-гейта не существовало, честный эквивалент = signalsOk.
  existing.onlineOk += Number(counts.onlineOk ?? counts.signalsOk ?? 0);
  existing.bcIn += Number(counts.bcIn ?? 0);
  existing.validContacts += Number(counts.validContacts ?? 0);
  existing.appended += Number(counts.appended ?? 0);
  acc.set(key, existing);
}

/** Последние 7 дней, суммы per день × per сегмент (из gis_signal_runs.funnel). */
export async function getWeeklyFunnel(): Promise<GisSignalFunnelRow[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const runs = await fetchRuns(since);
  const acc = new Map<string, GisSignalFunnelRow>();
  for (const run of runs) {
    const day = String(run.started_at).slice(0, 10);
    for (const [segmentKey, counts] of Object.entries(run.funnel?.perSegment ?? {})) {
      addFunnel(acc, `${day}|${segmentKey}`, day, segmentKey, counts as Record<string, number | undefined>);
    }
  }
  return Array.from(acc.values()).sort(
    (a, b) => a.runDate.localeCompare(b.runDate) || a.segmentKey.localeCompare(b.segmentKey),
  );
}

/** За всё время, суммы per сегмент. runDate = 'all' (агрегат без разбивки по дням). */
export async function getTotalFunnel(): Promise<GisSignalFunnelRow[]> {
  const runs = await fetchRuns(null);
  const acc = new Map<string, GisSignalFunnelRow>();
  for (const run of runs) {
    for (const [segmentKey, counts] of Object.entries(run.funnel?.perSegment ?? {})) {
      addFunnel(acc, segmentKey, 'all', segmentKey, counts as Record<string, number | undefined>);
    }
  }
  return Array.from(acc.values()).sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
}

/** Срез по сигналам: за всё время per сегмент × per сигнал, count где bool=true. */
export async function getSignalSlice(): Promise<GisSignalSliceRow[]> {
  if (!supabaseAdmin) return [];
  // segment → signalKey → companies
  const acc = new Map<string, Map<(typeof SIGNAL_BOOL_COLUMNS)[number], number>>();
  const columns = ['segment_key', ...SIGNAL_BOOL_COLUMNS].join(', ');

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('gis_signal_company_signals')
      .select(columns)
      // Пагинация БЕЗ order by недетерминирована: пока пайплайн дописывает
      // строки, границы страниц плывут и срез дублирует/теряет компании.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    // Throw, как в fetchRuns: частичный срез не должен уезжать на дашборд.
    if (error) throw new Error(`gis_signal_company_signals read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const segmentKey = String(row.segment_key ?? '');
      if (!segmentKey) continue;
      let seg = acc.get(segmentKey);
      if (!seg) {
        seg = new Map(SIGNAL_BOOL_COLUMNS.map((k) => [k, 0]));
        acc.set(segmentKey, seg);
      }
      for (const col of SIGNAL_BOOL_COLUMNS) {
        if (row[col] === true) seg.set(col, (seg.get(col) ?? 0) + 1);
      }
    }
    if (rows.length < PAGE) break;
  }

  const out: GisSignalSliceRow[] = [];
  for (const [segmentKey, seg] of acc) {
    for (const signalKey of SIGNAL_BOOL_COLUMNS) {
      out.push({ segmentKey, signalKey, companies: seg.get(signalKey) ?? 0 });
    }
  }
  return out.sort(
    (a, b) =>
      a.segmentKey.localeCompare(b.segmentKey) ||
      SIGNAL_BOOL_COLUMNS.indexOf(a.signalKey) - SIGNAL_BOOL_COLUMNS.indexOf(b.signalKey),
  );
}

/**
 * Воронка за произвольный период: суммы per сегмент по прогонам
 * (gis_signal_runs.funnel) со started_at в [fromUtc; toExclusiveUtc).
 * runDate = 'period' (агрегат без разбивки по дням — дашборд суммирует
 * по сегментам, дневная гранулярность нужна только legacy-неделе).
 */
export async function getPeriodFunnel(range: GisReportRange): Promise<GisSignalFunnelRow[]> {
  const runs = await fetchRuns(
    range.fromUtc ? range.fromUtc.toISOString() : null,
    range.toExclusiveUtc ? range.toExclusiveUtc.toISOString() : null,
  );
  const acc = new Map<string, GisSignalFunnelRow>();
  for (const run of runs) {
    for (const [segmentKey, counts] of Object.entries(run.funnel?.perSegment ?? {})) {
      addFunnel(acc, segmentKey, 'period', segmentKey, counts as Record<string, number | undefined>);
    }
  }
  return Array.from(acc.values()).sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
}

/**
 * Статистика проверенных компаний за период (срез по 16 сигналам + грейды).
 * Один пагинированный проход по архиву — считает и хиты сигналов, и
 * скоринг-разрез. Ошибка БД → throw (как fetchRuns): частичные числа на
 * дашборде хуже явного 500.
 */
export async function getPeriodCompanyStats(range: GisReportRange): Promise<GisSignalSegmentStats[]> {
  if (!supabaseAdmin) return [];
  const columns = ['segment_key', ...SIGNAL_BOOL_COLUMNS, 'score', 'grade'].join(', ');
  const acc = new Map<string, {
    companies: number;
    hits: Map<GisSignalBoolKey, number>;
    scores: number[];
    gradeA: number;
    gradeB: number;
    gradeC: number;
    rejected: number;
  }>();

  for (let from = 0; ; from += PAGE) {
    let q = supabaseAdmin
      .from('gis_signal_company_signals')
      .select(columns)
      // Пагинация БЕЗ order by недетерминирована (см. getSignalSlice).
      .order('id', { ascending: true });
    if (range.fromUtc) q = q.gte('checked_at', range.fromUtc.toISOString());
    if (range.toExclusiveUtc) q = q.lt('checked_at', range.toExclusiveUtc.toISOString());
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`gis_signal_company_signals read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const segmentKey = String(row.segment_key ?? '');
      if (!segmentKey) continue;
      let seg = acc.get(segmentKey);
      if (!seg) {
        seg = {
          companies: 0,
          hits: new Map(SIGNAL_BOOL_COLUMNS.map((k) => [k, 0])),
          scores: [],
          gradeA: 0,
          gradeB: 0,
          gradeC: 0,
          rejected: 0,
        };
        acc.set(segmentKey, seg);
      }
      seg.companies += 1;
      for (const col of SIGNAL_BOOL_COLUMNS) {
        if (row[col] === true) seg.hits.set(col, (seg.hits.get(col) ?? 0) + 1);
      }
      if (row.score !== null && row.score !== undefined) {
        const score = Number(row.score);
        if (Number.isFinite(score)) {
          seg.scores.push(score);
          const grade = typeof row.grade === 'string' ? row.grade : null;
          if (grade === 'A') seg.gradeA += 1;
          else if (grade === 'B') seg.gradeB += 1;
          else if (grade === 'C') seg.gradeC += 1;
          else seg.rejected += 1; // score есть, грейда нет → ниже порога (отсев)
        }
      }
    }
    if (rows.length < PAGE) break;
  }

  return Array.from(acc.entries())
    .map(([segmentKey, seg]) => {
      const scores = [...seg.scores].sort((a, b) => a - b);
      let medianScore: number | null = null;
      if (scores.length > 0) {
        const mid = Math.floor(scores.length / 2);
        const median = scores.length % 2 === 1
          ? scores[mid]
          : (scores[mid - 1] + scores[mid]) / 2;
        // Одна десятая — чтобы 42.5 не превращалось в 43 и не тащило хвост.
        medianScore = Math.round(median * 10) / 10;
      }
      return {
        segmentKey,
        companies: seg.companies,
        signalHits: Object.fromEntries(seg.hits) as Record<GisSignalBoolKey, number>,
        scored: seg.scores.length,
        gradeA: seg.gradeA,
        gradeB: seg.gradeB,
        gradeC: seg.gradeC,
        rejected: seg.rejected,
        medianScore,
      };
    })
    .sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
}

/**
 * Залито контактов за период из client_campaign_append_batches (durable
 * факты: переживают чистку лидов в Instantly — суммы accepted/skipped
 * зафиксированы в момент заливки). Только кампании ЭТОГО клиента:
 * service_role обходит RLS, поэтому client_user_id фильтруем явно.
 */
export async function getAppendBatchTotals(
  range: { fromUtc: Date; toExclusiveUtc: Date },
  campaignIds: string[],
  clientUserId: string,
): Promise<GisAppendBatchTotals[]> {
  if (!supabaseAdmin || campaignIds.length === 0) return [];
  const acc = new Map<string, GisAppendBatchTotals>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('client_campaign_append_batches')
      .select('campaign_id, requested_count, accepted_count, skipped_count')
      .eq('client_user_id', clientUserId)
      .in('campaign_id', campaignIds)
      .gte('started_at', range.fromUtc.toISOString())
      .lt('started_at', range.toExclusiveUtc.toISOString())
      .order('started_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`client_campaign_append_batches read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const campaignId = String(row.campaign_id ?? '');
      if (!campaignId) continue;
      const entry = acc.get(campaignId) ?? { campaignId, requested: 0, accepted: 0, skipped: 0 };
      entry.requested += Number(row.requested_count ?? 0) || 0;
      entry.accepted += Number(row.accepted_count ?? 0) || 0;
      entry.skipped += Number(row.skipped_count ?? 0) || 0;
      acc.set(campaignId, entry);
    }
    if (rows.length < PAGE) break;
  }

  return Array.from(acc.values()).sort((a, b) => a.campaignId.localeCompare(b.campaignId));
}

/**
 * Сколько компаний каждого сегмента уже обработано за всё время:
 * |seen ∪ archive| per сегмент. archive count — точный COUNT по segment_key
 * (twogis_id в архиве уникален → DISTINCT не нужен). seen ⊆ archive по
 * построению (заливка возможна только после проверки), но гарантию не
 * используем как аксиому: seen-id, которых нет в архиве, добавляются к union
 * явно (чанки по 100 — лимит URL nginx на длинные 2GIS id, см. seenCompanies).
 */
export async function getPoolProcessedCounts(segmentKeys: string[]): Promise<GisPoolProcessedRow[]> {
  if (!supabaseAdmin || segmentKeys.length === 0) return [];
  const db = supabaseAdmin;

  // 1) Точные count'ы архива per сегмент.
  const archiveCounts = new Map<string, number>();
  await Promise.all(segmentKeys.map(async (segmentKey) => {
    const { count, error } = await db
      .from('gis_signal_company_signals')
      .select('twogis_id', { count: 'exact', head: true })
      .eq('segment_key', segmentKey);
    if (error) throw new Error(`gis_signal_company_signals count failed: ${error.message}`);
    archiveCounts.set(segmentKey, Number(count ?? 0));
  }));

  // 2) Все seen-id (журнал мал — только залитые), сгруппированные per сегмент.
  const seenBySegment = new Map<string, string[]>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('gis_signal_seen_companies')
      .select('twogis_id, segment_key')
      .order('twogis_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`gis_signal_seen_companies read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const segmentKey = String(row.segment_key ?? '');
      const twogisId = String(row.twogis_id ?? '');
      if (!segmentKey || !twogisId) continue;
      const list = seenBySegment.get(segmentKey) ?? [];
      list.push(twogisId);
      seenBySegment.set(segmentKey, list);
    }
    if (rows.length < PAGE) break;
  }

  // 3) Overlap per сегмент: сколько seen-id уже учтены в archive count.
  const out: GisPoolProcessedRow[] = [];
  for (const segmentKey of segmentKeys) {
    const seenIds = seenBySegment.get(segmentKey) ?? [];
    let overlap = 0;
    for (let i = 0; i < seenIds.length; i += SEEN_LOOKUP_CHUNK) {
      const chunk = seenIds.slice(i, i + SEEN_LOOKUP_CHUNK);
      const { data, error } = await db
        .from('gis_signal_company_signals')
        .select('twogis_id')
        .eq('segment_key', segmentKey)
        .in('twogis_id', chunk);
      if (error) throw new Error(`gis_signal_company_signals overlap lookup failed: ${error.message}`);
      overlap += (data ?? []).length;
    }
    const archiveCount = archiveCounts.get(segmentKey) ?? 0;
    out.push({
      segmentKey,
      seenCount: seenIds.length,
      archiveCount,
      processed: archiveCount + (seenIds.length - overlap),
    });
  }

  return out.sort((a, b) => a.segmentKey.localeCompare(b.segmentKey));
}
