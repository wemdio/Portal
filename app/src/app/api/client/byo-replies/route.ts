import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireByoMailboxClient } from '@/lib/byoMailbox/access';
import {
  ENG_OWN_MAILBOX_SENDING_UNAVAILABLE_TEXT,
  ENG_OWN_MAILBOX_UNAVAILABLE_CODE,
  ownMailboxSendingRefused,
} from '@/lib/byoMailbox/accessPolicy';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/** GET /api/client/byo-replies — входящие ответы клиента (последние). */
export async function GET(req: NextRequest) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;
  // ENG-клиент свои ящики не использует (как POST /api/client/byo-campaigns):
  // ответы его кампаний — на экране Replies кабинета. RU — как было.
  if (ownMailboxSendingRefused(res.auth.market)) {
    return NextResponse.json(
      { error: ENG_OWN_MAILBOX_SENDING_UNAVAILABLE_TEXT, code: ENG_OWN_MAILBOX_UNAVAILABLE_CODE },
      { status: 403 },
    );
  }
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data, error } = await supabaseAdmin
    .from('client_byo_replies')
    .select('id, from_email, from_name, subject, body, matched_to_email, received_at, created_at')
    .eq('client_user_id', res.auth.userId)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ replies: data ?? [] });
}
