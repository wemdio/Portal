import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { checkProxies, PROXY_CHECK_CONCURRENCY, type ProxyCheckStatus } from '@/lib/tgOutreach/proxyCheck';
import { recordProxyCheckFailures, type ProxyCheckFailureReason } from '@/lib/tgOutreach/proxyHealth';

export const dynamic = 'force-dynamic';

/**
 * Ограничение на размер пачки. В кампании порядка 40 прокси, 200 — запас на
 * вырост и заодно защита от запроса, который завесит ручку на десять минут.
 */
const MAX_PROXIES_PER_REQUEST = 200;

/** Какой отказ достоин записи в здоровье прокси (см. recordProxyCheckFailures). */
const FAILURE_REASON_BY_STATUS: Partial<Record<ProxyCheckStatus, ProxyCheckFailureReason>> = {
  proxy_dead: 'check_proxy_dead',
  proxy_rejected: 'check_proxy_rejected',
  telegram_unreachable: 'check_telegram_unreachable',
};

/**
 * Проверить выбранные прокси кампании: жив ли прокси и доходит ли через него
 * Telegram. Вся логика — в lib/tgOutreach/proxyCheck.ts, здесь только доступ,
 * выборка строк кампании и побочная запись в здоровье прокси.
 *
 * Запрос:  { campaign_id: string, proxy_ids: string[] }
 * Ответ:   { items: ProxyCheckResult[], checked_at: string, missing_ids: string[] }
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.check.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: { campaign_id?: string; proxy_ids?: unknown };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const campaignId = body.campaign_id;
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const ids = Array.isArray(body.proxy_ids)
        ? Array.from(new Set(body.proxy_ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '')))
        : [];
      if (!ids.length) return jsonError('Выберите хотя бы один прокси', 400);
      if (ids.length > MAX_PROXIES_PER_REQUEST) {
        return jsonError(`За раз можно проверить не больше ${MAX_PROXIES_PER_REQUEST} прокси`, 400);
      }

      // Выборка сразу ограничена кампанией: id из чужой кампании просто не
      // найдётся, а доступ к самой кампании гарантирует RLS — тот же порядок,
      // что и у остальных ручек прокси.
      const { data, error } = await auth.supabase
        .from('tg_outreach_proxies')
        .select('id, url, name')
        .eq('campaign_id', campaignId)
        .in('id', ids);
      if (error) return jsonError(error.message, 500);

      const rows = (data ?? []) as { id: string; url: string; name: string | null }[];
      if (!rows.length) return jsonError('Прокси не найдены в этой кампании', 404);

      const items = await checkProxies(rows, { concurrency: PROXY_CHECK_CONCURRENCY });

      const failures = items
        .map((r) => {
          const reason = FAILURE_REASON_BY_STATUS[r.status];
          return reason ? { id: r.id, reason } : null;
        })
        .filter((v): v is { id: string; reason: ProxyCheckFailureReason } => v !== null);
      if (failures.length) await recordProxyCheckFailures(auth.supabase, failures);

      const found = new Set(rows.map((r) => r.id));
      return NextResponse.json({
        items,
        checked_at: new Date().toISOString(),
        missing_ids: ids.filter((id) => !found.has(id)),
      });
    },
  );
}
