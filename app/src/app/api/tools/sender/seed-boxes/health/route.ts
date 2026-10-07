import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { readSeedProbesSince } from '@/lib/sender/seedBoxes';
import { seedHealthScore, type SeedProvider } from '@/lib/sender/seedBoxRules';

export const dynamic = 'force-dynamic';

type Last = { status: string; day: string; folder: string | null };

/**
 * Health score ящиков рассылки по контрольным пробам за 7 дней: доля
 * «Входящих» среди дошедших и потерянных писем, плюс последний результат по
 * каждому сервису. Ящики без проб в список не попадают.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.seed_boxes.health' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const db = supabaseAdmin;

    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const probes = await readSeedProbesSince<{ mailbox_id: string; provider: SeedProvider; status: string; day: string; folder: string | null }>(
      weekAgo, 'mailbox_id, provider, status, day, folder');

    const stats = new Map<string, { inbox: number; spam: number; missing: number; last: Partial<Record<SeedProvider, Last>> }>();
    for (const row of probes) {
      const acc = stats.get(row.mailbox_id) ?? { inbox: 0, spam: 0, missing: 0, last: {} };
      if (row.status === 'inbox' || row.status === 'spam' || row.status === 'missing') {
        acc[row.status] += 1;
        const prev = acc.last[row.provider];
        if (!prev || row.day > prev.day) acc.last[row.provider] = { status: row.status, day: row.day, folder: row.folder };
      }
      stats.set(row.mailbox_id, acc);
    }

    const ids = [...stats.keys()];
    const emails = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await db.from('sender_mailboxes').select('id, email').in('id', ids.slice(i, i + 200));
      for (const row of data ?? []) emails.set(String(row.id), String(row.email));
    }

    const mailboxes = ids
      .map((id) => {
        const acc = stats.get(id)!;
        return {
          id,
          email: emails.get(id) ?? '—',
          inbox: acc.inbox,
          spam: acc.spam,
          missing: acc.missing,
          score: seedHealthScore(acc),
          last: acc.last,
        };
      })
      .sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || a.email.localeCompare(b.email));
    return NextResponse.json({ mailboxes });
  });
}
