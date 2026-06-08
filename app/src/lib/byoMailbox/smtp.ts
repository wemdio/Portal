import 'server-only';

import nodemailer from 'nodemailer';

/**
 * Минимальный SMTP-движок для BYO-почт: проверка соединения и тестовая отправка
 * ЧЕРЕЗ SMTP-сервер провайдера клиента (наш сервер выступает как почтовый клиент,
 * логинится в ящик и шлёт от его имени). Свои IP/сервера не поднимаем.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface SmtpResult {
  ok: boolean;
  error?: string;
}

function buildTransport(cfg: SmtpConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure, // true → 465 (implicit TLS); false → 587 (STARTTLS)
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Проверяет, что с указанными кредами реально получается залогиниться в SMTP. */
export async function verifySmtp(cfg: SmtpConfig): Promise<SmtpResult> {
  const transport = buildTransport(cfg);
  try {
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toMessage(e) };
  } finally {
    transport.close();
  }
}

/** Шлёт тестовое письмо (обычно клиент сам себе) — финальное подтверждение, что отправка работает. */
export async function sendTestEmail(cfg: SmtpConfig, from: string, to: string): Promise<SmtpResult> {
  const transport = buildTransport(cfg);
  try {
    await transport.sendMail({
      from,
      to,
      subject: 'Portal · тест подключения почты',
      text:
        'Это тестовое письмо из портала: ваш ящик успешно подключён для отправки.\n' +
        'Если вы это видите — SMTP настроен правильно.',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toMessage(e) };
  } finally {
    transport.close();
  }
}

/** Отправка через Gmail по OAuth2 (XOAUTH2). refreshToken хранится зашифрованным. */
export interface GmailOAuthConfig {
  email: string;
  refreshToken: string;
}

function getGoogleOAuthCreds(): { clientId: string; clientSecret: string } {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not configured');
  }
  return { clientId, clientSecret };
}

function buildOAuthTransport(cfg: GmailOAuthConfig) {
  const { clientId, clientSecret } = getGoogleOAuthCreds();
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      type: 'OAuth2',
      user: cfg.email,
      clientId,
      clientSecret,
      refreshToken: cfg.refreshToken,
      // accessToken не передаём — nodemailer сам получит его по refreshToken.
    },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Проверяет, что по OAuth2 реально получается авторизоваться в Gmail SMTP. */
export async function verifyOAuthGmail(cfg: GmailOAuthConfig): Promise<SmtpResult> {
  const transport = buildOAuthTransport(cfg);
  try {
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toMessage(e) };
  } finally {
    transport.close();
  }
}

/** Тестовое письмо через Gmail OAuth2 (обычно клиент сам себе). */
export async function sendTestOAuthGmail(cfg: GmailOAuthConfig, to: string): Promise<SmtpResult> {
  const transport = buildOAuthTransport(cfg);
  try {
    await transport.sendMail({
      from: cfg.email,
      to,
      subject: 'Portal · тест подключения почты',
      text:
        'Это тестовое письмо из портала: ваш Gmail-ящик подключён через OAuth и готов к отправке.\n' +
        'Если вы это видите — всё настроено правильно.',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toMessage(e) };
  } finally {
    transport.close();
  }
}
