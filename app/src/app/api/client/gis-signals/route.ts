import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getGisSignalsClientUserId } from '@/lib/gisSignalOutreach/access';
import {
  getWeeklyFunnel,
  getTotalFunnel,
  getSignalSlice,
} from '@/lib/gisSignalOutreach/reportQueries';
import { getCampaignAnalytics, getCampaignAnalyticsDaily } from '@/lib/instantly/client';
import type { CampaignAnalytics } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/gis-signals — данные дашборда «2GIS + сигналы».
 *
 * Доступ ТОЛЬКО клиенту из gis_signal_pipeline_config.client_user_id (id=1).
 * Всем остальным — 404 (не 403), чтобы не раскрывать существование роута.
 *
 * Ответ:
 *   segments     — сегменты пайплайна (gis_signal_segments) + hasCampaign
 *   weeklyFunnel — воронка последней недели по прогонам (reportQueries)
 *   totalFunnel  — воронка за всё время
 *   signalSlice  — срез компаний по 6 сигналам × сегментам
 *   campaigns    — по каждому сегменту с instantly_campaign_id аналитика
 *                  Instantly: allTime (/campaigns/analytics) + last7Days
 *                  (/campaigns/analytics/daily за последние 7 дней).
 *                  Сбой Instantly по кампании → analytics: null, роут не падает.
 */

interface SegmentRow {
  key: string;
  label: string;
  instantly_campaign_id: string | null;
}

interface CampaignWindowTotals {
  emailsSent: number;
  openCount: number;
  replyCount: number;
}

interface CampaignAnalyticsPayload {
  allTime: CampaignAnalytics | null;
  last7Days: CampaignWindowTotals | null;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Daily-эндпоинт Instantly в нашем клиенте не типизирован (unknown) — парсим
 * защитно: ждём массив дневных строк со счётчиками и суммируем их в окно.
 * Не массив → null (окно «за 7 дней» просто не показываем).
 */
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

async function loadCampaignAnalytics(campaignId: string): Promise<CampaignAnalyticsPayload | null> {
  try {
    const rows = await getCampaignAnalytics({ campaign_id: campaignId });
    const allTime =
      (Array.isArray(rows) ? rows : []).find((a) => a.campaign_id === campaignId) ?? null;

    // Daily — самостоятельное окно: его сбой гасит только «за 7 дней»,
    // allTime остаётся. Основной /campaigns/analytics дат не принимает
    // (обёртка без start_date/end_date), поэтому окно считаем из daily.
    const end = new Date();
    const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
    const last7Days = await getCampaignAnalyticsDaily({
      campaign_id: campaignId,
      start_date: isoDay(start),
      end_date: isoDay(end),
    })
      .then(sumDailyWindow)
      .catch(() => null);

    return { allTime, last7Days };
  } catch {
    return null;
  }
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

  const [segmentsRes, weeklyFunnel, totalFunnel, signalSlice] = await Promise.all([
    supabaseAdmin.from('gis_signal_segments').select('key, label, instantly_campaign_id'),
    getWeeklyFunnel(),
    getTotalFunnel(),
    getSignalSlice(),
  ]);
  if (segmentsRes.error) {
    return NextResponse.json({ error: segmentsRes.error.message }, { status: 500 });
  }

  const segments = (segmentsRes.data ?? []) as SegmentRow[];

  const campaigns = await Promise.all(
    segments
      .filter((s) => Boolean(s.instantly_campaign_id))
      .map(async (s) => ({
        segmentKey: s.key,
        label: s.label,
        analytics: await loadCampaignAnalytics(s.instantly_campaign_id as string),
      })),
  );

  return NextResponse.json({
    segments: segments.map((s) => ({
      key: s.key,
      label: s.label,
      hasCampaign: Boolean(s.instantly_campaign_id),
    })),
    weeklyFunnel,
    totalFunnel,
    signalSlice,
    campaigns,
  });
}
