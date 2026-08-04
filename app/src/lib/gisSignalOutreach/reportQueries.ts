/**
 * Отчётные запросы дашборда gisSignalOutreach.
 *
 * Два источника:
 *   - gis_signal_runs.funnel (jsonb { perSegment, total }) — воронка прогонов;
 *   - gis_signal_company_signals — per-сигнальный срез всех проверенных компаний.
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
  bcIn: number;
  validContacts: number;
  appended: number;
}

export interface GisSignalSliceRow {
  segmentKey: string;
  signalKey:
    | 'signal_general_phone'
    | 'signal_contact_form'
    | 'signal_sales_dept'
    | 'signal_target_vacancy'
    | 'signal_high_volume'
    | 'signal_multi_office';
  companies: number;
}

const SIGNAL_BOOL_COLUMNS = [
  'signal_general_phone',
  'signal_contact_form',
  'signal_sales_dept',
  'signal_target_vacancy',
  'signal_high_volume',
  'signal_multi_office',
] as const;

/** PostgREST режет выборку ~1000 строками — читаем страницами. */
const PAGE = 1000;

interface RunFunnelRow {
  started_at: string;
  funnel: {
    perSegment?: Record<string, Partial<Record<'pulled' | 'signalsOk' | 'bcIn' | 'validContacts' | 'appended', number>>>;
  } | null;
}

async function fetchRuns(sinceIso: string | null): Promise<RunFunnelRow[]> {
  if (!supabaseAdmin) return [];
  const out: RunFunnelRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabaseAdmin
      .from('gis_signal_runs')
      .select('started_at, funnel')
      .not('funnel', 'is', null)
      .order('started_at', { ascending: true });
    if (sinceIso) q = q.gte('started_at', sinceIso);
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
    bcIn: 0,
    validContacts: 0,
    appended: 0,
  };
  existing.pulled += Number(counts.pulled ?? 0);
  existing.signalsOk += Number(counts.signalsOk ?? 0);
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
