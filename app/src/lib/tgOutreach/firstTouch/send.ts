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
import {
  isFloodLimitReason,
  cooldownUntilIso,
  writeAccountCooldown,
} from '../accountCooldown';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface SendBatchArgs {
  db: SupabaseClient;
  client: TelegramClient;
  campaignId: string;
  account: { id: string; session_name: string; campaign_id: string; cooldown_until?: string | null };
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
  /**
   * «Пауза после ограничения» кампании. Ноль или отсутствие — паузу не ставим
   * (как было до 24.08: PEER_FLOOD только останавливал порцию).
   */
  cooldownHours?: number;
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

function cooldownLabel(untilIso: string): string {
  return new Date(untilIso).toLocaleString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}

/**
 * PEER_FLOOD / FLOOD_WAIT — виноват наш аккаунт. Без cooldown_until следующий
 * круг снова берёт тот же номер. Контакт не трогаем.
 */
async function parkIfFlood(args: {
  db: SupabaseClient;
  account: { id: string; cooldown_until?: string | null };
  hours: number | undefined;
  reason: string;
  log: LogFn;
}): Promise<boolean> {
  if (!args.hours || args.hours <= 0 || !isFloodLimitReason(args.reason)) return false;
  const until = cooldownUntilIso(args.hours);
  const err = await writeAccountCooldown(args.db, args.account.id, until);
  if (err) {
    args.log('error', `Не смог сохранить паузу аккаунта в базе — ${err}`);
    return false;
  }
  args.account.cooldown_until = until;
  args.log(
    'warning',
    `Первое касание остановлено: Telegram ограничил аккаунт (${args.reason}). ` +
      `Аккаунт на паузе до ${cooldownLabel(until)} (${args.hours}ч), следующий круг его не возьмёт. ` +
      `Контакты остаются в очереди, попытки им не засчитываем.`,
  );
  return true;
}

/**
 * Три разных исхода неудачной отправки, которые раньше сваливались в один.
 *
 * Прод 18.08.2026: 548 попыток отправки пришлись на 18 человек — по 30 заходов
 * на одного. Одна причина в том, что счётчик попыток не доезжал из базы
 * (см. loadPendingByBase), вторая — вот здесь: PRIVACY_PREMIUM_REQUIRED вообще
 * не должен тратить попытки. Это настройка приватности получателя («писать
 * могут только Premium-аккаунты»), она не рассосётся ни на второй попытке, ни
 * на тридцатой; единственный способ пробиться — Premium на нашем аккаунте.
 *
 * Отдельно PEER_FLOOD и FLOOD_WAIT: там ограничили НАШ аккаунт, а контакт ни
 * при чём. Списывать за это попытку с живого лида нельзя — как только счётчик
 * починился, такие ограничения начали бы выжигать исправную базу. И продолжать
 * порцию тоже нельзя: PEER_FLOOD выдают ровно за долбёжку по незнакомым, так
 * что следующая отправка только усугубит. Останавливаем порцию до следующего
 * круга — так же, как LinkedIn-раннер паркует аккаунт при cooldown.
 */
type SendFailure =
  | { kind: 'contact_permanent'; reason: string }
  | { kind: 'account_limited'; reason: string }
  // Обрыв прокси/сокета — НЕ ограничение аккаунта. Поведение то же (попытку не
  // тратим, порцию прекращаем), но kind разведён, чтобы лог не врал оператору
  // «Telegram ограничил аккаунт» там, где просто умерло соединение (аудит 20.08).
  | { kind: 'transport_down'; reason: string }
  | { kind: 'retryable' };

function classifySendFailure(errMsg: string): SendFailure {
  const m = errMsg.toUpperCase();

  const permanent: Array<[string, string]> = [
    ['PRIVACY_PREMIUM_REQUIRED', 'принимает сообщения только от Premium-аккаунтов'],
    ['USER_PRIVACY_RESTRICTED', 'закрыл личные сообщения настройками приватности'],
    ['USER_IS_BLOCKED', 'заблокировал наш аккаунт'],
    ['INPUT_USER_DEACTIVATED', 'удалил аккаунт в Telegram'],
    ['USER_BANNED_IN_CHANNEL', 'аккаунт забанен в Telegram'],
    ['PEER_ID_INVALID', 'контакт не существует в Telegram'],
  ];
  for (const [code, reason] of permanent) {
    if (m.includes(code)) return { kind: 'contact_permanent', reason };
  }

  // Ограничили НАШ аккаунт. Контакт ни при чём — попытку ему не засчитываем.
  //
  // PEER_FLOOD приезжает обычным RPCError, и код лежит в message как есть
  // (в проде 737 таких строк за 30 дней). А вот FLOOD_WAIT и SLOWMODE_WAIT
  // gramJS отдаёт типизированными ошибками, и они переписывают message на
  // человеческий текст: `A wait of N seconds is required (caused by …)` —
  // самого кода в строке НЕТ (node_modules/telegram/errors/RPCErrorList.js:41).
  // Поэтому проверка по коду для них мертва, и нужен матч по тексту: за 30 дней
  // ни одна строка лога не содержала «FLOOD_WAIT», хотя ограничения были.
  // Без этого с починенным счётчиком любой флуд-вейт сжигал бы попытку живому
  // контакту — ровно то, от чего эта классификация и должна защищать.
  if (/A WAIT OF \d+ SECONDS IS REQUIRED/.test(m)) {
    return { kind: 'account_limited', reason: 'FLOOD_WAIT' };
  }
  for (const code of ['PEER_FLOOD', 'FLOOD_WAIT', 'SLOWMODE_WAIT']) {
    if (m.includes(code)) return { kind: 'account_limited', reason: code };
  }

  // Аккаунт мёртв или разлогинен: забанен, сессия отозвана, ключ не зарегистрирован.
  // Это тоже про нас, а не про контакт, и это худший случай — такая ошибка
  // повторится на КАЖДОМ контакте порции. Без этой ветки они все считались бы
  // retryable, и один забаненный аккаунт за три круга укатал бы всю очередь
  // (2803 pending на 18.08.2026) в failed.
  //
  // Порядок важен: `permanent` выше проверяется первым, потому что
  // INPUT_USER_DEACTIVATED (получатель удалил аккаунт) содержит подстроку
  // USER_DEACTIVATED и иначе читался бы как смерть нашего аккаунта.
  for (const code of [
    'AUTH_KEY_UNREGISTERED',
    'AUTH_KEY_DUPLICATED',
    'SESSION_REVOKED',
    'SESSION_EXPIRED',
    'USER_DEACTIVATED_BAN',
    'USER_DEACTIVATED',
  ]) {
    if (m.includes(code)) return { kind: 'account_limited', reason: code };
  }

  // Транспорт: оборвался прокси или сокет. Контакт тут вообще ни при чём, и
  // такая ошибка приходит сразу на всю порцию, а не на одного человека.
  //
  // Пока счётчик попыток не работал, это было безобидно. Теперь — нет: одна
  // просадка прокси списывала бы попытку каждому контакту порции, а три
  // просадки за трое суток увели бы в failed живую базу целиком. У нас 43%
  // кругов и так проходят с мёртвым сокетом, так что это не гипотеза.
  // Список намеренно узкий — только однозначные сокетные ошибки и явное
  // «соединения нет». Голый TIMEOUT сюда НЕ входит: тест silentDecisions
  // фиксирует продуктовое решение, что таймаут резолва попытку тратит, и
  // переписывать его в рамках этой правки неправильно. К тому же в gramJS
  // TIMEOUT идёт постоянным фоном и сам по себе поломки не означает.
  for (const code of [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
    'ENOTFOUND', 'EPIPE', 'SOCKET HANG UP', 'NOT CONNECTED', 'WHILE DISCONNECTED',
  ]) {
    if (m.includes(code)) return { kind: 'transport_down', reason: code };
  }

  return { kind: 'retryable' };
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
        continue;
      }

      // Резолв юзернейма — такой же поход в Telegram, как и отправка, и падает
      // он на тех же ограничениях. Раньше классификация висела только на
      // sendMessage, поэтому флуд-вейт или бан аккаунта, случившиеся на
      // getEntity, списывали попытку живому контакту и порция продолжала
      // ломиться в API. Разбираем ошибку тем же классификатором.
      const msg = err instanceof Error ? err.message : String(err);
      const failure = classifySendFailure(msg);

      if (failure.kind === 'contact_permanent') {
        await fdb.markContactSkipped(db, contact.id, failure.reason);
        log('warning', `Первое касание: @${contact.username} пропущен — ${failure.reason}. Больше не пробуем.`);
        result.skipped++;
        continue;
      }

      if (failure.kind === 'account_limited' || failure.kind === 'transport_down') {
        const parked = failure.kind === 'account_limited'
          && await parkIfFlood({
            db,
            account,
            hours: args.cooldownHours,
            reason: failure.reason,
            log,
          });
        if (!parked) {
          const cause = failure.kind === 'transport_down'
            ? `обрыв связи или прокси (${failure.reason})`
            : `Telegram ограничил аккаунт (${failure.reason})`;
          log(
            'warning',
            `Первое касание остановлено на резолве юзернейма: ${cause}. ` +
              `Контакты остаются в очереди, попытки им не засчитываем — продолжим следующим кругом.`,
          );
        }
        result.postponed++;
        break;
      }

      // Раньше эта ветка молчала: причина уходила в skip_reason контакта, а в
      // логе оставалось только «отложено N» без единого слова почему. Показать
      // skip_reason на экране тоже негде — оператор не мог узнать причину
      // вообще никак.
      const outcome = await fdb.recordContactFailure(db, contact.id, attempts, `не смог найти собеседника: ${msg}`);
      log('warning', `Первое касание: @${contact.username} отложен — не смог найти собеседника: ${msg}${attemptNote(outcome)}`);
      result.postponed++;
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
      const failure = classifySendFailure(msg);

      if (failure.kind === 'contact_permanent') {
        await fdb.markContactSkipped(db, contact.id, failure.reason);
        log('warning', `Первое касание: @${contact.username} пропущен — ${failure.reason}. Больше не пробуем.`);
        result.skipped++;
        continue;
      }

      if (failure.kind === 'account_limited' || failure.kind === 'transport_down') {
        const parked = failure.kind === 'account_limited'
          && await parkIfFlood({
            db,
            account,
            hours: args.cooldownHours,
            reason: failure.reason,
            log,
          });
        if (!parked) {
          const cause = failure.kind === 'transport_down'
            ? `обрыв связи или прокси (${failure.reason})`
            : `Telegram ограничил аккаунт (${failure.reason})`;
          log(
            'warning',
            `Первое касание остановлено: ${cause}. ` +
              `Контакты остаются в очереди, попытки им не засчитываем — продолжим следующим кругом.`,
          );
        }
        result.postponed++;
        break;
      }

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
