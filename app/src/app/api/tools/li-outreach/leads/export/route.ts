import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.export' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    const url = new URL(req.url);
    const listId = url.searchParams.get('lead_list_id');
    const idsParam = url.searchParams.get('ids');
    // Ручной выбор чекбоксами имеет приоритет над фильтром листа: коллега может
    // отфильтровать по листу, потом снять/добавить пару строк и ждать, что
    // выгрузится именно этот набор, а не весь лист.
    const ids = idsParam
      ? idsParam.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    let q = supabaseAdmin
      .from('li_leads')
      .select('name,first_name,last_name,position,company,profile_url,public_identifier,status')
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false })
      .limit(10000);

    if (ids.length) q = q.in('id', ids);
    else if (listId === '__none') q = q.is('lead_list_id', null);
    else if (listId) q = q.eq('lead_list_id', listId);

    const { data, error } = await q;
    if (error) return jsonError(error.message, 500);

    const rows = data ?? [];
    const header = 'name,first_name,last_name,position,company,profile_url,public_identifier,status';
    const csvRows = rows.map((r) => {
      const fields = [
        r.name ?? '',
        r.first_name ?? '',
        r.last_name ?? '',
        r.position ?? '',
        r.company ?? '',
        r.profile_url ?? '',
        r.public_identifier ?? '',
        r.status ?? '',
      ];
      return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(',');
    });

    const csv = [header, ...csvRows].join('\n');
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename=li_leads_${Date.now()}.csv`,
      },
    });
  });
}
