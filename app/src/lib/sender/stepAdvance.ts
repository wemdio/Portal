import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Сдвиг получателя по цепочке после отправленного письма: номер шага, корень
 * переписки и когда следующий шаг. Правило одно на двоих: отправка пишет его
 * сразу после письма (sendWorker.afterSend), а планировщик — когда эта запись
 * не легла и он нашёл письмо текущего шага уже отправленным
 * (planner.settleTakenStep).
 */

/** Отправленное письмо шага — то, что о нём нужно для сдвига. */
export interface SentStep {
  recipientId: string;
  stepNo: number;
  /** Message-ID письма: у первого шага он становится корнем переписки. */
  messageId: string;
  /** Когда письмо ушло: от него считается задержка следующего шага. */
  sentAt: string;
}

/**
 * Что записать получателю. Шаг отправлен; Message-ID первого письма — корень
 * переписки: follow-up уходят ответом в него, и у получателя это одна ветка, а
 * не отдельные письма. Следующий шаг — через его задержку от отправки; шагов
 * больше нет — цепочка пройдена.
 */
export function recipientPatchAfterSend(sent: SentStep, nextStep: { delay_hours: number } | null): Record<string, unknown> {
  const patch: Record<string, unknown> = { last_step_sent: sent.stepNo, updated_at: sent.sentAt };
  if (sent.stepNo === 1) patch.thread_message_id = sent.messageId;
  if (nextStep) {
    patch.next_step_at = new Date(new Date(sent.sentAt).getTime() + nextStep.delay_hours * 60 * 60 * 1000).toISOString();
  } else {
    patch.status = 'finished';
    patch.next_step_at = null;
  }
  return patch;
}

/**
 * Записать сдвиг. onlyFrom — сдвигать, только если получатель ещё активен и
 * стоит на прочитанном шаге (last_step_sent): между чтением и этой записью
 * его могла сдвинуть сама отправка или остановить ответ, и повторный сдвиг
 * перескочил бы шаг или затёр бы ответ. true — получатель сдвинут; сбой базы
 * — исключение.
 */
export async function advanceRecipient(
  db: SupabaseClient,
  sent: SentStep,
  nextStep: { delay_hours: number } | null,
  onlyFrom?: { lastStepSent: number },
): Promise<boolean> {
  let query = db.from('sender_recipients').update(recipientPatchAfterSend(sent, nextStep)).eq('id', sent.recipientId);
  if (onlyFrom) query = query.eq('status', 'active').eq('last_step_sent', onlyFrom.lastStepSent);
  const { data, error } = await query.select('id');
  if (error) throw new Error(error.message);
  return Boolean(data?.length);
}
