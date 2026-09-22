import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Reply rate по ящикам и доменам (задача 6.3 хендоффа фич).
 *
 * Считается представлением sender_mailbox_stats (коррелированные подзапросы в
 * миграции 20260922_0006): PostgREST такой разрез одним запросом не умеет.
 * Группировку по доменам делаем здесь — строк ящиков сотни, JS справляется.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxStats' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { data, error } = await supabaseAdmin
      .from('sender_mailbox_stats')
      .select('mailbox_id, email, domain, status, enabled, reached, replied, bounced, sent')
      .order('sent', { ascending: false });

    if (error) return jsonError(error.message, 500);

    type Row = {
      mailbox_id: string; email: string; domain: string;
      status: string; enabled: boolean;
      reached: number; replied: number; bounced: number; sent: number;
    };
    const rows = (data ?? []) as Row[];

    const withRate = <T extends { reached: number; replied: number; bounced: number }>(row: T) => ({
      ...row,
      replyRate: row.reached > 0 ? Math.round((row.replied / row.reached) * 1000) / 10 : null,
      bounceRate: row.reached > 0 ? Math.round((row.bounced / row.reached) * 1000) / 10 : null,
    });

    const byDomain = new Map<string, { domain: string; mailboxes: number; sent: number; reached: number; replied: number; bounced: number }>();
    for (const row of rows) {
      const entry = byDomain.get(row.domain) ?? {
        domain: row.domain, mailboxes: 0, sent: 0, reached: 0, replied: 0, bounced: 0,
      };
      entry.mailboxes += 1;
      entry.sent += Number(row.sent);
      entry.reached += Number(row.reached);
      entry.replied += Number(row.replied);
      entry.bounced += Number(row.bounced);
      byDomain.set(row.domain, entry);
    }

    return NextResponse.json({
      mailboxes: rows.map(withRate),
      domains: [...byDomain.values()].sort((a, b) => b.sent - a.sent).map(withRate),
    });
  });
}
