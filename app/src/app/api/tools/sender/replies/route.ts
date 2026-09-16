import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** GET — входящие по всем ящикам инструмента. По умолчанию только живые ответы. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.replies.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const kind = url.searchParams.get('kind') ?? 'human';

    let query = supabaseAdmin
      .from('sender_replies')
      .select('id, mailbox_id, from_email, from_name, subject, body, kind, recipient_id, received_at, created_at')
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(200);

    if (kind !== 'all') query = query.eq('kind', kind);

    const { data, error } = await query;
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ replies: data ?? [] });
  });
}
