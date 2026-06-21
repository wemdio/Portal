import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { unsealMailboxSecret } from './credentials';
import { sendMailViaSmtp, sendMailViaOAuthGmail, sendMailViaOAuthToken, type SmtpResult } from './smtp';
import { getYandexAccessTokenFromRefresh } from './yandexOAuth';

/**
 * Движок отправки BYO-кампаний: берёт письма из очереди client_byo_messages
 * (status='pending', scheduled_at<=now) и шлёт их через подключённый ящик клиента
 * нашим SMTP-движком, соблюдая дневной лимит ящика и паузу между письмами.
 */

export interface MailboxRow {
  id: string;
  client_user_id: string;
  email: string;
  display_name: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  username: string;
  secret_encrypted: string;
  auth_type: string;
  daily_limit: number;
  status: string;
}

interface QueuedMessage {
  id: string;
  mailbox_id: string;
  to_email: string;
  to_name: string | null;
  subject: string;
  body: string;
  attempts: number;
}

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const MAILBOX_COLS =
  'id, client_user_id, email, display_name, smtp_host, smtp_port, smtp_secure, username, secret_encrypted, auth_type, daily_limit, status';

function fromHeader(mb: MailboxRow): string {
  const name = (mb.display_name || '').trim();
  return name ? `${name} <${mb.email}>` : mb.email;
}

/** Отправить одно письмо через конкретный ящик (расшифровывает креды, выбирает SMTP/OAuth). */
export async function sendViaMailbox(
  mb: MailboxRow,
  msg: { to: string; subject: string; text: string },
): Promise<SmtpResult> {
  const secret = unsealMailboxSecret(mb.secret_encrypted);
  const from = fromHeader(mb);
  if (mb.auth_type === 'oauth_google') {
    if (!secret.oauthRefreshToken) return { ok: false, error: 'reauth_required' };
    return sendMailViaOAuthGmail(
      { email: mb.email, refreshToken: secret.oauthRefreshToken },
      { from, to: msg.to, subject: msg.subject, text: msg.text },
    );
  }
  if (mb.auth_type === 'oauth_yandex') {
    if (!secret.oauthRefreshToken) return { ok: false, error: 'reauth_required' };
    let accessToken: string;
    try {
      accessToken = await getYandexAccessTokenFromRefresh(secret.oauthRefreshToken);
    } catch {
      return { ok: false, error: 'reauth_required' }; // refresh-токен умер → нужна переавторизация
    }
    return sendMailViaOAuthToken(
      { host: 'smtp.yandex.ru', port: 465, secure: true, user: mb.email, accessToken },
      { from, to: msg.to, subject: msg.subject, text: msg.text },
    );
  }
  if (!secret.smtpPassword) return { ok: false, error: 'no_smtp_password' };
  return sendMailViaSmtp(
    { host: mb.smtp_host, port: mb.smtp_port, secure: mb.smtp_secure, username: mb.username, password: secret.smtpPassword },
    { from, to: msg.to, subject: msg.subject, text: msg.text },
  );
}

async function sentTodayCount(mailboxId: string): Promise<number> {
  if (!supabaseAdmin) return Number.MAX_SAFE_INTEGER;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from('client_byo_messages')
    .select('id', { count: 'exact', head: true })
    .eq('mailbox_id', mailboxId)
    .eq('status', 'sent')
    .gte('sent_at', since.toISOString());
  return count ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Один проход дренажа очереди. Возвращает true, если что-то реально отправили
 * (тогда воркер сразу делает следующий проход). Письма сверх дневного лимита
 * остаются 'pending' до следующего окна.
 */
export async function processByoSendBatch(opts?: {
  batchSize?: number;
  gapMs?: number;
  log?: Log;
}): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const batchSize = opts?.batchSize ?? 25;
  const gapMs = opts?.gapMs ?? 4000;
  const log: Log = opts?.log ?? (() => {});
  const nowIso = new Date().toISOString();

  const { data: msgs } = await supabaseAdmin
    .from('client_byo_messages')
    .select('id, mailbox_id, to_email, to_name, subject, body, attempts')
    .eq('status', 'pending')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(batchSize);

  if (!msgs?.length) return false;

  const mbCache = new Map<string, MailboxRow | null>();
  const remaining = new Map<string, number>(); // оставшийся дневной бюджет по ящику
  let processed = 0;

  for (const m of msgs as QueuedMessage[]) {
    let mb = mbCache.get(m.mailbox_id);
    if (mb === undefined) {
      const { data } = await supabaseAdmin
        .from('client_mailbox_accounts')
        .select(MAILBOX_COLS)
        .eq('id', m.mailbox_id)
        .maybeSingle();
      mb = (data as MailboxRow | null) ?? null;
      mbCache.set(m.mailbox_id, mb);
      if (mb) {
        const used = await sentTodayCount(m.mailbox_id);
        remaining.set(m.mailbox_id, Math.max(0, (mb.daily_limit ?? 0) - used));
      }
    }

    if (!mb) {
      await supabaseAdmin
        .from('client_byo_messages')
        .update({ status: 'failed', error: 'mailbox_unavailable' })
        .eq('id', m.id);
      continue;
    }
    // Ящик не готов (выключен / требует переподключения) — письмо оставляем в очереди.
    if (mb.status !== 'verified') continue;

    const left = remaining.get(m.mailbox_id) ?? 0;
    if (left <= 0) continue; // дневной лимит исчерпан — оставляем на следующее окно

    const res = await sendViaMailbox(mb, { to: m.to_email, subject: m.subject, text: m.body });
    const attempts = (m.attempts ?? 0) + 1;

    if (res.ok) {
      await supabaseAdmin
        .from('client_byo_messages')
        .update({ status: 'sent', sent_at: new Date().toISOString(), error: null, attempts })
        .eq('id', m.id);
      remaining.set(m.mailbox_id, left - 1);
      processed++;
      await sleep(gapMs);
    } else if (res.error === 'reauth_required') {
      // Токен доступа умер → помечаем ящик на переподключение; письмо оставляем в очереди.
      await supabaseAdmin
        .from('client_mailbox_accounts')
        .update({ status: 'failed', last_error: 'Токен доступа истёк — переподключите ящик.' })
        .eq('id', mb.id);
      remaining.set(m.mailbox_id, 0); // остальные письма этого ящика в этом проходе не трогаем
      log('warn', `BYO mailbox ${mb.email} requires re-auth — marked for reconnect`);
    } else {
      const status = attempts >= 3 ? 'failed' : 'pending';
      await supabaseAdmin
        .from('client_byo_messages')
        .update({ status, error: res.error ?? 'send_failed', attempts })
        .eq('id', m.id);
      log('warn', `BYO send failed → ${m.to_email}: ${res.error ?? 'unknown'}`);
    }
  }

  return processed > 0;
}
