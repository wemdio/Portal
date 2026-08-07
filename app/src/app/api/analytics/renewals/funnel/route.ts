import 'server-only';
import { NextRequest, NextResponse } from 'next/server';

import { requireRenewalsAccess } from '@/lib/renewals/access';
import { fetchRenewalsFunnel } from '@/lib/renewals/funnel';

// Роут авторизуется по заголовку — предрендер здесь дал бы либо пустой ответ,
// либо чужой. Явно снимаем этот вопрос, как и соседний summary.
export const dynamic = 'force-dynamic';

/**
 * Воронка вторичных продаж — срез по всей воронке AMO, без периода.
 *
 * Периода здесь нет намеренно: воронка отвечает на вопрос «где сейчас проекты
 * и сколько дошло до продления», а не «сколько продлили в июле». Резать её тем
 * же окном, что и таблицу ниже, значило бы выбрасывать из воронки проекты,
 * которые ещё в работе, — и показывать конверсию по огрызку.
 */
export async function GET(req: NextRequest) {
  const gate = await requireRenewalsAccess(req);
  if ('error' in gate) return gate.error;

  try {
    const funnel = await fetchRenewalsFunnel(gate.supabaseAdmin);
    return NextResponse.json(funnel);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'renewals_funnel_failed' },
      { status: 500 },
    );
  }
}
