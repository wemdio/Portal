import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authForMailbox } from './mailboxAuth';
import { verifySenderImap, verifySenderSmtp } from './smtp';
import type { MailboxRow } from './types';

/**
 * Проверка подключённых ящиков: вход по SMTP и по IMAP.
 *
 * Делается в воркере, а не при загрузке файла: проверка одного ящика занимает
 * секунды, а грузят их сотнями — браузер столько не ждёт. Ящик со статусом
 * «pending» в рассылку не идёт, пока проверка не прошла.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const BATCH = 10;

export async function verifyPendingMailboxes(opts: { egressIp: string; log?: Log }): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const { data } = await db
    .from('sender_mailboxes')
    .select('*')
    .eq('status', 'pending')
    // Невыбранные ящики не проверяем: вход в ящик — это лишний логин у
    // провайдера, а на каталоге в двести адресов таких логинов были бы сотни.
    .eq('enabled', true)
    // Вход в ящик — только с его адреса: проверка с чужого адреса и есть тот
    // «вход из необычного места», от которого закрепление защищает.
    .eq('egress_ip', opts.egressIp)
    .order('created_at')
    .limit(BATCH);

  const mailboxes = (data ?? []) as MailboxRow[];
  if (!mailboxes.length) return 0;

  let verified = 0;

  for (const mailbox of mailboxes) {
    const nowIso = new Date().toISOString();
    const auth = await authForMailbox(mailbox);

    if (!auth.ok) {
      await db
        .from('sender_mailboxes')
        .update({ status: 'failed', last_error: auth.error, updated_at: nowIso })
        .eq('id', mailbox.id);
      continue;
    }

    const smtp = await verifySenderSmtp({
      host: mailbox.smtp_host,
      port: mailbox.smtp_port,
      tlsMode: mailbox.smtp_tls_mode,
      username: mailbox.username,
      auth: auth.smtp,
    });

    if (!smtp.ok) {
      await db
        .from('sender_mailboxes')
        .update({
          status: 'failed',
          last_error: `SMTP: ${smtp.error?.slice(0, 400) ?? smtp.code ?? 'не удалось войти'}`,
          updated_at: nowIso,
        })
        .eq('id', mailbox.id);
      log('warn', `Ящик ${mailbox.email}: SMTP не прошёл (${smtp.code})`);
      continue;
    }

    // IMAP не обязателен для отправки, но без него не читаются ответы: ящик
    // остаётся рабочим, а проблема видна в статусе.
    let imapNote: string | null = null;
    if (mailbox.imap_host) {
      const imap = await verifySenderImap({
        host: mailbox.imap_host,
        port: mailbox.imap_port,
        username: mailbox.username,
        auth: auth.imap,
      });
      if (!imap.ok) imapNote = `IMAP: ${imap.error?.slice(0, 400) ?? imap.code ?? 'не удалось войти'}`;
    } else {
      imapNote = 'IMAP-хост не указан — ответы по этому ящику читаться не будут';
    }

    await db
      .from('sender_mailboxes')
      .update({
        status: 'verified',
        last_verified_at: nowIso,
        last_error: imapNote,
        updated_at: nowIso,
      })
      .eq('id', mailbox.id);

    verified += 1;
  }

  if (verified) log('info', `Проверено ящиков: ${verified}`);
  return verified;
}
