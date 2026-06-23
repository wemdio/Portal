import { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { listEmails, getCampaignAnalytics } from '@/lib/instantly/client';
import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import type { Email } from '@/lib/instantly/types';
import type { CampaignMetrics, CampaignReplies, ReportReply } from '@/lib/repliesReport/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * SSE-эндпоинт инструмента «Отчёт по ответам» (/tools/replies-report).
 * Зеркало /api/tools/auto-report/stream: тот же Bearer-auth, тот же протокол
 * событий (start → progress → result → error) и тот же пейсинг батчами.
 * На каждую кампанию тянет сводные метрики (getCampaignAnalytics) и ВСЕ входящие
 * ответы (listEmails email_type=received), маппит их в безопасный вид.
 */

// Основной ключ воркспейса проверяем только как «сервис настроен»; сами вызовы
// идут через client.ts (модуль аккаунтов + общий rate-limiter), как в остальном приложении.
const HAS_KEY = !!(process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();

const BATCH_SIZE = 5;
const INTER_BATCH_DELAY_MS = 600;
const MAX_REPLIES_PER_CAMPAIGN = 2000;
const MAX_PAGES = 200;

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function ms(s: string | null | undefined): number {
  return s ? Date.parse(s) || 0 : 0;
}

/** Разбор сводки analytics (массив или объект; поля как в autoReportBuilder). */
function parseAnalytics(analytics: unknown): { name: string; metrics: CampaignMetrics } {
  const body = (analytics && typeof analytics === 'object' && 'body' in (analytics as object))
    ? (analytics as { body?: unknown }).body
    : analytics;
  const s = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') {
    return { name: '', metrics: { contacts: 0, emailsSent: 0, opened: 0, replies: 0, leads: 0, bounced: 0 } };
  }
  return {
    name: typeof s.campaign_name === 'string' ? s.campaign_name : '',
    metrics: {
      contacts: num(s.new_leads_contacted_count ?? s.contacted_count),
      emailsSent: num(s.emails_sent_count),
      opened: num(s.open_count),
      replies: num(s.reply_count),
      leads: num(s.leads_count),
      bounced: num(s.bounced_count),
    },
  };
}

async function fetchReplies(
  campaignId: string,
  sinceMs: number,
  untilMs: number,
): Promise<{ replies: ReportReply[]; truncated: boolean }> {
  const out: ReportReply[] = [];
  let after: string | undefined;
  let truncated = false;

  for (let guard = 0; guard < MAX_PAGES; guard += 1) {
    const page = await listEmails({
      campaign_id: campaignId,
      email_type: 'received',
      limit: 100,
      starting_after: after,
    });
    const items: Email[] = page.items ?? [];
    let oldest = Infinity;
    for (const e of items) {
      const ts = ms(e.timestamp_email || e.timestamp_created);
      if (ts && ts < oldest) oldest = ts;
      if (sinceMs && ts && ts < sinceMs) continue;
      if (untilMs && ts && ts > untilMs) continue;
      const reply = mapInstantlyEmailToReply(e);
      out.push({ ...reply, eaccount: typeof e.eaccount === 'string' ? e.eaccount : null });
      if (out.length >= MAX_REPLIES_PER_CAMPAIGN) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    after = page.next_starting_after || undefined;
    if (!after || items.length === 0) break;
    // лента от новых к старым: если страница ушла за нижнюю границу периода — дальше только старее
    if (sinceMs && oldest < sinceMs) break;
  }

  out.sort((a, b) => ms(b.timestamp) - ms(a.timestamp));
  return { replies: out, truncated };
}

export async function POST(req: NextRequest) {
  const headers = { 'Content-Type': 'text/event-stream' };

  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) {
    return new Response(sseEvent({ type: 'error', message: 'Необходима авторизация' }), { status: 401, headers });
  }
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response(sseEvent({ type: 'error', message: 'Необходима авторизация' }), { status: 401, headers });
  }
  if (!HAS_KEY) {
    return new Response(
      sseEvent({ type: 'error', message: 'Сервис отчётов не настроен (INSTANTLY_API_KEY)' }),
      { status: 503, headers },
    );
  }

  let body: { campaignIds?: string[]; since?: string; until?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(sseEvent({ type: 'error', message: 'Неверное тело запроса' }), { status: 400, headers });
  }

  const campaignIds = Array.isArray(body.campaignIds)
    ? [...new Set(body.campaignIds.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  if (!campaignIds.length) {
    return new Response(sseEvent({ type: 'error', message: 'Не выбрано ни одной кампании' }), { status: 400, headers });
  }

  const sinceMs = body.since ? ms(`${body.since}T00:00:00Z`) : 0;
  const untilMs = body.until ? ms(`${body.until}T23:59:59Z`) : 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(data)));
        } catch {
          /* client disconnected */
        }
      };

      enqueue({ type: 'start', total: campaignIds.length });

      const results: CampaignReplies[] = [];
      let completed = 0;

      try {
        for (let start = 0; start < campaignIds.length; start += BATCH_SIZE) {
          const batch = campaignIds.slice(start, start + BATCH_SIZE);
          const settled = await Promise.allSettled(
            batch.map(async (id): Promise<CampaignReplies> => {
              enqueue({ type: 'progress', current: completed + 1, total: campaignIds.length, campaignId: id, phase: 'fetching' });
              const analytics = await getCampaignAnalytics({ id }).catch(() => null);
              const { name, metrics } = parseAnalytics(analytics);
              const { replies, truncated } = await fetchReplies(id, sinceMs, untilMs);
              return { id, name: name || id, metrics, replies, truncated };
            }),
          );

          for (let i = 0; i < settled.length; i += 1) {
            const id = batch[i];
            const r = settled[i];
            completed += 1;
            if (r.status === 'fulfilled') {
              results.push(r.value);
              enqueue({ type: 'progress', current: completed, total: campaignIds.length, campaignId: id, phase: 'done' });
            } else {
              results.push({
                id,
                name: id,
                metrics: { contacts: 0, emailsSent: 0, opened: 0, replies: 0, leads: 0, bounced: 0 },
                replies: [],
                truncated: false,
                failed: true,
              });
              enqueue({ type: 'progress', current: completed, total: campaignIds.length, campaignId: id, phase: 'error' });
            }
          }

          if (start + BATCH_SIZE < campaignIds.length) await sleep(INTER_BATCH_DELAY_MS);
        }

        // больше всего ответов — наверх
        results.sort((a, b) => b.replies.length - a.replies.length);

        enqueue({
          type: 'result',
          campaigns: results,
          generatedAt: new Date().toISOString(),
          since: body.since ?? null,
          until: body.until ?? null,
        });
      } catch (err) {
        enqueue({ type: 'error', message: err instanceof Error ? err.message : 'Ошибка формирования отчёта' });
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
