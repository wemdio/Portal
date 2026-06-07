import 'server-only';

import { encryptJsonAes256Gcm, decryptJsonAes256Gcm } from '@/lib/cryptoGcm';

/**
 * Шифрование секретов BYO-почт (пароли приложений SMTP/IMAP).
 * Зеркалит паттерн lib/tools/polzaReports/credentials.ts — отдельный ключ на фичу.
 */

export interface MailboxSecret {
  /** app-password для SMTP (auth_type='password'). */
  smtpPassword?: string;
  imapPassword?: string;
  /** refresh-token для OAuth (auth_type='oauth_google'). */
  oauthRefreshToken?: string;
}

function getCipherKey(): string {
  const key = (process.env.BYO_MAILBOX_CRED_KEY ?? '').trim();
  if (!key) {
    throw new Error(
      'BYO_MAILBOX_CRED_KEY is not configured — cannot seal/unseal mailbox credentials. ' +
        'Generate one with `openssl rand -base64 32` and add it to the portal env.',
    );
  }
  return key;
}

/** AES-256-GCM seal — значение для client_mailbox_accounts.secret_encrypted. */
export function sealMailboxSecret(secret: MailboxSecret): string {
  return encryptJsonAes256Gcm(
    {
      smtpPassword: secret.smtpPassword,
      imapPassword: secret.imapPassword,
      oauthRefreshToken: secret.oauthRefreshToken,
    },
    getCipherKey(),
  );
}

/** Обратное к sealMailboxSecret. Бросает на подделанном/неверном ключе. */
export function unsealMailboxSecret(sealed: string): MailboxSecret {
  const decoded = decryptJsonAes256Gcm<MailboxSecret>(sealed, getCipherKey());
  return {
    smtpPassword: decoded?.smtpPassword ? String(decoded.smtpPassword) : undefined,
    imapPassword: decoded?.imapPassword ? String(decoded.imapPassword) : undefined,
    oauthRefreshToken: decoded?.oauthRefreshToken ? String(decoded.oauthRefreshToken) : undefined,
  };
}
