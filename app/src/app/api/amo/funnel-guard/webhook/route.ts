import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { parseStatusWebhook } from '@/lib/amoFunnelGuard/rules';
import { enforceTransition } from '@/lib/amoFunnelGuard/guard';

export const dynamic = 'force-dynamic';

/**
 * Вебхук AMO `status_lead`: следит за порядком этапов воронки новых лидов
 * (правила — `lib/amoFunnelGuard/rules.ts`) и откатывает запрещённый перенос.
 *
 * Подключение (один раз, токеном админа AMO):
 *   POST {AMO_BASE_URL}/api/v4/webhooks
 *   {"destination": "https://<портал>/api/amo/funnel-guard/webhook?secret=<AMO_FUNNEL_GUARD_SECRET>",
 *    "settings": ["status_lead"]}
 *
 * Эндпоинт публичный, поэтому секрет в адресе обязателен: без него (или без
 * переменной окружения) молча отвечаем 200 и ничего не делаем.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.AMO_FUNNEL_GUARD_SECRET ?? '';
  const given = req.nextUrl.searchParams.get('secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: true });
  }

  const changes = parseStatusWebhook(await req.text());
  const results: string[] = [];
  for (const change of changes) {
    try {
      results.push(await enforceTransition(change));
    } catch (err) {
      // AMO повторяет вебхук при не-2xx; повтор откатил бы уже вернувшуюся
      // сделку заново, поэтому ошибку только логируем.
      console.error('[amo-funnel-guard]', change.leadId, err);
      results.push('error');
    }
  }
  return NextResponse.json({ ok: true, results });
}
