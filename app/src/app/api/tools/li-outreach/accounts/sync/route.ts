import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { syncLiAccounts } from '@/lib/liOutreach/accountSync';

export const dynamic = 'force-dynamic';

/** Кнопка «Синхронизировать» — тот же синк, что воркер запускает раз в 15 минут. */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.accounts.sync' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    // Карточки общие на всю команду, а RLS на li_accounts по владельцу — нужен админ-клиент.
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    try {
      const result = await syncLiAccounts(supabaseAdmin, { userId: auth.user.id });
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return jsonError(`Ошибка синхронизации: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  });
}
