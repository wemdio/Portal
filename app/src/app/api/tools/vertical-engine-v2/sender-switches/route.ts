import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readVeSenderSwitchState } from '@/lib/verticalEngineV2/senderTransport/switches';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * GET — состояние выключателей Движка → «Рассылка» (этап 6) для панели над
 * списком проектов: режимы запусков и подача по рынкам, отправка кампаний
 * Движка и остановленные выключателем кампании, карточки лидов, запасной
 * выключатель в настройках портала (только да/нет). Видят все сотрудники;
 * can_manage — кнопки (пишет только POST /api/admin/ve2-sender под admin).
 * Каждая часть читается отдельно: не прочиталась — null («не прочиталось»).
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.sender-switches.get' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    const state = await readVeSenderSwitchState(supabaseAdmin, process.env);
    return NextResponse.json({ state, can_manage: authed.auth.role === 'admin' });
  });
}
