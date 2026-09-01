import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const url = req.nextUrl;
  const q = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  /**
   * `count: 'exact'` — чтобы экран показывал «сколько всего», а не «сколько
   * влезло в страницу». Раньше в заголовке стояла длина отданного массива, и
   * у аккаунта с двумя тысячами диалогов там честно писалось «200»: понять,
   * что список обрезан, было неоткуда.
   *
   * Считает те же фильтры, что и выборка (поиск по названию тоже), поэтому
   * число под поиском совпадает с тем, что реально можно долистать.
   */
  let query = supabaseAdmin!
    .from('sales_chat_dialogs')
    .select(
      'id,account_id,tg_peer_id,peer_type,peer_title,peer_username,last_message_at,message_count',
      { count: 'exact' },
    )
    .eq('account_id', id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (q) query = query.ilike('peer_title', `%${q}%`);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const total = count ?? offset + rows.length;
  return NextResponse.json({
    dialogs: rows,
    total,
    // Считаем по факту отданного, а не по формуле с limit: страница может
    // прийти короче запрошенной, и тогда «ещё есть» — это ложь, из-за которой
    // бесконечная прокрутка крутила бы спиннер вечно.
    has_more: offset + rows.length < total,
  });
}
