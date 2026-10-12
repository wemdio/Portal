import 'server-only';

/**
 * Письмо ENG-клиенту «отправка включена» — после включения выключателя
 * сотрудником (api/admin/users/[id]/eng-sending). Тот же транзакционный ящик и
 * то же имя отправителя, что у письма подтверждения почты
 * (engEmailVerificationMail.ts). Отдельным модулем от engSendingAccess.ts:
 * гейт выключателя читает и ночной долив (воркер), а SMTP ему не нужен.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderEngSendingEnabledEmail, type EngSendingEnabledCopy } from '@/lib/email/templates/engSendingEnabled';
import { logWarn } from '@/lib/loggerServer';
import { heEngAppOrigin, HE_ENG_VERIFY_FROM_NAME } from './engEmailVerificationMail';
import { HE_ENG_SENDING_ACCESS_TABLE } from './engSendingAccess';

export type HeEngSendingEmailResult = { kind: 'sent' } | { kind: 'no_email' } | { kind: 'failed'; message: string };

/**
 * Отправить письмо. Отметка email_sent_at — только после того, как SMTP-сервер
 * его принял (её показывает экран сотрудника). `copy` — какой текст (выбирает
 * роут включения по состоянию аккаунта прямо перед отправкой; нет — 'auto').
 * НЕ БРОСАЕТ.
 */
export async function sendHeEngSendingEnabledEmail(
  db: SupabaseClient,
  userId: string,
  email: string | null,
  copy?: EngSendingEnabledCopy,
): Promise<HeEngSendingEmailResult> {
  if (!email) return { kind: 'no_email' };
  try {
    const { subject, html, text } = renderEngSendingEnabledEmail({
      dashboardUrl: `${heEngAppOrigin()}/client/eng/dashboard`,
      copy,
    });
    await sendTransactionalEmail({ to: email, subject, html, text, fromName: HE_ENG_VERIFY_FROM_NAME });
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
  try {
    const { error } = await db
      .from(HE_ENG_SENDING_ACCESS_TABLE)
      .update({ email_sent_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) {
      void logWarn('he.eng_sending_access.email_mark_failed', `${error.code ?? 'error'} ${String(error.message ?? '').slice(0, 200)}`, {
        userId,
      });
    }
  } catch {
    // Письмо ушло; не записанная отметка — только экран сотрудника.
  }
  return { kind: 'sent' };
}
