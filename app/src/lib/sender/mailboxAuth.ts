import 'server-only';

import { unsealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { accessTokenForMailbox } from './googleWorkspace';
import type { MailboxAuth } from './smtp';
import type { MailboxRow } from './types';

/**
 * Чем входить в ящик: паролем из выгрузки провайдера или ключом Google.
 *
 * Собрано в одном месте, потому что вход нужен трём воркерам — проверке,
 * отправке и чтению ответов, — и расходиться они не должны: ящик, который
 * прошёл проверку, обязан теми же правами уметь и отправлять, и читать.
 *
 * Отказ здесь — это отказ ящика, а не письма: причину возвращаем текстом,
 * чтобы она легла в карточку ящика и человек увидел, что чинить.
 */
export type MailboxAuthResult =
  | { ok: true; smtp: MailboxAuth; imap: MailboxAuth }
  | { ok: false; error: string };

export async function authForMailbox(mailbox: MailboxRow): Promise<MailboxAuthResult> {
  if (mailbox.auth_type === 'google_sa') {
    try {
      const token = await accessTokenForMailbox(mailbox.email);
      const auth: MailboxAuth = { kind: 'oauth', accessToken: token };
      return { ok: true, smtp: auth, imap: auth };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Google не выдал доступ к ящику: ${text}`.slice(0, 400) };
    }
  }

  if (!mailbox.secret_encrypted) return { ok: false, error: 'Нет пароля ящика' };

  const secret = unsealMailboxSecret(mailbox.secret_encrypted);
  if (!secret.smtpPassword) return { ok: false, error: 'Нет пароля ящика' };

  return {
    ok: true,
    smtp: { kind: 'password', password: secret.smtpPassword },
    // Отдельный пароль для чтения бывает у части провайдеров; нет — берём тот же.
    imap: { kind: 'password', password: secret.imapPassword || secret.smtpPassword },
  };
}
