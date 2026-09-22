import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** Потолок на переписку: письмо плюс ответы, длиннее живых диалогов не бывает. */
const MAX_ITEMS = 200;

interface ThreadItem {
  id: string;
  direction: 'out' | 'in';
  subject: string | null;
  body: string | null;
  at: string | null;
  /** Исходящее: статус очереди. Входящее: вид ответа (человек, автоответ, отбойник). */
  note: string | null;
  fromEmail: string | null;
}

/**
 * GET — одна переписка: наши письма и ответы получателя одной лентой.
 *
 * Две таблицы вместо одной — это не случайность схемы: исходящее письмо мы
 * создаём заранее (ещё до отправки, ради Message-ID), а входящее приходит из
 * IMAP как есть. Сводим их в общий вид только здесь, на чтении.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const db = supabaseAdmin;

    const [{ data: thread }, { data: messages }, { data: replies }, { data: manual }] = await Promise.all([
      db
        .from('sender_threads')
        .select('recipient_id, campaign_name, recipient_email, recipient_name, status, mailbox_email, reply_count, last_activity_at')
        .eq('recipient_id', id)
        .maybeSingle(),
      db
        .from('sender_messages')
        .select('id, subject, body, status, sent_at, scheduled_at, error, step_no')
        .eq('recipient_id', id)
        .order('step_no')
        .limit(MAX_ITEMS),
      db
        .from('sender_replies')
        .select('id, from_email, from_name, subject, body, kind, received_at, created_at')
        .eq('recipient_id', id)
        .order('created_at')
        .limit(MAX_ITEMS),
      db
        .from('sender_manual_messages')
        .select('id, subject, body, status, sent_at, created_at, error')
        .eq('recipient_id', id)
        .order('created_at')
        .limit(MAX_ITEMS),
    ]);

    if (!thread) return jsonError('Переписка не найдена', 404);

    const KIND_NOTES: Record<string, string> = {
      human: 'ответ человека',
      auto_reply: 'автоответ',
      bounce: 'отбойник',
      warmup: 'прогрев',
      unknown: 'входящее',
    };

    const MANUAL_NOTES: Record<string, string> = {
      queued: 'в очереди',
      sending: 'отправляется',
      failed: 'не ушло',
    };

    const items: ThreadItem[] = [
      ...(messages ?? []).map((m) => ({
        id: String(m.id),
        direction: 'out' as const,
        subject: m.subject,
        body: m.body,
        // Неотправленное показываем по времени, на которое оно поставлено:
        // иначе запланированное письмо провалилось бы в начало ленты.
        at: (m.sent_at ?? m.scheduled_at) as string | null,
        note: m.status === 'sent' ? null : `${m.status}${m.error ? `: ${m.error}` : ''}`,
        fromEmail: null,
      })),
      ...(replies ?? []).map((p) => ({
        id: String(p.id),
        direction: 'in' as const,
        subject: p.subject,
        body: p.body,
        at: (p.received_at ?? p.created_at) as string | null,
        note: KIND_NOTES[String(p.kind)] ?? String(p.kind),
        fromEmail: p.from_email ?? null,
      })),
      // Ручные ответы оператора — полноправная часть переписки: без них в ленте
      // не видно, что мы ответили (задача 4.1).
      ...(manual ?? []).map((x) => ({
        id: String(x.id),
        direction: 'out' as const,
        subject: x.subject,
        body: x.body,
        at: (x.sent_at ?? x.created_at) as string | null,
        note: MANUAL_NOTES[String(x.status)]
          ?? (x.status === 'sent' && x.error ? x.error : null)
          ?? (x.status === 'sent' ? null : `${x.status}${x.error ? `: ${x.error}` : ''}`),
        fromEmail: null,
      })),
    ].sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());

    return NextResponse.json({ thread, items });
  });
}
