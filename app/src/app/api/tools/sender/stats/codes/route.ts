import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^([245]\.\d{1,3}\.\d{1,3}|[45]\d\d)$/;
const PERIOD_DAYS: Record<string, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };

/**
 * Блок «Коды отказов» вкладки «Статистика»: без ?code — счётчики по кодам
 * (sender_bounce_codes), с ?code — последние письма с этим кодом
 * (sender_bounce_code_events); code=none — отказы, в которых кода нет.
 * Период и кампания — как у /stats.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.stats.codes' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const params = req.nextUrl.searchParams;
    const period = params.get('period') ?? '30d';
    if (!(period in PERIOD_DAYS)) return jsonError('Неизвестный период', 400);
    const days = PERIOD_DAYS[period];
    const since = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString();
    const campaign = params.get('campaign') || null;
    if (campaign && !UUID_RE.test(campaign)) return jsonError('Неизвестная кампания', 400);

    const code = params.get('code');
    if (code === null) {
      const { data, error } = await supabaseAdmin.rpc('sender_bounce_codes', {
        p_since: since,
        p_campaign_id: campaign,
      });
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ codes: data ?? [] });
    }

    if (code !== 'none' && !CODE_RE.test(code)) return jsonError('Неизвестный код', 400);
    const { data, error } = await supabaseAdmin.rpc('sender_bounce_code_events', {
      p_code: code === 'none' ? null : code,
      p_since: since,
      p_campaign_id: campaign,
      p_limit: 100,
    });
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ events: data ?? [] });
  });
}
