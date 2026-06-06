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
