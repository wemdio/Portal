import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';
import {
  checkAccountStatus,
  checkViaSpambot,
  syncProfileFromTelegram,
  requestUnfreeze,
  removeSpamblock,
  unblockAccount,
} from '@/lib/tgOutreach/mtproto';
import type { AccountAction } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

const ACTION_HANDLERS: Record<AccountAction, (sessionData: Record<string, unknown>, proxyConfig?: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
  check_status: checkAccountStatus,
  check_spambot: checkViaSpambot,
  sync_profile: syncProfileFromTelegram,
  request_unfreeze: requestUnfreeze,
  remove_spamblock: removeSpamblock,
  unblock: unblockAccount,
};

export const POST = withTgOutreachAuth(async (req, { supabase }, params) => {
  const id = params?.id;
  const { action } = await req.json() as { action: AccountAction };

  if (!action || !ACTION_HANDLERS[action]) {
    return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
  }

  const { data: account, error } = await supabase
    .from('tg_pool_accounts')
    .select('*, proxy:tg_pool_proxies(*)')
    .eq('id', id)
    .single();

  if (error || !account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  const result = await ACTION_HANDLERS[action](
    account.session_data as Record<string, unknown>,
    account.proxy as Record<string, unknown> | undefined,
  );

  if (action === 'sync_profile' && result.profile) {
    const profile = result.profile as Record<string, string>;
    await supabase
      .from('tg_pool_accounts')
      .update({
        first_name: profile.first_name ?? account.first_name,
        last_name: profile.last_name ?? account.last_name,
        username: profile.username ?? account.username,
        bio: profile.bio ?? account.bio,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
  }

  if (result.status && result.status !== account.status) {
    await supabase
      .from('tg_pool_accounts')
      .update({ status: result.status, updated_at: new Date().toISOString() })
      .eq('id', id);
  }

  return NextResponse.json(result);
});
