import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { UnipileClient } from '@/lib/liOutreach/unipileClient';
import type { LiSettings } from '@/lib/liOutreach/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.accounts.sync' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const { data: settings } = await auth.supabase
      .from('li_settings')
      .select('*')
      .eq('user_id', auth.user.id)
      .maybeSingle<LiSettings>();
    if (!settings?.unipile_dsn || !settings?.unipile_api_key) {
      return jsonError('Сначала настройте Unipile DSN и API Key в настройках', 400);
    }

    const client = new UnipileClient(settings.unipile_dsn, settings.unipile_api_key);

    try {
      const accounts = await client.listAccounts();
      let synced = 0;

      for (const acc of accounts) {
        const unipileId = String(acc.id ?? '');
        if (!unipileId) continue;

        await auth.supabase.from('li_accounts').upsert(
          {
            user_id: auth.user.id,
            unipile_account_id: unipileId,
            name: String(acc.name ?? ''),
            is_active: String(acc.status ?? '') === 'CONNECTED',
            profile_url: String((acc as Record<string, unknown>).profile_url ?? '') || null,
            headline: String((acc as Record<string, unknown>).headline ?? '') || null,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,unipile_account_id' },
        );
        synced++;
      }

      return NextResponse.json({ ok: true, synced });
    } catch (e) {
      return jsonError(`Ошибка синхронизации: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  });
}
