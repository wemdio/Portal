import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, fetchOwnerNames } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.accounts.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    // Cross-specialist visibility: everyone sees all LinkedIn accounts so they
    // can tell which account is running whose campaign. Since migration
    // 20260708_0002 team-edit is on — proxy is editable by any authenticated
    // user, so the read returns the real `proxy_url` for everyone (hiding it
    // would be inconsistent with the write path). Delete is still owner-only
    // (guarded in accounts/[id] DELETE). `owner_name` labels the card so the
    // UI can still show who originally added the account.
    const { data, error } = await supabaseAdmin
      .from('li_accounts')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return jsonError(error.message, 500);

    const accounts = (data ?? []) as Array<Record<string, unknown> & { user_id: string; proxy_url: string | null }>;
    const ownerMap = await fetchOwnerNames(accounts.map((a) => a.user_id));
    const withOwner = accounts.map((a) => ({
      ...a,
      owner_name: ownerMap.get(a.user_id) ?? null,
    }));
    return NextResponse.json({ accounts: withOwner });
  });
}
