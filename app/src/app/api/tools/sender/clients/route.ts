import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * GET — клиенты кабинета для привязки кампании «Рассылки»: на базу кампании
 * действует стоп-лист выбранного клиента (lib/sender/stopLists). Только
 * русский кабинет: у ENG свой контур и свой список «не писать».
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.clients.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, market')
      .eq('role', 'client')
      .order('full_name', { ascending: true, nullsFirst: false });
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({
      clients: (data ?? [])
        .filter((row) => row.market !== 'eng')
        .map((row) => ({
          id: String(row.id),
          label: String(row.full_name || row.email || 'Без имени'),
          email: row.email ? String(row.email) : null,
        })),
    });
  });
}
