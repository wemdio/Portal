import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, jsonError } from '@/lib/adminAuth';
import { loadOwnHistory, parseOwnFilter } from '@/lib/ownReplyLeads/history';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** GET — история блока «Instantly · наши кампании» (вкладка «Квалификация», только админ). */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.ownReplyLeads.history' }, async () => {
    const auth = await requireAdmin(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const params = new URL(req.url).searchParams;
    try {
      return NextResponse.json(await loadOwnHistory(supabaseAdmin, parseOwnFilter(params.get('filter')), Number(params.get('page') ?? 1)));
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : 'Не удалось загрузить историю', 500);
    }
  });
}
