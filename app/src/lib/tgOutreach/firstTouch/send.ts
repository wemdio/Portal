/**
 * Отправка порции первых сообщений одним аккаунтом.
 *
 * Вызывается из круга кампании после разбора входящих: у аккаунта одно
 * подключение к Telegram, и отвечать на ответ обязан тот же аккаунт, который
 * написал первым.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramClient } from 'telegram';
import { validateFirstTouch, describeFailure, resolveMaxChars } from './validateMessage';
import { selectNextContacts, remainingDailyQuota, type PendingContact } from './selectContacts';
import * as fdb from './db';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface SendBatchArgs {
  db: SupabaseClient;
  client: TelegramClient;
  campaignId: string;
  account: { id: string; session_name: string; campaign_id: string };
  /** Дневная норма первых сообщений на аккаунт. Ноль = выключено. */
  perDay: number | undefined;
  log: LogFn;
  shouldStop?: () => boolean;
  onProgress?: () => void;
  /** Пауза между отправками внутри порции, мс. */
  gapMs?: number;
  /**
   * Порог длины первого сообщения из настроек кампании. Ноль или отсутствие =
   * дефолт из `validateMessage`.
   */
  maxChars?: number;
}

export interface SendBatchResult {
  sent: number;
  skipped: number;
  postponed: number;
}

/** Начало текущих суток по времени сервера — для дневной нормы. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Хвост строки лога про попытки.
 *
 * «Отложен» звучит как «вернёмся к нему позже», и это верно только первые два
 * раза: на третьей неудаче контакт уходит в failed и из очереди пропадает
 * навсегда. Разницу обязан называть лог, иначе база тихо тает.
 */
function attemptNote(outcome: { attempts: number; exhausted: boolean }): string {
  return outcome.exhausted
    ? ` (попытка ${outcome.attempts} из ${fdb.MAX_CONTACT_ATTEMPTS} — больше пробовать не буду, верните в очередь на вкладке «Базы»)`
    : ` (попытка ${outcome.attempts} из ${fdb.MAX_CONTACT_ATTEMPTS})`;
}

function isUsernameNotFound(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes('as username')
    || m.includes('username_not_occupied')
    || m.includes('username_invalid')
    || m.includes('no user has');
}

export async function sendFirstTouchBatch(args: SendBatchArgs): Promise<SendBatchResult> {
  const { db, client, campaignId, account, perDay, log } = args;
  const result: SendBatchResult = { sent: 0, skipped: 0, postponed: 0 };
  const maxChars = resolveMaxChars(args.maxChars);

  // Выходим до любого запроса в базу. У всех кампаний, заведённых до этой
  // фичи, поля нет вовсе, а круг идёт по каждому аккаунту каждые несколько
  // минут: проверка нормы после countSentToday означала бы постоянный поток
  // бессмысленных запросов от кампаний, которым первое касание не включали.
  if (!perDay || perDay <= 0) return result;

  const sentToday = await fdb.countSentToday(db, account.id, startOfToday());
  const quota = remainingDailyQuota({ perDay, sentToday });
  if (quota <= 0) return result;

  const baseIds = await fdb.loadCampaignBaseIds(db, campaignId);
  if (!baseIds.length) return result;

  // С запасом: часть контактов отсеется на дедупе и резолве, второй заход в БД
  // за добором дороже, чем лишние строки в выборке.
  const perBase = await fdb.loadPendingByBase(db, baseIds, quota * 2);
  const picked = selectNextContacts({ perBase, limit: quota });
  if (!picked.length) return result;

  for (const contact of picked) {
    if (args.shouldStop?.()) break;
    args.onProgress?.();

    const attempts = Number((contact as PendingContact & { attempts?: number }).attempts ?? 0);

    const check = validateFirstTouch(contact.message, maxChars);
    if (!check.ok) {
      const why = describeFailure(check.reason, maxChars);
      const outcome = await fdb.recordContactFailure(db, contact.id, attempts, why);
      log('warning', `Первое касание: @${contact.username} отложен — ${why}${attemptNote(outcome)}`);
      result.postponed++;
      continue;
    }

    let entity: { id: unknown; username?: string };
    try {
      entity = (await client.getEntity(`@${contact.username}`)) as { id: unknown; username?: string };
    } catch (err) {
      if (isUsernameNotFound(err)) {
        await fdb.markContactSkipped(db, contact.id, 'юзернейм не найден в Telegram');
        log('info', `Первое касание: @${contact.username} пропущен — юзернейм не найден`);
        result.skipped++;
      } else {
        // Раньше эта ветка молчала: причина уходила в skip_reason контакта, а в
        // логе оставалось только «отложено N» без единого слова почему. Показать
        // skip_reason на экране тоже негде — оператор не мог узнать причину
        // вообще никак.
        const msg = err instanceof Error ? err.message : String(err);
        const outcome = await fdb.recordContactFailure(db, contact.id, attempts, `не смог найти собеседника: ${msg}`);
        log('warning', `Первое касание: @${contact.username} отложен — не смог найти собеседника: ${msg}${attemptNote(outcome)}`);
        result.postponed++;
      }
      continue;
    }

    const tgUserId = Number(entity.id);

    // Единая точка «этому человеку уже писали» — общая для всех баз и кампаний.
    const { data: already } = await db
      .from('tg_outreach_processed')
      .select('tg_user_id')
      .eq('campaign_id', campaignId)
      .eq('tg_user_id', tgUserId)
      .maybeSingle();
    if (already) {
      await fdb.markContactSkipped(db, contact.id, 'этому человеку уже писали');
      result.skipped++;
      continue;
    }

    try {
      await client.sendMessage(`@${contact.username}`, { message: contact.message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const outcome = await fdb.recordContactFailure(db, contact.id, attempts, `не отправилось: ${msg}`);
      log('warning', `Первое касание: @${contact.username} не отправилось — ${msg}${attemptNote(outcome)}`);
      result.postponed++;
      continue;
    }

    const nowIso = new Date().toISOString();
    await db.from('tg_outreach_dialogs').insert({
      campaign_id: campaignId,
      account_id: account.id,
      tg_user_id: tgUserId,
      tg_username: contact.username,
      messages: [{ role: 'assistant', content: contact.message, timestamp: nowIso }],
      status: 'none',
      can_send: true,
      last_message_at: nowIso,
    });
    await db.from('tg_outreach_processed').upsert(
      { campaign_id: campaignId, tg_user_id: tgUserId, tg_username: contact.username },
      { onConflict: 'campaign_id,tg_user_id' },
    );
    await fdb.markContactSent(db, contact.id, account.id, tgUserId);

    log('info', `Первое касание: отправлено @${contact.username}`);
    result.sent++;

    if (args.gapMs && result.sent < picked.length) {
      await new Promise((r) => setTimeout(r, args.gapMs));
    }
  }

  return result;
}
