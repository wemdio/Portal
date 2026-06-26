import 'server-only';
import nodemailer from 'nodemailer';

/**
 * Transactional email via SMTP (Google Workspace).
 *
 * Reuses the nodemailer dependency already in the project for BYO-mailbox
 * sending in outreach (see app/src/lib/byoMailbox/smtp.ts). For the volume
 * of password-reset / confirmation emails we expect (a handful per day),
 * a corporate Workspace inbox is the simplest path: standard SMTP, no
 * third-party HTTP API, deliverability handled by Google.
 *
 * Required env (set on prod):
 *   SMTP_HOST       — e.g. smtp.gmail.com
 *   SMTP_PORT       — 465 (implicit TLS) or 587 (STARTTLS)
 *   SMTP_USER       — full mailbox, e.g. no-reply@outreachos.pro
 *   SMTP_PASS       — App Password (16 chars) generated for the user
 *                     account after enabling 2-Step Verification
 *   SMTP_FROM_EMAIL — defaults to SMTP_USER if unset
 *   SMTP_FROM_NAME  — defaults to "Portal" if unset
 */

export interface SendTransactionalEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendTransactionalEmailResult {
  /** Nodemailer message id (e.g. "<abc@smtp.gmail.com>") — for log correlation. */
  id: string;
  /** "accepted" when at least one recipient was accepted by the SMTP server. */
  status: string;
}

export async function sendTransactionalEmail(
  args: SendTransactionalEmailArgs,
): Promise<SendTransactionalEmailResult> {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const fromEmail = process.env.SMTP_FROM_EMAIL ?? user;
  const fromName = process.env.SMTP_FROM_NAME ?? 'Portal';

  if (!host) throw new Error('SMTP_HOST is not set');
  if (!portRaw) throw new Error('SMTP_PORT is not set');
  if (!user) throw new Error('SMTP_USER is not set');
  if (!pass) throw new Error('SMTP_PASS is not set');
  if (!fromEmail) throw new Error('SMTP_FROM_EMAIL or SMTP_USER must be set');

  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`SMTP_PORT must be a positive number, got ${portRaw}`);
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    // 465 = implicit TLS; 587 = STARTTLS upgrade. Anything else: caller's
    // responsibility (we default to plain false).
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  try {
    const info = await transport.sendMail({
      from: { name: fromName, address: fromEmail },
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    return {
      id: info.messageId ?? '',
      status: info.accepted?.length ? 'accepted' : 'unknown',
    };
  } finally {
    transport.close();
  }
}
