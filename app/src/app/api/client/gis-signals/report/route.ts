import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getGisSignalsClientUserId } from '@/lib/gisSignalOutreach/access';
import {
  getPeriodFunnel,
  getPeriodCompanyStats,
  getAppendBatchTotals,
  getPoolProcessedCounts,
  type GisAppendBatchTotals,
  type GisSignalFunnelRow,
  type GisSignalSegmentStats,
} from '@/lib/gisSignalOutreach/reportQueries';
import {
  resolveGisReportPeriod,
  previousGisPeriodRange,
  resolveGisWeek,
  GisReportPeriodError,
  type GisReportPeriodPreset,
  type GisWeekId,
} from '@/lib/gisSignalOutreach/periods';
import { loadGisSignalConfig, type GisSignalRubricGroup } from '@/lib/gisSignalOutreach/config';
import { computeSegmentQuotas } from '@/lib/gisSignalOutreach/segments';
import { estimateSegmentPools } from '@/lib/gisSignalOutreach/poolEstimates';
import { getCampaignAnalyticsDaily } from '@/lib/instantly/client';
import { resolveClientInstantlyRequestOptions } from '@/lib/instantly/clientAccountOptions';
import type { InstantlyRequestOptions } from '@/lib/instantly/accounts';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/gis-signals/report — периодная отчётность дашборда
 * «2GIS + сигналы». Тот же гейт, что у /api/client/gis-signals: ровно один
 * клиент из gis_signal_pipeline_config.client_user_id, чужим 404.
 *
 * Query:
 *   period = 7d | 30d | all | custom   (дефолт 7d)
 *   from/to = YYYY-MM-DD (Europe/Moscow, обязательны при custom)
 *   week   = current | previous        (дефолт current; календарная неделя
 *                                       пн–вс Europe/Moscow)
 *
 * Ответ:
 *   period          — резолвнутый период { preset, from, to, days }
 *   funnel          — воронка за период per сегмент (runDate='period')
 *   funnelPrev      — воронка за предыдущий равный интервал (null у 'all')
 *   stats           — срез 8 сигналов + грейды A/B/C/отсев + медианный скор
 *   weekly          — «Недельный отчёт»: воронка недели + дельта-ранга
 *                     прошлой, залито из client_campaign_append_batches
 *                     (не зависит от чистки Instantly), окно кампаний недели
 *                     (daily-эндпоинт, как «за 7 дней»), грейды недели
 *   pool            — остаток пула: processed |seen ∪ archive|, оценка пула
 *                     2GIS (null при таймауте/недоступности — не роняем
 *                     ответ), остаток и прогноз в неделях (quota × 5 раб.дн.)
 *
 * Отчётные запросы кидают при ошибке БД → 500 (тихий 200 с усечёнными
 * числами дашборд показывал бы как полные). Сбой Instantly по кампании →
 * window: null, роут не падает.
 */

interface SegmentRow {
  key: string;
  label: string;
  instantly_campaign_id: string | null;
  rubric_groups: GisSignalRubricGroup[] | null;
  enabled: boolean | null;
  priority: number | null;
  /** Доля сегмента в daily_limit; NULL/нет колонки (до миграции) → 1, как раньше. */
  quota_weight: number | null;
}

interface CampaignWindowTotals {
  emailsSent: number;
  openCount: number;
  replyCount: number;
}

interface WeeklyAppendedRow {
  segmentKey: string;
  label: string;
  campaignId: string;
  requested: number;
  accepted: number;
  skipped: number;
}

interface WeeklyPayload {
  weekId: GisWeekId;
  weekStart: string;
  weekEnd: string;
  funnel: GisSignalFunnelRow[];
  funnelPrev: GisSignalFunnelRow[];
  stats: GisSignalSegmentStats[];
  appended: WeeklyAppendedRow[];
  campaignWindow: Array<{ segmentKey: string; label: string; window: CampaignWindowTotals | null }>;
}

// Защитный парсер daily-эндпоинта — близнец sumDailyWindow из
// /api/client/gis-signals/route.ts (держать синхронно).
function sumDailyWindow(raw: unknown): CampaignWindowTotals | null {
  if (!Array.isArray(raw)) return null;
  let emailsSent = 0;
  let openCount = 0;
  let replyCount = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    emailsSent += Number(row.emails_sent_count ?? 0) || 0;
    openCount += Number(row.open_count ?? 0) || 0;
    replyCount += Number(row.reply_count ?? 0) || 0;
  }
  return { emailsSent, openCount, replyCount };
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const allowedUserId = await getGisSignalsClientUserId();
  if (!allowedUserId || allowedUserId !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Период/неделя: невалидный ввод → 400, а не молчаливое «всё время».
  let period: ReturnType<typeof resolveGisReportPeriod>;
  let prevRange: ReturnType<typeof previousGisPeriodRange>;
  let week: ReturnType<typeof resolveGisWeek>;
  try {
    // req.url (absolute) — универсально; req.nextUrl есть только у NextRequest.
    const sp = new URL(req.url).searchParams;
    period = resolveGisReportPeriod({
      preset: (sp.get('period') ?? undefined) as GisReportPeriodPreset | undefined,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
    });
    prevRange = previousGisPeriodRange(period);
    week = resolveGisWeek(sp.get('week') ?? undefined);
  } catch (err) {
    if (err instanceof GisReportPeriodError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const segmentsQuery = supabaseAdmin
    .from('gis_signal_segments')
    .select('key, label, instantly_campaign_id, rubric_groups, enabled, priority')
    .order('priority', { ascending: true });

  const [segmentsRes, config] = await Promise.all([segmentsQuery, loadGisSignalConfig()]);
  if (segmentsRes.error) {
    return NextResponse.json({ error: segmentsRes.error.message }, { status: 500 });
  }
  const segments = ((segmentsRes.data ?? []) as SegmentRow[])
    .slice()
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  const segmentKeys = segments.map((s) => s.key);
  const campaignIds = segments
    .map((s) => s.instantly_campaign_id)
    .filter((id): id is string => Boolean(id));

  // Квоты — только по enabled-сегментам (как в pullSegmentCandidates):
  // daily_limit делится по весам quota_weight, остаток — по наибольшей
  // дробной части. Дашборд обязан показывать ту же квоту, по которой реально
  // тянет прогон, иначе «остатка пула» врёт.
  const enabledSegments = segments.filter((s) => s.enabled === true);
  const quotas = computeSegmentQuotas(
    config?.daily_limit ?? 0,
    enabledSegments.map((s) => (typeof s.quota_weight === 'number' ? s.quota_weight : 1)),
  );
  const quotaBySegment = new Map(enabledSegments.map((s, i) => [s.key, quotas[i] ?? 0]));

  const periodRange = { fromUtc: period.fromUtc, toExclusiveUtc: period.toExclusiveUtc };
  const weekRange = { fromUtc: week.fromUtc, toExclusiveUtc: week.toExclusiveUtc };
  const weekPrevRange = { fromUtc: week.prevFromUtc, toExclusiveUtc: week.prevToExclusiveUtc };

  let funnel: GisSignalFunnelRow[];
  let funnelPrev: GisSignalFunnelRow[] | null;
  let stats: GisSignalSegmentStats[];
  let weeklyFunnel: GisSignalFunnelRow[];
  let weeklyFunnelPrev: GisSignalFunnelRow[];
  let weeklyStats: GisSignalSegmentStats[];
  let appended: GisAppendBatchTotals[];
  let poolProcessed: Awaited<ReturnType<typeof getPoolProcessedCounts>>;
  let poolEstimates: Awaited<ReturnType<typeof estimateSegmentPools>>;
  try {
    [funnel, funnelPrev, stats, weeklyFunnel, weeklyFunnelPrev, weeklyStats, appended, poolProcessed, poolEstimates] =
      await Promise.all([
        getPeriodFunnel(periodRange),
        prevRange ? getPeriodFunnel(prevRange) : Promise.resolve(null),
        getPeriodCompanyStats(periodRange),
        getPeriodFunnel(weekRange),
        getPeriodFunnel(weekPrevRange),
        getPeriodCompanyStats(weekRange),
        getAppendBatchTotals(weekRange, campaignIds, user.id),
        getPoolProcessedCounts(segmentKeys),
        estimateSegmentPools(segments.map((s) => ({ key: s.key, rubric_groups: s.rubric_groups ?? [] }))),
      ]);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Report query failed' },
      { status: 500 },
    );
  }

  // Отправки/открытия/ответы недели — тот же daily-механизм, что у строки
  // «за 7 дней» блока кампаний, но окно = календарная неделя (МСК).
  const instantlyRequestOptions: InstantlyRequestOptions =
    await resolveClientInstantlyRequestOptions(user.id);
  const campaignWindow = await Promise.all(
    segments
      .filter((s) => Boolean(s.instantly_campaign_id))
      .map(async (s) => ({
        segmentKey: s.key,
        label: s.label,
        window: await getCampaignAnalyticsDaily({
          campaign_id: s.instantly_campaign_id as string,
          start_date: week.weekStart,
          end_date: week.weekEnd,
        }, instantlyRequestOptions)
          .then(sumDailyWindow)
          .catch(() => null),
      })),
  );

  const pool = segments.map((s) => {
    const processed = poolProcessed.find((p) => p.segmentKey === s.key)?.processed ?? 0;
    const poolEstimate = poolEstimates.get(s.key) ?? null;
    const remaining = poolEstimate === null ? null : Math.max(0, poolEstimate - processed);
    const quota = quotaBySegment.get(s.key);
    const weeklyConsumption = quota === undefined ? null : quota * 5;
    const weeksLeft =
      remaining !== null && weeklyConsumption !== null && weeklyConsumption > 0
        ? Math.round((remaining / weeklyConsumption) * 10) / 10
        : null;
    return { segmentKey: s.key, processed, poolEstimate, remaining, weeklyConsumption, weeksLeft };
  });

  const weekly: WeeklyPayload = {
    weekId: week.weekId,
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    funnel: weeklyFunnel,
    funnelPrev: weeklyFunnelPrev,
    stats: weeklyStats,
    // Заливки маппим на сегменты; кампании без батчей за неделю — нулевые
    // строки, чтобы недельный отчёт показывал ВСЕ кампании клиента.
    appended: segments
      .filter((s) => Boolean(s.instantly_campaign_id))
      .map((s) => {
        const row = appended.find((a) => a.campaignId === s.instantly_campaign_id);
        return {
          segmentKey: s.key,
          label: s.label,
          campaignId: s.instantly_campaign_id as string,
          requested: row?.requested ?? 0,
          accepted: row?.accepted ?? 0,
          skipped: row?.skipped ?? 0,
        };
      }),
    campaignWindow,
  };

  return NextResponse.json({
    period: { preset: period.preset, from: period.from, to: period.to, days: period.days },
    funnel,
    funnelPrev,
    stats,
    weekly,
    pool,
  });
}
