import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.accounts.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    const { data, error } = await supabaseAdmin
      .from('li_accounts')
      .select('*')
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false });
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ accounts: data ?? [] });
  });
}
