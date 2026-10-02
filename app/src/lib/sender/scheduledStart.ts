import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { EDITABLE_CAMPAIGN_STATUSES, SenderOpError, startCampaign } from './campaignOps';
import { fillPoolFromFolder } from './folders';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

/**
 * Отложенные запуски кампаний (02.10.2026): кампании, чьё время запуска
 * наступило, запускаются тем же путём, что кнопка «Запустить» (сначала ящики
 * из папки, потом startCampaign). Зовёт ведущий воркер «Рассылки» каждый тик,
 * до планировщика — тот в тот же проход разложит письма по окну отправки.
 *
 * Время сначала снимается условным обновлением (по тому же значению): из двух
 * воркеров или воркера и кнопки кампанию запускает один. Не запустилась —
 * время уже снято, причина пишется в scheduled_start_error: кампания не
 * пытается стартовать каждые 15 секунд, а оператор видит, почему.
 */
export async function runScheduledStarts(opts: { log: Log }): Promise<number> {
  const db = supabaseAdmin;
  if (!db) return 0;
  const { data, error } = await db
    .from('sender_campaigns')
    .select('id, name, scheduled_start_at')
    .lte('scheduled_start_at', new Date().toISOString())
    .in('status', EDITABLE_CAMPAIGN_STATUSES)
    .limit(20);
  if (error) throw new Error(error.message);

  let started = 0;
  for (const row of data ?? []) {
    const id = String(row.id);
    const { data: claimed, error: claimError } = await db
      .from('sender_campaigns')
      .update({ scheduled_start_at: null })
      .eq('id', id)
      .eq('scheduled_start_at', row.scheduled_start_at as string)
      .select('id');
    if (claimError) throw new Error(claimError.message);
    if (!claimed?.length) continue;

    try {
      await fillPoolFromFolder(id);
      await startCampaign(id);
      started += 1;
      opts.log('info', `Отложенный запуск: кампания «${row.name}» запущена`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      opts.log('warn', `Отложенный запуск кампании «${row.name}» не удался: ${message}`);
      // Сбой базы — не повод навсегда отменять запуск: возвращаем время, следующий тик попробует снова.
      const retry = !(e instanceof SenderOpError) || e.status >= 500;
      // 409 — кампанию тем временем запустили или завершили руками: писать нечего.
      if (e instanceof SenderOpError && e.status === 409) continue;
      await db
        .from('sender_campaigns')
        .update(retry
          ? { scheduled_start_at: row.scheduled_start_at as string }
          : { scheduled_start_error: message.slice(0, 500), updated_at: new Date().toISOString() })
        .eq('id', id);
    }
  }
  return started;
}
