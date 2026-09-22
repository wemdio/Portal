import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Проверочная отправка с ящика на внешний контрольный адрес с разбором
 * заголовков доставленного письма (задача 5.9 хендоффа масштаба).
 *
 * POST заводит пробу, отправляет и сверяет заголовки воркер сендера —
 * SMTP-трафик обязан идти с изолированного sender-хоста, не с портала.
 * GET отдаёт последнюю пробу ящика.
 */

interface ProbeRow {
  id: string;
  status: 'pending' | 'sent' | 'done' | 'failed';
  passed: boolean | null;
  error: string | null;
  sent_at: string | null;
  received_at: string | null;
  result: unknown;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.probe.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { data } = await supabaseAdmin
      .from('sender_send_probes')
      .select('id, status, passed, error, sent_at, received_at, result')
      .eq('mailbox_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({ probe: (data as ProbeRow | null) ?? null });
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.probe.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { data: mailbox } = await supabaseAdmin
      .from('sender_mailboxes')
      .select('id, email')
      .eq('id', id)
      .maybeSingle();
    if (!mailbox) return jsonError('Ящик не найден', 404);

    // Не плодим параллельные пробы одного ящика: предыдущая закончится в
    // течение ~15 минут (таймаут доставки), новая до этого только шум.
    const { data: active } = await supabaseAdmin
      .from('sender_send_probes')
      .select('id, status')
      .eq('mailbox_id', id)
      .in('status', ['pending', 'sent'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (active) return jsonError('Предыдущая проверка ещё идёт — результат появится через пару минут', 409);

    const { error } = await supabaseAdmin
      .from('sender_send_probes')
      .insert({ mailbox_id: id, created_by: auth.user.id, status: 'pending' });
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({ ok: true });
  });
}
