import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { EDITABLE_CAMPAIGN_STATUSES, SenderOpError, startCampaign } from './campaignOps';
import { fillPoolFromFolder } from './folders';
import { ensureCampaignStopListChecked } from './stopLists';
import { SCHEDULED_START_CLAIM_MARK } from './types';
import { readVe2SendingSwitch, VE2_SENDING_STOPPED_CODE } from './ve2SendingSwitch';

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
/** Отметка «запускается» старше этого — воркер прервался посреди запуска. */
const STALE_CLAIM_MS = 10 * 60_000;

export async function runScheduledStarts(opts: { log: Log }): Promise<number> {
  const db = supabaseAdmin;
  if (!db) return 0;
  // Прерванный запуск (воркер упал или база не дала вернуть время) — снова в
  // очередь: сам запуск повторяем безопасно, кампания всё ещё черновик или на паузе.
  // Отправку кампаний Движка остановил администратор (или выключатель не
  // прочитался) — их запуски не трогаем совсем: снятое время потерялось бы.
  const ve2Switch = await readVe2SendingSwitch(db);
  const skipVe2 = ve2Switch.state !== 'enabled';
  const nowIso = new Date().toISOString();
  let rearm = db
    .from('sender_campaigns')
    .update({ scheduled_start_at: nowIso, scheduled_start_error: 'Запуск прервался — повторяем', updated_at: nowIso })
    .eq('scheduled_start_error', SCHEDULED_START_CLAIM_MARK)
    .is('scheduled_start_at', null)
    .in('status', EDITABLE_CAMPAIGN_STATUSES)
    .lt('updated_at', new Date(Date.now() - STALE_CLAIM_MS).toISOString());
  if (skipVe2) rearm = rearm.neq('source_kind', 've2');
  const { error: rearmError } = await rearm;
  if (rearmError) opts.log('warn', `Прерванные отложенные запуски не возвращены: ${rearmError.message}`);

  // С запасом: ждущие сверки стоп-листов остаются в выборке и не должны
  // заслонять остальные.
  let due = db
    .from('sender_campaigns')
    .select('id, name, scheduled_start_at')
    .lte('scheduled_start_at', new Date().toISOString())
    .in('status', EDITABLE_CAMPAIGN_STATUSES);
  if (skipVe2) due = due.neq('source_kind', 've2');
  const { data, error } = await due.order('scheduled_start_at').limit(200);
  if (error) throw new Error(error.message);

  let started = 0;
  for (const row of data ?? []) {
    const id = String(row.id);
    // Стоп-листы клиента и проекта ещё не сверены свежо (почтовый хост базы
    // Instantly не видит, сверяет воркер sender-leads) — ждём, не снимая
    // время: отмена или перенос оператором в это время ничем не затрутся.
    try {
      await ensureCampaignStopListChecked(db, null, id);
    } catch (e) {
      const reason = `Стоп-листы клиента и проекта не сверены — ${e instanceof Error ? e.message : String(e)}`;
      await db
        .from('sender_campaigns')
        .update({ scheduled_start_error: reason.slice(0, 500) })
        .eq('id', id)
        .eq('scheduled_start_at', row.scheduled_start_at as string);
      continue;
    }
    const { data: claimed, error: claimError } = await db
      .from('sender_campaigns')
      .update({ scheduled_start_at: null, scheduled_start_error: SCHEDULED_START_CLAIM_MARK, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('scheduled_start_at', row.scheduled_start_at as string)
      .select('id');
    if (claimError) throw new Error(claimError.message);
    if (!claimed?.length) continue;

    try {
      await fillPoolFromFolder(id);
      await startCampaign(id, { scheduledClaim: true });
      started += 1;
      opts.log('info', `Отложенный запуск: кампания «${row.name}» запущена`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      opts.log('warn', `Отложенный запуск кампании «${row.name}» не удался: ${message}`);
      // Сбой базы — не повод навсегда отменять запуск: возвращаем время, следующий тик попробует снова.
      // Отправку кампаний Движка остановили посреди тика — время вернуть, а не терять.
      const stopped = e instanceof SenderOpError && e.code === VE2_SENDING_STOPPED_CODE;
      const retry = !(e instanceof SenderOpError) || e.status >= 500 || stopped;
      // Всё ниже — только пока на кампании наша отметка: отмена и перенос
      // оператором в это время её стёрли, и их решение не затирается.
      // 409 — кампанию тем временем запустили или завершили руками: снимаем отметку.
      const update = e instanceof SenderOpError && e.status === 409 && !stopped
        ? { scheduled_start_error: null }
        : retry
          ? { scheduled_start_at: row.scheduled_start_at as string, scheduled_start_error: message.slice(0, 500) }
          : { scheduled_start_error: message.slice(0, 500), updated_at: new Date().toISOString() };
      const { error: afterError } = await db
        .from('sender_campaigns')
        .update(update)
        .eq('id', id)
        .eq('scheduled_start_error', SCHEDULED_START_CLAIM_MARK);
      // Не записалось — отметка останется, и через 10 минут запуск вернётся в очередь сам.
      if (afterError) opts.log('warn', `Отложенный запуск кампании «${row.name}»: итог не записан — ${afterError.message}`);
    }
  }
  return started;
}
