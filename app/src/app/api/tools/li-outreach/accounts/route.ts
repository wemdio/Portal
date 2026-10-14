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
    // can tell which account is running whose campaign. Accounts are shared by
    // the team: proxy, logs and delete are open to any authenticated user
    // (delete since 08.10.2026), so the read returns the real `proxy_url` for
    // everyone. `owner_name` labels the card with who added the account — a
    // label only, it gates nothing.
    //
    // `campaigns` lists where each account is used. After a reconnect Unipile
    // issues a new account id and the old card lingers as an inactive twin;
    // the list shows which twin a campaign still points at before deleting it.
    const [{ data, error }, { data: campaignRows, error: campaignsError }] = await Promise.all([
      supabaseAdmin.from('li_accounts').select('*').order('created_at', { ascending: false }),
      supabaseAdmin.from('li_campaigns').select('id, name, status, account_id').not('account_id', 'is', null),
    ]);
    if (error) return jsonError(error.message, 500);
    if (campaignsError) return jsonError(campaignsError.message, 500);

    const campaignsByAccount = new Map<string, Array<{ id: string; name: string; status: string }>>();
    for (const c of (campaignRows ?? []) as Array<{ id: string; name: string; status: string; account_id: string }>) {
      const list = campaignsByAccount.get(c.account_id) ?? [];
      list.push({ id: c.id, name: c.name, status: c.status });
      campaignsByAccount.set(c.account_id, list);
    }

    const accounts = (data ?? []) as Array<Record<string, unknown> & { id: string; user_id: string; proxy_url: string | null }>;
    const ownerMap = await fetchOwnerNames(accounts.map((a) => a.user_id));
    const withOwner = accounts.map((a) => ({
      ...a,
      owner_name: ownerMap.get(a.user_id) ?? null,
      campaigns: campaignsByAccount.get(a.id) ?? [],
    }));
    return NextResponse.json({ accounts: withOwner });
  });
}
