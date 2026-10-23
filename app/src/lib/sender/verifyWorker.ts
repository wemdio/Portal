import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authForMailbox } from './mailboxAuth';
import {
  isTransientCheckFailure,
  nextRecheckAt,
  PENDING_MAX_TRANSIENT_ATTEMPTS,
  PENDING_RETRY_MS,
} from './mailboxRecheck';
import { verifySenderImap, verifySenderSmtp, type SendErrorCode } from './smtp';
import type { MailboxRow } from './types';

/**
 * Проверка подключённых ящиков: вход по SMTP и по IMAP.
 *
 * Делается в воркере, а не при загрузке файла: проверка одного ящика занимает
 * секунды, а грузят их сотнями — браузер столько не ждёт. Ящик со статусом
 * «pending» в рассылку не идёт, пока проверка не прошла.
 *
 * Упавшие ящики («failed») тот же воркер перепроверяет сам по лестнице пауз
 * (mailboxRecheck): поднялся — снова в рассылке, и его лиды идут дальше.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const BATCH = 10;
/** Перепроверок за проход: вход — секунды, а тик общий с отправкой. */
const RECHECK_BATCH = 3;

type LoginCheck =
  | { ok: true; imapNote: string | null }
  | { ok: false; code: SendErrorCode | undefined; error: string };

/** Вход в ящик: SMTP обязателен, IMAP — только пометка (без него не читаются ответы). */
async function checkMailboxLogin(mailbox: MailboxRow): Promise<LoginCheck> {
  const auth = await authForMailbox(mailbox);
  if (!auth.ok) return { ok: false, code: undefined, error: auth.error };

  const smtp = await verifySenderSmtp({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    tlsMode: mailbox.smtp_tls_mode,
    username: mailbox.username,
    auth: auth.smtp,
  });
  if (!smtp.ok) {
    return { ok: false, code: smtp.code, error: `SMTP: ${smtp.error?.slice(0, 400) ?? smtp.code ?? 'не удалось войти'}` };
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
  return { ok: true, imapNote };
}

export async function verifyPendingMailboxes(opts: { egressIp: string; log?: Log }): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const pendingQuery = () => db
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

  // Временно не прошедший ждёт своей паузы, а не долбит провайдера каждый тик.
  let legacy = false;
  let { data, error } = await pendingQuery()
    .or(`next_recheck_at.is.null,next_recheck_at.lte.${new Date().toISOString()}`);
  if (error && /next_recheck_at/.test(error.message)) {
    // Почтовый хост обновился раньше миграции 20261023_0140: проверяем как
    // раньше, без пауз — временный сбой тогда сразу «Ошибка».
    legacy = true;
    ({ data, error } = await pendingQuery());
  }
  if (error) {
    log('warn', `Ящики на проверку не прочитаны: ${error.message}`);
    return 0;
  }

  const mailboxes = (data ?? []) as MailboxRow[];
  if (!mailboxes.length) return 0;

  let verified = 0;

  for (const mailbox of mailboxes) {
    const nowIso = new Date().toISOString();
    const check = await checkMailboxLogin(mailbox);

    if (!check.ok) {
      // Провайдер занят или сеть моргнула — это не поломка ящика: пробуем снова
      // через паузу, и только час таких сбоев подряд делает его «Ошибкой».
      const attempts = (mailbox.recheck_attempts ?? 0) + 1;
      if (!legacy && isTransientCheckFailure(check.code) && attempts < PENDING_MAX_TRANSIENT_ATTEMPTS) {
        await db
          .from('sender_mailboxes')
          .update({
            last_error: `${check.error} — повторим проверку`,
            recheck_attempts: attempts,
            next_recheck_at: new Date(Date.now() + PENDING_RETRY_MS).toISOString(),
            updated_at: nowIso,
          })
          .eq('id', mailbox.id)
          .eq('status', 'pending');
        log('warn', `Ящик ${mailbox.email}: проверка временно не прошла (${check.code}), повторим`);
        continue;
      }
      await db
        .from('sender_mailboxes')
        .update({ status: 'failed', last_error: check.error, updated_at: nowIso })
        .eq('id', mailbox.id);
      log('warn', `Ящик ${mailbox.email}: вход не прошёл (${check.code ?? 'доступ'})`);
      continue;
    }

    await db
      .from('sender_mailboxes')
      .update({
        status: 'verified',
        last_verified_at: nowIso,
        last_error: check.imapNote,
        updated_at: nowIso,
      })
      .eq('id', mailbox.id);

    verified += 1;
  }

  if (verified) log('info', `Проверено ящиков: ${verified}`);
  return verified;
}

/**
 * Перепроверка упавших ящиков своего адреса, чья пауза вышла. Вход прошёл —
 * ящик снова «Подтверждён» (часы падения сбрасывает база), письма его лидов
 * уходят сами. Не прошёл — следующая попытка по лестнице, через неделю
 * автопроверка останавливается.
 */
export async function recheckFailedMailboxes(opts: { egressIp: string; log?: Log }): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const { data, error } = await db
    .from('sender_mailboxes')
    .select('*')
    .eq('status', 'failed')
    // Выключенный ящик — решение человека, его не трогаем.
    .eq('enabled', true)
    .eq('egress_ip', opts.egressIp)
    .lte('next_recheck_at', new Date().toISOString())
    .order('next_recheck_at')
    .limit(RECHECK_BATCH);
  if (error) throw new Error(`упавшие ящики не прочитаны: ${error.message}`);

  let recovered = 0;
  for (const mailbox of (data ?? []) as MailboxRow[]) {
    const nowIso = new Date().toISOString();
    const check = await checkMailboxLogin(mailbox);

    if (check.ok) {
      await db
        .from('sender_mailboxes')
        .update({ status: 'verified', last_verified_at: nowIso, last_error: check.imapNote, updated_at: nowIso })
        .eq('id', mailbox.id)
        .eq('status', 'failed');
      recovered += 1;
      log('info', `Ящик ${mailbox.email} снова работает — перепроверка прошла`);
      continue;
    }

    const attempts = (mailbox.recheck_attempts ?? 0) + 1;
    const next = nextRecheckAt(attempts, mailbox.failed_at ?? null, Date.now());
    await db
      .from('sender_mailboxes')
      .update({
        last_error: next ? check.error : `${check.error} — автопроверка остановлена, проверьте вход вручную`,
        recheck_attempts: attempts,
        next_recheck_at: next,
        updated_at: nowIso,
      })
      .eq('id', mailbox.id)
      .eq('status', 'failed');
    log('warn', `Ящик ${mailbox.email}: перепроверка ${attempts} не прошла (${check.code ?? 'доступ'})${next ? '' : ', автопроверка остановлена'}`);
  }
  return recovered;
}
