import 'server-only';

/**
 * Отправка ссылки подтверждения почты ENG-клиенту — общая для регистрации
 * (api/signup, ветка ENG) и кнопки «Send a new link»
 * (api/client/eng-email/resend).
 *
 * Ссылка всегда на ENG-хост из окружения (ENG_APP_HOST), а не на Host запроса:
 * адрес в письме не должен зависеть от заголовка, который присылает клиент.
 * Имя отправителя — 'outreachOS'; адрес — общий транзакционный ящик
 * (SMTP_FROM_EMAIL / SMTP_USER), тот же, что у писем сброса пароля.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderEngEmailVerificationEmail } from '@/lib/email/templates/engEmailVerification';
import { ENG_APP_HOST } from '@/lib/engMarket';
import { issueHeEngEmailVerification, type HeEngIssueOutcome } from './engEmailVerification';

export const HE_ENG_VERIFY_FROM_NAME = 'outreachOS';

export function heEngAppOrigin(): string {
  return `https://${ENG_APP_HOST}`;
}

export function sendHeEngVerificationEmail(
  db: SupabaseClient,
  args: { userId: string; email: string | null },
): Promise<HeEngIssueOutcome> {
  return issueHeEngEmailVerification(db, {
    userId: args.userId,
    email: args.email,
    origin: heEngAppOrigin(),
    send: async (letter) => {
      const { subject, html, text } = renderEngEmailVerificationEmail({
        link: letter.link,
        expiresAt: letter.expiresAt,
      });
      await sendTransactionalEmail({ to: letter.to, subject, html, text, fromName: HE_ENG_VERIFY_FROM_NAME });
    },
  });
}
