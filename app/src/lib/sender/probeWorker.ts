import 'server-only';

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { assertSafeImapTarget } from '@/lib/byoMailbox/netGuard';
import { authForMailbox } from './mailboxAuth';
import { sendSenderMail } from './smtp';
import { buildMessageId } from './template';
import type { MailboxRow } from './types';

/**
 * Проверочная отправка с разбором заголовков (задача 5.9 хендоффа масштаба).
 *
 * И сендер, и Instantly пишут в базу то, что ОТПРАВИЛИ, а не то, что
 * ДОСТАВИЛОСЬ. Переписывание заголовков на стороне провайдера (доменная
 * ротация Maildoso ломала все цепочки: лид получал первое письмо с домена X,
 * фоллоу-ап — с домена Y) было невидимо до сравнения Message-ID руками.
 *
 * Проба: письмо с ящика → на внешний контрольный адрес → читаем его там же →
 * сравниваем From, Return-Path, DKIM d=, Message-ID и Authentication-Results
 * с тем, что записали при отправке. Расхождение = провайдер переписывает.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

/** Сколько проб отправляем и сколько проверяем за один тик воркера. */
const SEND_PER_TICK = 2;
const CHECK_PER_TICK = 5;
/** Письмо должно дойти до контрольного ящика за это время, иначе проба провалена. */
const DELIVERY_TIMEOUT_MS = 15 * 60 * 1000;
/** Первую проверку доставки делаем не сразу — провайдерам нужна минута. */
const FIRST_CHECK_DELAY_MS = 30_000;

export interface ProbeCheck {
  check: string;
  expected: string | null;
  actual: string | null;
  ok: boolean;
  note: string | null;
}

export interface ProbeConfig {
  toEmail: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
}

export function probeConfig(): ProbeConfig | null {
  const toEmail = process.env.SENDER_PROBE_TO_EMAIL?.trim();
  const host = process.env.SENDER_PROBE_IMAP_HOST?.trim();
  const user = process.env.SENDER_PROBE_IMAP_USER?.trim();
  const password = process.env.SENDER_PROBE_IMAP_PASSWORD;
  if (!toEmail || !host || !user || !password) return null;
  return {
    toEmail,
    imapHost: host,
    imapPort: Number(process.env.SENDER_PROBE_IMAP_PORT ?? 993) || 993,
    imapUser: user,
    imapPassword: password,
  };
}

function domainOf(email: string | null): string | null {
  if (!email) return null;
  const match = email.toLowerCase().match(/@([^>\s]+)/);
  return match ? match[1] : null;
}

function addressOf(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const bracket = headerValue.match(/<([^<>]+)>/);
  if (bracket) return bracket[1].toLowerCase();
  const bare = headerValue.match(/([^\s<>]+@[^\s<>]+)/);
  return bare ? bare[1].toLowerCase() : null;
}

/**
 * Сравнение отправленного с доставленным. Чистая функция — весь разбор
 * заголовков уже сделан, здесь только правила и человеческие формулировки.
 */
export function compareProbeHeaders(
  sent: { from: string; messageId: string },
  got: {
    from: string | null;
    returnPath: string | null;
    dkimDomain: string | null;
    messageId: string | null;
    authResults: string | null;
  },
): { checks: ProbeCheck[]; passed: boolean } {
  const expectedDomain = domainOf(sent.from);
  const checks: ProbeCheck[] = [];
  const add = (check: string, expected: string | null, actual: string | null, ok: boolean, note: string | null) =>
    checks.push({ check, expected, actual, ok, note });

  const gotFrom = addressOf(got.from);
  add(
    'From',
    sent.from.toLowerCase(),
    gotFrom,
    gotFrom === sent.from.toLowerCase(),
    gotFrom && gotFrom !== sent.from.toLowerCase()
      ? `отправлено от ${sent.from}, доставлено от ${gotFrom} — провайдер переписывает адрес`
      : null,
  );

  const gotReturnPath = addressOf(got.returnPath);
  add(
    'Return-Path',
    sent.from.toLowerCase(),
    gotReturnPath,
    gotReturnPath === sent.from.toLowerCase(),
    gotReturnPath && gotReturnPath !== sent.from.toLowerCase()
      ? `обратный адрес стал ${gotReturnPath}: ответы лидов будут уходить не на наш ящик`
      : null,
  );

  add(
    'DKIM d=',
    expectedDomain,
    got.dkimDomain,
    Boolean(got.dkimDomain) && got.dkimDomain === expectedDomain,
    got.dkimDomain && got.dkimDomain !== expectedDomain
      ? `письмо подписано ключом домена ${got.dkimDomain} вместо ${expectedDomain} — доменная ротация`
      : null,
  );

  add(
    'Message-ID',
    sent.messageId,
    got.messageId,
    got.messageId === sent.messageId,
    got.messageId && got.messageId !== sent.messageId
      ? 'идентификатор подменён — привязка ответов к цепочке сломается'
      : null,
  );

  // Authentication-Results ставит принимающая сторона: это не про подмену
  // провайдером, а про то, доверяет ли получатель письму.
  const auth = got.authResults ?? '';
  for (const mechanism of ['spf', 'dkim', 'dmarc'] as const) {
    const match = auth.match(new RegExp(`${mechanism}=(pass|fail|softfail|none|temperror|permerror)`, 'i'));
    if (!match) {
      add(mechanism.toUpperCase(), 'pass', null, true, 'в Authentication-Results не упомянут — получатель его не проверял');
      continue;
    }
    const value = match[1].toLowerCase();
    add(mechanism.toUpperCase(), 'pass', value, value === 'pass', value === 'pass' ? null : `${mechanism}=${value}: письмо может уходить в спам`);
  }

  const passed = checks.every((c) => c.ok);
  return { checks, passed };
}

/** Заголовки доставленного письма, которые сравниваем. */
async function readDeliveredProbe(cfg: ProbeConfig, messageId: string): Promise<{
  from: string | null;
  returnPath: string | null;
  dkimDomain: string | null;
  messageId: string | null;
  authResults: string | null;
} | null> {
  const guard = await assertSafeImapTarget(cfg.imapHost, cfg.imapPort);
  if (!guard.ok) throw new Error(`IMAP контрольного ящика отклонён (${guard.reason})`);

  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.imapUser, pass: cfg.imapPassword },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    const uids = await client.search({ header: { 'message-id': messageId } });
    if (!uids || !uids.length || typeof uids === 'boolean') return null;

    for await (const msg of client.fetch(String(uids[uids.length - 1]), { source: true }, { uid: true })) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source as Buffer);
      const headers = parsed.headers as Map<string, string>;
      const header = (name: string): string | null => {
        const value = headers.get(name);
        return (Array.isArray(value) ? value[0] : value) ?? null;
      };
      const dkimRaw = header('dkim-signature') ?? '';
      const dkimMatch = dkimRaw.match(/d=([^\s;>]+)/i);
      return {
        from: parsed.from?.text ?? null,
        returnPath: header('return-path'),
        dkimDomain: dkimMatch ? dkimMatch[1].toLowerCase() : null,
        messageId: parsed.messageId ?? null,
        authResults: header('authentication-results'),
      };
    }
    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}

async function sendProbe(probe: { id: string; mailbox_id: string }, log: Log): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const { data: row } = await db.from('sender_mailboxes').select('*').eq('id', probe.mailbox_id).maybeSingle();
  const mailbox = row as MailboxRow | null;
  if (!mailbox) {
    await db.from('sender_send_probes')
      .update({ status: 'failed', error: 'Ящик не найден', updated_at: new Date().toISOString() })
      .eq('id', probe.id);
    return;
  }

  const cfg = probeConfig();
  if (!cfg) {
    await db.from('sender_send_probes')
      .update({
        status: 'failed',
        error: 'Контрольный ящик не настроен на сервере (SENDER_PROBE_*) — попросите настроить',
        updated_at: new Date().toISOString(),
      })
      .eq('id', probe.id);
    return;
  }

  const auth = await authForMailbox(mailbox);
  if (!auth.ok) {
    await db.from('sender_send_probes')
      .update({ status: 'failed', error: `Ящик не вошёл: ${auth.error}`, updated_at: new Date().toISOString() })
      .eq('id', probe.id);
    return;
  }

  const messageId = buildMessageId(mailbox.email);
  const name = (mailbox.display_name ?? '').trim();
  const from = name ? `${name} <${mailbox.email}>` : mailbox.email;
  const result = await sendSenderMail(
    {
      host: mailbox.smtp_host,
      port: mailbox.smtp_port,
      tlsMode: mailbox.smtp_tls_mode,
      username: mailbox.username,
      auth: auth.smtp,
    },
    {
      from,
      to: cfg.toEmail,
      subject: 'Проверка отправки портала',
      text: 'Служебное письмо: проверяем, как провайдер доставляет почту с этого ящика. Отвечать не нужно.',
      messageId,
    },
  );

  const nowIso = new Date().toISOString();
  if (!result.ok) {
    await db.from('sender_send_probes')
      .update({ status: 'failed', error: `Отправка не прошла (${result.code}): ${result.error ?? ''}`.slice(0, 500), updated_at: nowIso })
      .eq('id', probe.id);
    log('warn', `Проба ${mailbox.email}: отправка не прошла (${result.code})`);
    return;
  }

  await db.from('sender_send_probes')
    .update({ status: 'sent', sent_message_id: messageId, sent_from: mailbox.email, sent_at: nowIso, updated_at: nowIso })
    .eq('id', probe.id);
  log('info', `Проба ${mailbox.email}: письмо ушло на ${cfg.toEmail}, ждём доставки`);
}

/**
 * Проверка доставки: читает контрольный ящик (не наш) и сравнивает заголовки.
 * Контрольный ящик один на весь парк, поэтому проверяет его ведущий воркер.
 */
export async function checkDeliveredProbes(log: Log): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;
  const cfg = probeConfig();
  if (!cfg) return;

  const { data: rows } = await db
    .from('sender_send_probes')
    .select('*')
    .eq('status', 'sent')
    .lt('sent_at', new Date(Date.now() - FIRST_CHECK_DELAY_MS).toISOString())
    .order('sent_at')
    .limit(CHECK_PER_TICK);
  const probes = (rows ?? []) as {
    id: string;
    sent_message_id: string | null;
    sent_from: string | null;
    sent_at: string;
    attempts: number;
  }[];
  if (!probes.length) return;

  for (const probe of probes) {
    const age = Date.now() - new Date(probe.sent_at).getTime();
    if (age > DELIVERY_TIMEOUT_MS) {
      await db.from('sender_send_probes')
        .update({
          status: 'failed',
          error: `Письмо не дошло до контрольного ящика за ${Math.round(age / 60_000)} минут`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', probe.id);
      log('warn', `Проба ${probe.sent_from}: письмо не дошло до контрольного ящика`);
      continue;
    }

    let delivered: Awaited<ReturnType<typeof readDeliveredProbe>> = null;
    try {
      delivered = await readDeliveredProbe(cfg, probe.sent_message_id ?? '');
    } catch (e) {
      log('warn', `Проба ${probe.sent_from}: контрольный ящик не прочитался (${e instanceof Error ? e.message : String(e)})`);
    }

    if (!delivered) {
      await db.from('sender_send_probes')
        .update({ attempts: probe.attempts + 1, updated_at: new Date().toISOString() })
        .eq('id', probe.id);
      continue;
    }

    const { checks, passed } = compareProbeHeaders(
      { from: probe.sent_from ?? '', messageId: probe.sent_message_id ?? '' },
      delivered,
    );
    await db.from('sender_send_probes')
      .update({
        status: 'done',
        received_at: new Date().toISOString(),
        result: checks,
        passed,
        updated_at: new Date().toISOString(),
      })
      .eq('id', probe.id);
    log(passed ? 'info' : 'warn', `Проба ${probe.sent_from}: ${passed ? 'заголовки не тронуты' : 'есть расхождения в заголовках'}`);
  }
}

/**
 * Отправка заведённых проб — только с ящиков своего адреса: проба — такой же
 * вход в ящик, как рассылка. Доставку проверяет ведущий: checkDeliveredProbes.
 */
export async function sendPendingProbes(opts: { egressIp: string; log?: Log }): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const { data: pending } = await db
    .from('sender_send_probes')
    .select('id, mailbox_id')
    .eq('status', 'pending')
    .order('created_at')
    .limit(50);
  const rows = (pending ?? []) as { id: string; mailbox_id: string }[];
  if (!rows.length) return;

  const { data: owned } = await db
    .from('sender_mailboxes')
    .select('id')
    .in('id', [...new Set(rows.map((r) => r.mailbox_id))])
    .eq('egress_ip', opts.egressIp);
  const mine = new Set((owned ?? []).map((row) => String(row.id)));

  for (const probe of rows.filter((r) => mine.has(r.mailbox_id)).slice(0, SEND_PER_TICK)) {
    await sendProbe(probe, log);
  }
}
