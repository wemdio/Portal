import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireByoMailboxClient } from '@/lib/byoMailbox/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * Сообщение PostgREST наружу не отдаём: в нём имена таблиц и колонок, коды
 * PGRST и текст констрейнтов. Наружу — константа + машинный код, сырьё уходит
 * в `application_logs` (контракт `api/client/eng/_shared.ts`).
 */
const DELETE_FAILED = 'Could not remove the mailbox.';

/** DELETE /api/client/mailboxes/[id] — отключить (удалить) ящик клиента. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' }, { status: 500 });
  }

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: 'Missing id', code: 'ID_REQUIRED' }, { status: 400 });

  const { error } = await supabaseAdmin
    .from('client_mailbox_accounts')
    .delete()
    .eq('id', id)
    .eq('client_user_id', res.auth.userId); // защита: только свои

  if (error) {
    await logError('byoMailbox.delete.failed', error, { userId: res.auth.userId, mailboxId: id });
    return NextResponse.json({ error: DELETE_FAILED, code: 'MAILBOX_DELETE_FAILED' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
