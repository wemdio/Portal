import 'server-only';
import { NextRequest, NextResponse } from 'next/server';

import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams } from '@/lib/firstSales/params';
import { fetchFirstSalesStageFunnel } from '@/lib/firstSales/stageFunnel';

// Роут авторизуется по заголовку и зависит от query — предрендер здесь дал бы
// либо пустой ответ, либо чужой. Тот же паттерн, что у соседних ручек первички.
export const dynamic = 'force-dynamic';

const PIPELINE_ID = Number(process.env.FIRST_SALES_PIPELINE_ID ?? '7670334');

/**
 * Воронка первички по этапам AMO: на каком этапе каждая сделка стояла в
 * последний день периода (см. lib/firstSales/stageFunnel.ts). Форма ответа —
 * та же, что у `renewals/funnel`, чтобы экран воронки был один на оба дашборда.
 */
export async function GET(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const parsed = parseFirstSalesParams(new URL(req.url));
  // `parsed.value === null`, а не `parsed.error` — то же сужение, что в
  // соседних ручках аналитики.
  if (parsed.value === null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to, sources } = parsed.value;

  try {
    const funnel = await fetchFirstSalesStageFunnel(gate.supabaseAdmin, PIPELINE_ID, { from, to }, sources);
    return NextResponse.json(funnel);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'first_sales_stage_funnel_failed' },
      { status: 500 },
    );
  }
}
