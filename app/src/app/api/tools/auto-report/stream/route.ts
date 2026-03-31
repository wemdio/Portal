import { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { buildAutoReport, extractCampaignIdsFromText } from '@/lib/tools/autoReportBuilder';
import type { AutoReportProgress } from '@/lib/tools/autoReportBuilder';

export const dynamic = 'force-dynamic';
// Increase max duration for Vercel (Pro: 300s, Hobby: 60s)
export const maxDuration = 300;

const INSTANTLY_API_KEY =
  (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) {
    return new Response(sseEvent({ type: 'error', message: 'Необходима авторизация' }), {
      status: 401,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(sseEvent({ type: 'error', message: 'Необходима авторизация' }), {
      status: 401,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  if (!INSTANTLY_API_KEY) {
    return new Response(
      sseEvent({ type: 'error', message: 'Сервис отчётов не настроен (INSTANTLY_API_KEY)' }),
      { status: 503, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  let body: { campaignIds?: string[]; urlsOrText?: string };
  try {
    body = (await req.json()) as { campaignIds?: string[]; urlsOrText?: string };
  } catch {
    return new Response(sseEvent({ type: 'error', message: 'Неверное тело запроса' }), {
      status: 400,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  let campaignIds: string[];
  if (Array.isArray(body.campaignIds) && body.campaignIds.length > 0) {
    campaignIds = [...new Set(body.campaignIds.map((id) => id.trim()).filter(Boolean))];
  } else if (typeof body.urlsOrText === 'string' && body.urlsOrText.trim()) {
    campaignIds = extractCampaignIdsFromText(body.urlsOrText.trim());
  } else {
    return new Response(
      sseEvent({ type: 'error', message: 'Укажите campaignIds или urlsOrText' }),
      { status: 400, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  if (!campaignIds.length) {
    return new Response(
      sseEvent({ type: 'error', message: 'В тексте не найдено ни одного UUID кампании' }),
      { status: 400, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(data)));
        } catch {
          // client disconnected
        }
      };

      // Send total count immediately so client can render the bar
      enqueue({ type: 'start', total: campaignIds.length });

      const onProgress = (p: AutoReportProgress) => {
        enqueue({
          type: 'progress',
          current: p.current,
          total: p.total,
          campaignId: p.campaignId,
          phase: p.phase,
        });
      };

      try {
        const report = await buildAutoReport(campaignIds, INSTANTLY_API_KEY, onProgress);
        enqueue({
          type: 'result',
          tableText: report.tableText,
          csvText: report.csvText,
          rows: report.rows,
          summary: report.summary,
          campaignData: report.campaignData,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Ошибка формирования отчёта';
        enqueue({ type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
