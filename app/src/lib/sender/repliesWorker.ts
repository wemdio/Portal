import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchNewReplies, type ReplyMailboxRow } from '@/lib/byoMailbox/imap';
import { authForMailbox } from './mailboxAuth';
import {
  bounceIsPermanent,
  classifyReply,
  extractBouncedRecipient,
  extractBounceStatus,
  isOwnMailboxReply,
  isStopRequest,
} from './replyClassify';
import type { MailboxRow, ReplyKind } from './types';

/**
 * Опрос входящих по подключённым ящикам: складываем ответы, связываем их с
 * получателями кампаний и обрываем цепочку тем, кто ответил.
 *
 * IMAP-движок переиспользуется из контура byoMailbox (там же SSRF-проверка
 * хоста и курсор по UID), чтобы не держать две реализации чтения почты.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const MAILBOXES_PER_PASS = 30;

function toImapRow(mailbox: MailboxRow, accessToken?: string): ReplyMailboxRow {
  return {
    accessToken,
    id: mailbox.id,
    // Ящики инструмента не принадлежат клиенту портала — поле нужно только
    // сигнатуре общего IMAP-модуля.
    client_user_id: '',
    email: mailbox.email,
    username: mailbox.username,
    // У ящика на служебном аккаунте секрета нет — вместо него приходит ключ.
    secret_encrypted: mailbox.secret_encrypted ?? '',
    auth_type: 'password',
    imap_host: mailbox.imap_host,
    imap_port: mailbox.imap_port,
    imap_last_uid: mailbox.imap_last_uid,
    imap_uidvalidity: mailbox.imap_uidvalidity,
  };
}

/** Кампании, которые ведутся с этого ящика: в них ищем автора ответа. */
async function campaignIdsOfMailbox(mailboxId: string): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data } = await supabaseAdmin
    .from('sender_campaign_mailboxes')
    .select('campaign_id')
    .eq('mailbox_id', mailboxId);
  return (data ?? []).map((row) => String(row.campaign_id));
}

async function findRecipientByThread(inReplyTo: string | null): Promise<string | null> {
  if (!supabaseAdmin || !inReplyTo) return null;
  const { data } = await supabaseAdmin
    .from('sender_messages')
    .select('recipient_id')
    .eq('message_id', inReplyTo)
    .maybeSingle();
  return data ? String(data.recipient_id) : null;
}

async function findRecipientByEmail(email: string | null, campaignIds: string[]): Promise<string | null> {
  if (!supabaseAdmin || !email || !campaignIds.length) return null;
  const { data } = await supabaseAdmin
    .from('sender_recipients')
    .select('id')
    .in('campaign_id', campaignIds)
    .eq('email', email.toLowerCase())
    .limit(1)
    .maybeSingle();
  return data ? String(data.id) : null;
}

/** Отменяет ещё не отправленные письма лида: после ответа дожимать нельзя. */
async function cancelPendingMessages(recipientId: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('sender_messages')
    .update({ status: 'canceled' })
    .eq('recipient_id', recipientId)
    .in('status', ['scheduled', 'sending']);
}

async function applyReply(params: {
  kind: ReplyKind;
  recipientId: string | null;
  bouncedEmail: string | null;
  /** Код из Status: отчёта о недоставке — по нему мягкий отбойник отличается от вечного. */
  bounceStatus: string | null;
  /** Текст ответа: в нём ищем просьбу больше не писать. */
  replyBody: string | null;
  replySubject: string | null;
  replyFrom: string | null;
  campaignIds: string[];
  log: Log;
}): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;
  const nowIso = new Date().toISOString();

  if (params.kind === 'human' && params.recipientId) {
    // «Стоп»/«отпишитесь» — это отказ, а не диалог: обрываем цепочку и уносим
    // адрес в глобальный стоп-лист, иначе следующая кампания напишет снова.
    const stop = isStopRequest(params.replyBody, params.replySubject);
    const stopEmail = params.replyFrom?.toLowerCase() ?? null;
    if (stop && stopEmail) {
      await db
        .from('sender_suppressions')
        .upsert({ email: stopEmail, reason: 'unsubscribe', note: 'попросил больше не писать' }, { onConflict: 'email' });
      await db
        .from('sender_recipients')
        .update({ status: 'unsubscribed', next_step_at: null, updated_at: nowIso })
        .eq('id', params.recipientId);
      await cancelPendingMessages(params.recipientId);
      return;
    }
    await db
      .from('sender_recipients')
      .update({ status: 'replied', replied_at: nowIso, next_step_at: null, updated_at: nowIso })
      .eq('id', params.recipientId);
    await cancelPendingMessages(params.recipientId);
    return;
  }

  if (params.kind === 'bounce') {
    // Мягкий отбойник (ящик переполнен, greylisting, временная недоступность)
    // не выжигает адрес: suppress и 'bounced' — только за «адреса нет» (5.1.x).
    if (!bounceIsPermanent(params.bounceStatus)) {
      params.log('info', `Мягкий отбойник (${params.bounceStatus ?? 'без кода'}) для ${params.bouncedEmail ?? 'неизвестного'} — адрес не подавляем`);
      return;
    }
    const email = params.bouncedEmail;
    if (email) {
      await db
        .from('sender_suppressions')
        .upsert(
          { email, reason: 'hard_bounce', note: `отбойник из входящего письма${params.bounceStatus ? ` (${params.bounceStatus})` : ''}` },
          { onConflict: 'email' },
        );
    }
    const recipientId = params.recipientId ?? (await findRecipientByEmail(email, params.campaignIds));
    if (recipientId) {
      await db
        .from('sender_recipients')
        .update({ status: 'bounced', next_step_at: null, updated_at: nowIso })
        .eq('id', recipientId);
      await cancelPendingMessages(recipientId);
    }
  }
}

/**
 * Почему не прочитались входящие — человеческим языком.
 *
 * Сообщение видит менеджер в списке ящиков, а IMAP-движок отдаёт свой текст
 * по-английски и про себя: «Failed to establish connection in required time»
 * не говорит ни что это про чтение ответов, ни что письма при этом уходят.
 * Незнакомую ошибку оставляем как есть — лучше непонятный текст, чем
 * потерянная причина.
 */
function describeImapFailure(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? '');
  const code = (e as { code?: string } | null)?.code ?? '';
  const known = `${code} ${text}`.toLowerCase();

  if (known.includes('required time') || known.includes('timeout') || known.includes('etimedout')) {
    return 'IMAP: почта ящика не ответила вовремя — входящие в этот раз не прочитались. Отправка при этом работает';
  }
  if (known.includes('authenticationfailed') || known.includes('invalid credentials') || known.includes('auth')) {
    return 'IMAP: ящик не принял пароль — ответы читаться не будут, пока пароль не обновят';
  }
  if (known.includes('enotfound') || known.includes('eai_again')) {
    return 'IMAP: сервер ящика не найден — проверьте IMAP-хост в выгрузке провайдера';
  }
  if (known.includes('econnrefused') || known.includes('econnreset')) {
    return 'IMAP: сервер ящика отклонил подключение — это обычно временно';
  }
  return `IMAP: ${text.slice(0, 400)}`;
}

/** Один проход опроса входящих. true — если что-то новое нашли. */
export async function processSenderReplies(opts?: { log?: Log }): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const db = supabaseAdmin;
  const log: Log = opts?.log ?? (() => {});

  const { data: mailboxRows } = await db
    .from('sender_mailboxes')
    .select('*')
    .eq('status', 'verified')
    .eq('enabled', true)
    .not('imap_host', 'is', null)
    .order('imap_checked_at', { ascending: true, nullsFirst: true })
    .limit(MAILBOXES_PER_PASS);

  const mailboxes = (mailboxRows ?? []) as MailboxRow[];
  if (!mailboxes.length) return false;

  // Прогревочная переписка ходит между нашими же ящиками: такие входящие
  // помечаются 'warmup' и не считаются ответами, иначе reply rate захлёбывается
  // шумом (на старте прода было 453 «ответа» при 7 отправленных письмах).
  const { data: ownRows } = await db.from('sender_mailboxes').select('email');
  const ownEmails = new Set((ownRows ?? []).map((row) => String(row.email).toLowerCase()));

  let found = false;

  for (const mailbox of mailboxes) {
    const nowIso = new Date().toISOString();
    try {
      const auth = await authForMailbox(mailbox);
      if (!auth.ok) {
        log('warn', `Ящик ${mailbox.email}: ${auth.error}`);
        await db
          .from('sender_mailboxes')
          .update({ imap_checked_at: nowIso, last_error: auth.error })
          .eq('id', mailbox.id);
        continue;
      }

      const result = await fetchNewReplies(
        toImapRow(mailbox, auth.imap.kind === 'oauth' ? auth.imap.accessToken : undefined),
      );
      if (!result) {
        await db.from('sender_mailboxes').update({ imap_checked_at: nowIso }).eq('id', mailbox.id);
        continue;
      }

      if (result.replies.length) {
        const campaignIds = await campaignIdsOfMailbox(mailbox.id);

        for (const reply of result.replies) {
          let kind = classifyReply({
            fromEmail: reply.fromEmail,
            subject: reply.subject,
            body: reply.body,
          });
          if (kind !== 'bounce' && isOwnMailboxReply(reply.fromEmail, ownEmails)) {
            kind = 'warmup';
          }
          const bouncedEmail = kind === 'bounce' ? extractBouncedRecipient(reply.body, mailbox.email) : null;
          const bounceStatus = kind === 'bounce' ? extractBounceStatus(reply.body) : null;
          const recipientId =
            kind === 'warmup'
              ? null
              : (await findRecipientByThread(reply.inReplyTo)) ??
              (kind === 'bounce'
                ? await findRecipientByEmail(bouncedEmail, campaignIds)
                : await findRecipientByEmail(reply.fromEmail, campaignIds));

          await db.from('sender_replies').upsert(
            {
              mailbox_id: mailbox.id,
              uid: reply.uid,
              from_email: reply.fromEmail ? reply.fromEmail.toLowerCase() : null,
              from_name: reply.fromName,
              subject: reply.subject,
              body: reply.body,
              message_id: reply.messageId,
              in_reply_to: reply.inReplyTo,
              kind,
              recipient_id: recipientId,
              received_at: reply.receivedAt,
            },
            { onConflict: 'mailbox_id,uid', ignoreDuplicates: true },
          );

          if (kind !== 'warmup') {
            await applyReply({
              kind,
              recipientId,
              bouncedEmail,
              bounceStatus,
              replyBody: reply.body,
              replySubject: reply.subject,
              replyFrom: reply.fromEmail,
              campaignIds,
              log,
            });
          }
        }

        found = true;
        log('info', `Ящик ${mailbox.email}: новых входящих ${result.replies.length}`);
      }

      await db
        .from('sender_mailboxes')
        .update({
          imap_last_uid: result.newLastUid,
          imap_uidvalidity: result.uidValidity,
          imap_checked_at: nowIso,
          // Опрос прошёл — значит, прошлая жалоба на почту ящика больше не
          // правда. Без этого одна секундная заминка на стороне провайдера
          // оставалась на экране навсегда: ящик работает и шлёт письма, а под
          // адресом всё висит ошибка чтения входящих. Опрашиваются только
          // проверенные ящики, и здесь может лежать только IMAP-заметка —
          // отказ SMTP переводит ящик в «Ошибка», и сюда он уже не попадает.
          last_error: null,
        })
        .eq('id', mailbox.id);
    } catch (e) {
      log('warn', `Не удалось прочитать входящие ${mailbox.email}: ${e instanceof Error ? e.message : String(e)}`);
      await db
        .from('sender_mailboxes')
        .update({ imap_checked_at: nowIso, last_error: describeImapFailure(e) })
        .eq('id', mailbox.id);
    }
  }

  return found;
}
