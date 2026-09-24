import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isIpv4, startOfMoscowDayIso } from '@/lib/sender/egress';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Пульс воркера идёт раз в 30 с независимым таймером; три минуты тишины —
 * воркер лежит или сервер недоступен.
 */
const SILENT_AFTER_MS = 3 * 60 * 1000;

interface OverviewRow {
  ip: string;
  host: string;
  accepts_new: boolean;
  last_seen_at: string | null;
  last_error: string | null;
  mailboxes: number;
  enabled_mailboxes: number;
  sent_since: number;
}

/** GET — адреса отправки: сервер, жив ли воркер, сколько ящиков и писем за сегодня. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.egress.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { data, error } = await supabaseAdmin.rpc('sender_egress_overview', { p_since: startOfMoscowDayIso() });
    if (error) return jsonError(error.message, 500);

    const { count: unassigned } = await supabaseAdmin
      .from('sender_mailboxes')
      .select('id', { count: 'exact', head: true })
      .is('egress_ip', null);

    const now = Date.now();
    const ips = ((data ?? []) as OverviewRow[]).map((row) => {
      const seenAt = row.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
      const state = row.last_error
        ? 'error'
        : seenAt !== null && now - seenAt < SILENT_AFTER_MS ? 'online' : 'silent';
      return {
        ip: row.ip,
        host: row.host,
        acceptsNew: row.accepts_new,
        state,
        lastSeenAt: row.last_seen_at,
        lastError: row.last_error,
        mailboxes: Number(row.mailboxes),
        enabledMailboxes: Number(row.enabled_mailboxes),
        sentToday: Number(row.sent_since),
      };
    });

    return NextResponse.json({ ips, unassigned: unassigned ?? 0 });
  });
}

/**
 * PATCH — выдавать ли адресу новые ящики. Уже закреплённые ящики переключатель
 * не трогает: их переносят явно, действием «На адрес».
 */
export async function PATCH(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.egress.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as { ip?: unknown; acceptsNew?: unknown } | null;
    const ip = body?.ip;
    const acceptsNew = body?.acceptsNew;
    if (!isIpv4(ip)) return jsonError('Неизвестный адрес', 400);
    if (typeof acceptsNew !== 'boolean') return jsonError('Ожидается acceptsNew', 400);

    const { data, error } = await supabaseAdmin
      .from('sender_egress_ips')
      .update({ accepts_new: acceptsNew })
      .eq('ip', ip)
      .select('ip')
      .maybeSingle();
    if (error) return jsonError(error.message, 500);
    if (!data) return jsonError('Адрес не найден', 404);

    return NextResponse.json({ ok: true });
  });
}
