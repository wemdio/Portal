import 'server-only';

import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { assertSafeImapTarget, assertSafeSmtpTarget } from '@/lib/byoMailbox/netGuard';
import type { TlsMode } from './mailboxImport';

/**
 * Отправка письма через SMTP провайдера подключённого ящика. Портал выступает
 * обычным почтовым клиентом: свой MTA и свои IP не поднимаем, подпись DKIM
 * ставит провайдер ящика.
 */

export interface SenderSmtpConfig {
  host: string;
  port: number;
  tlsMode: TlsMode;
  username: string;
  password: string;
}

export interface SenderImapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface SendResult {
  ok: boolean;
  /** Машинный код для разбора ретраев: см. classifySmtpError. */
  code?: SendErrorCode;
  error?: string;
}

export type SendErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'recipient_rejected'
  | 'temporary'
  | 'network'
  | 'blocked_target'
  | 'unknown';

function buildTransport(cfg: SenderSmtpConfig) {
  const implicit = cfg.tlsMode === 'implicit_tls';
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: implicit,
    // Для 587 STARTTLS обязателен: без requireTLS nodemailer молча отправит
    // письмо и пароль открытым текстом, если сервер не предложит STARTTLS.
    requireTLS: !implicit,
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Тип ошибки провайдера. Повторять всё подряд одинаково нельзя: неверный
 * пароль надо чинить руками, лимит — переждать, отказ по получателю — больше
 * не пытаться.
 */
export function classifySmtpError(error: unknown): SendErrorCode {
  const raw = messageOf(error);
  const text = raw.toLowerCase();
  const code = (error as { responseCode?: number; code?: string } | null)?.responseCode;
  const netCode = (error as { code?: string } | null)?.code ?? '';

  if (/invalid login|authentication failed|auth.*(failed|invalid)|535/.test(text)) return 'auth';
  if (code === 421 || code === 450 || code === 451 || code === 452) return 'temporary';
  if (/rate limit|too many|quota|throttl|4\.7\.0|try again later/.test(text)) return 'rate_limit';
  if (typeof code === 'number' && code >= 500 && code < 600) return 'recipient_rejected';
  if (/etimedout|econnreset|econnrefused|ehostunreach|enotfound|dns|socket/.test(`${text} ${netCode.toLowerCase()}`)) {
    return 'network';
  }
  if (typeof code === 'number' && code >= 400 && code < 500) return 'temporary';
  return 'unknown';
}

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Генерируется до отправки и сохраняется в очереди — по нему ловим ответ. */
  messageId: string;
  /** Для follow-up: письмо уходит в ту же переписку. */
  inReplyTo?: string | null;
  references?: string | null;
}

export async function sendSenderMail(cfg: SenderSmtpConfig, mail: OutgoingMail): Promise<SendResult> {
  const guard = await assertSafeSmtpTarget(cfg.host, cfg.port);
  if (!guard.ok) return { ok: false, code: 'blocked_target', error: `SMTP-цель отклонена (${guard.reason})` };

  const transport = buildTransport(cfg);
  try {
    await transport.sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo ?? undefined,
      references: mail.references ?? undefined,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, code: classifySmtpError(e), error: messageOf(e) };
  } finally {
    transport.close();
  }
}

/** Проверка входа по SMTP без отправки письма. */
export async function verifySenderSmtp(cfg: SenderSmtpConfig): Promise<SendResult> {
  const guard = await assertSafeSmtpTarget(cfg.host, cfg.port);
  if (!guard.ok) return { ok: false, code: 'blocked_target', error: `SMTP-цель отклонена (${guard.reason})` };

  const transport = buildTransport(cfg);
  try {
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, code: classifySmtpError(e), error: messageOf(e) };
  } finally {
    transport.close();
  }
}

/** Проверка входа по IMAP: без неё ящик отправляет, но ответы не читаются. */
export async function verifySenderImap(cfg: SenderImapConfig): Promise<SendResult> {
  const guard = await assertSafeImapTarget(cfg.host, cfg.port);
  if (!guard.ok) return { ok: false, code: 'blocked_target', error: `IMAP-цель отклонена (${guard.reason})` };

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  try {
    await client.connect();
    await client.logout().catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, code: classifySmtpError(e), error: messageOf(e) };
  }
}
