import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken } from '@/lib/supabaseRouteClient';
import { createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { buildAutoReport, extractCampaignIdsFromText } from '@/lib/tools/autoReportBuilder';

export const dynamic = 'force-dynamic';

const INSTANTLY_API_KEY =
  (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  if (!INSTANTLY_API_KEY) {
    return jsonError('Сервис отчётов не настроен (INSTANTLY_API_KEY или INSTANTLY_PORTAL_API_KEY)', 503);
  }

  let body: { campaignIds?: string[]; urlsOrText?: string };
  try {
    body = (await req.json()) as { campaignIds?: string[]; urlsOrText?: string };
  } catch {
    return jsonError('Неверное тело запроса', 400);
  }

  let campaignIds: string[];
  if (Array.isArray(body.campaignIds) && body.campaignIds.length > 0) {
    campaignIds = [...new Set(body.campaignIds.map((id) => id.trim()).filter(Boolean))];
  } else if (typeof body.urlsOrText === 'string' && body.urlsOrText.trim()) {
    campaignIds = extractCampaignIdsFromText(body.urlsOrText.trim());
  } else {
    return jsonError('Укажите campaignIds или urlsOrText со ссылками на кампании Instantly', 400);
  }

  if (!campaignIds.length) {
    return jsonError('В тексте не найдено ни одного UUID кампании', 400);
  }

  try {
    const report = await buildAutoReport(campaignIds, INSTANTLY_API_KEY);
    return NextResponse.json({
      tableText: report.tableText,
      csvText: report.csvText,
      rows: report.rows,
      summary: report.summary,
      campaignData: report.campaignData,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка формирования отчёта';
    return jsonError(message, 500);
  }
}
