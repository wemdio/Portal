import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { UnipileClient } from '@/lib/liOutreach/unipileClient';
import type { LiSettings } from '@/lib/liOutreach/types';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.accounts.patch' }, async (trace) => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    const { id } = await params;

    const { data: account } = await supabaseAdmin
      .from('li_accounts')
      .select('*')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!account) return jsonError('Account not found', 404);

    const body = (await req.json().catch(() => ({}))) as { proxy_url?: string | null };

    const proxyUrl = body.proxy_url !== undefined ? (body.proxy_url || null) : undefined;

    if (proxyUrl === undefined) {
      return jsonError('No fields to update', 400);
    }

    // Save to our DB first
    const { error: dbErr } = await supabaseAdmin
      .from('li_accounts')
      .update({ proxy_url: proxyUrl, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (dbErr) return jsonError(dbErr.message, 500);

    // Patch Unipile if we have settings
    const { data: settings } = await auth.supabase
      .from('li_settings')
      .select('*')
      .eq('user_id', auth.user.id)
      .maybeSingle<LiSettings>();

    let unipilePatched = false;
    if (settings?.unipile_dsn && settings?.unipile_api_key) {
      try {
        const client = new UnipileClient(settings.unipile_dsn, settings.unipile_api_key);
        await client.patchAccountProxy(account.unipile_account_id, proxyUrl);
        unipilePatched = true;
      } catch (e) {
        console.error('[li-outreach] patchAccountProxy failed:', e);
        await trace.fail(e);
        return jsonError(
          `Proxy saved locally, but Unipile update failed: ${e instanceof Error ? e.message : String(e)}`,
          502,
        );
      }
    }

    return NextResponse.json({ ok: true, proxy_url: proxyUrl, unipile_patched: unipilePatched });
  });
}
