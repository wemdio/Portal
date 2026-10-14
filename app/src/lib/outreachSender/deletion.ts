import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { SenderOpError } from '@/lib/sender/campaignOps';
import type { MessageStatus } from '@/lib/sender/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { OUTREACH_ROW_TABLE, type OutreachLang } from './upload';

/**
 * Удаление рассылки из автоаутрича и удаление запуска аутрича так, чтобы
 * компания не получила вторую цепочку.
 *
 * Что компании уже писали, помнят только строки запуска: отметка заливки
 * (sender_uploaded_at и sender_campaign_id, upload.ts) не даёт залить строку
 * второй раз, а готовые строки не дают следующему запуску найти ту же компанию
 * («уже выгружалась», loadPreviouslyExported у обоих аутричей). Удаление
 * рассылки обнуляет в строках ссылку (внешний ключ), удаление запуска уносит
 * строки целиком — поэтому оба удаления решают здесь, что делать с этой памятью.
 */

/**
 * Письма, которые могли дойти до получателя: sent — ушло; sending — воркер
 * взял письмо в отправку и мог успеть; unknown — провайдер мог его принять
 * (обрыв после DATA, отправлено, но не записано). failed — провайдер отказал,
 * scheduled и canceled — письмо не уходило.
 */
const MAYBE_DELIVERED: MessageStatus[] = ['sent', 'sending', 'unknown'];

export interface OutreachCampaignDeleteResult {
  /** Строк запусков аутрича в этой рассылке. */
  rows: number;
  /** Хоть одно письмо могло дойти — отметки остаются, эти компании больше не зальются. */
  lettersSent: boolean;
  /** Строк, с которых снята отметка: после удаления рассылки их можно залить заново. */
  released: number;
}

function requireDb() {
  if (!supabaseAdmin) throw new SenderOpError('Сервис не настроен', 503);
  return supabaseAdmin;
}

/**
 * Перед удалением рассылки из автоаутрича — вызывать строго до удаления: после
 * него ссылки на рассылку в строках уже нет, и не понять, чьи это строки.
 *
 * Ни одно письмо не могло дойти — с её строк снимается дата заливки: рассылку
 * удаляют по ошибке (не та папка, не те компании), и компании можно залить
 * заново. Ссылку на рассылку обнулит само удаление (внешний ключ), а пока
 * рассылка жива, ссылка держит строку залитой: не удалось удалить — компании
 * не зальются второй раз, пока лежат в ней.
 *
 * Письма уходили — отметки остаются, эти компании больше не зальются никогда,
 * даже если ответили. Дату, снятую прошлой неудачной попыткой удаления,
 * возвращаем: рассылку могли потом запустить, и без даты строка после
 * удаления выглядела бы незалитой.
 *
 * Сбой любого запроса — ошибка, и рассылку удалять нельзя: снятые отметки
 * держит ссылка, а решение «уходили ли письма» без ответа базы не принимаем.
 */
export async function releaseOutreachRowsBeforeCampaignDelete(campaignId: string): Promise<OutreachCampaignDeleteResult> {
  const db = requireDb();
  const { count, error } = await db
    .from('sender_messages')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', MAYBE_DELIVERED);
  if (error) throw new SenderOpError(`Не удалось проверить, уходили ли письма рассылки: ${error.message}`, 500);
  const lettersSent = (count ?? 0) > 0;

  // Обе таблицы: рассылка одной папки получает строки только своего аутрича,
  // но чужая таблица стоит один запрос по частичному индексу.
  const result: OutreachCampaignDeleteResult = { rows: 0, lettersSent, released: 0 };
  for (const table of Object.values(OUTREACH_ROW_TABLE)) {
    if (!lettersSent) {
      const { data, error: releaseError } = await db
        .from(table)
        .update({ sender_uploaded_at: null })
        .eq('sender_campaign_id', campaignId)
        .select('id');
      if (releaseError) throw new SenderOpError(`Не удалось снять отметки заливки: ${releaseError.message}`, 500);
      result.rows += data?.length ?? 0;
      result.released += data?.length ?? 0;
      continue;
    }
    const { error: markError } = await db
      .from(table)
      .update({ sender_uploaded_at: new Date().toISOString() })
      .eq('sender_campaign_id', campaignId)
      .is('sender_uploaded_at', null);
    if (markError) throw new SenderOpError(`Не удалось сохранить отметки заливки: ${markError.message}`, 500);
    const { count: rows, error: countError } = await db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('sender_campaign_id', campaignId);
    if (countError) throw new SenderOpError(`Не удалось сосчитать компании рассылки: ${countError.message}`, 500);
    result.rows += rows ?? 0;
  }
  return result;
}

/** Почему запуск нельзя удалить — текст для оператора, как есть. */
export const UPLOADED_JOB_DELETE_MESSAGE =
  'Компании этого запуска уже залиты в Рассылку — запуск нельзя удалить, иначе следующий запуск напишет им повторно';

/**
 * Заливался ли запуск в «Рассылку»: есть строка с датой заливки или со ссылкой
 * на рассылку (то же, что «залита» у заливки). Такой запуск удалять нельзя:
 * вместе со строками пропадут и отметки заливки, и готовые строки, по которым
 * следующий запуск узнаёт, что компании уже писали, — и компания получит
 * вторую цепочку.
 *
 * Клиент — вызывающего роута, с правами пользователя: удалить он может только
 * свой запуск, и строки своего запуска видит все. Сбой запроса — исключение:
 * без ответа базы запуск не удаляем.
 */
export async function jobHasSenderUploads(client: SupabaseClient, lang: OutreachLang, jobId: string): Promise<boolean> {
  const table = OUTREACH_ROW_TABLE[lang];
  const [dated, linked] = await Promise.all([
    client.from(table).select('id').eq('job_id', jobId).not('sender_uploaded_at', 'is', null).limit(1),
    client.from(table).select('id').eq('job_id', jobId).not('sender_campaign_id', 'is', null).limit(1),
  ]);
  const error = dated.error ?? linked.error;
  if (error) throw new Error(`Не удалось проверить, заливался ли запуск в Рассылку: ${error.message}`);
  return Boolean(dated.data?.length || linked.data?.length);
}
