import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.export' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const url = new URL(req.url);
    const listId = url.searchParams.get('lead_list_id');

    let q = auth.supabase
      .from('li_leads')
      .select('name,first_name,last_name,position,company,profile_url,public_identifier,status')
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false })
      .limit(10000);

    if (listId) q = q.eq('lead_list_id', listId);

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
