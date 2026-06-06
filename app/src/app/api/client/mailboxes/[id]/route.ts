import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireByoMailboxClient } from '@/lib/byoMailbox/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/** DELETE /api/client/mailboxes/[id] — отключить (удалить) ящик клиента. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await supabaseAdmin
    .from('client_mailbox_accounts')
    .delete()
    .eq('id', id)
    .eq('client_user_id', res.auth.userId); // защита: только свои

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
