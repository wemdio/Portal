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
  parkAccountAfterLimit,
  clearRestrictionAfterSend,
} from '../accountCooldown';
import { classifyRestriction, describeRestriction } from '../restriction';
import { withTimeout } from '../withTimeout';

/**
 * Сроки на вызовы Telegram в первом касании — та же причина, что в боевом
 * круге: gramJS не таймаутит сам, а мобильный прокси умеет молча увести запрос
 * в никуда. Повисший здесь `await` останавливал не только порцию, но и весь
 * круг кампании: до следующего аккаунта дело уже не доходило.
 */
const FT_RESOLVE_TIMEOUT_MS = Number(process.env.TG_OUTREACH_RESOLVE_TIMEOUT_MS) || 60_000;
const FT_SEND_TIMEOUT_MS = Number(process.env.TG_OUTREACH_SEND_TIMEOUT_MS) || 120_000;

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface SendBatchArgs {
  db: SupabaseClient;
  client: TelegramClient;
  campaignId: string;
  account: {
    id: string;
    session_name: string;
    campaign_id: string;
    cooldown_until?: string | null;
    /** Итог последней проверки. Нужен, чтобы снять «ограничен», когда письмо ушло. */
    check_status?: string | null;
    check_detail?: string | null;
  };
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
   * Сроки на вызовы Telegram. По умолчанию берутся из окружения; параметром
   * приходят только из тестов — иначе проверка «зависший запрос не вешает
   * порцию» ждала бы две реальные минуты.
   */
  resolveTimeoutMs?: number;
  sendTimeoutMs?: number;
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
 *
 * Срок паузы берёт `parkAccountAfterLimit`: он спрашивает @SpamBot прямо этим
 * же соединением. Раньше здесь стояла константа из настроек кампании, и после
 * неё аккаунт выходил ровно в тот же спам-блок — сутки за сутками.
 */
async function parkIfFlood(args: {
  db: SupabaseClient;
  client?: TelegramClient | null;
  account: { id: string; cooldown_until?: string | null; check_status?: string | null; check_detail?: string | null };
  hours: number | undefined;
  reason: string;
  /** Полный текст ошибки Telegram — по нему видно, временное это или навсегда. */
  rawError?: string;
  log: LogFn;
}): Promise<boolean> {
  if (!args.hours || args.hours <= 0 || !isFloodLimitReason(args.reason)) return false;
  const parked = await parkAccountAfterLimit({
    db: args.db,
    client: args.client,
    account: args.account,
    hours: args.hours,
    reason: args.reason,
    rawError: args.rawError,
    log: args.log,
  });
  if (!parked) return false;

  args.log(
    'warning',
    `Первое касание остановлено. ${parked.diagnosis} ` +
      `Аккаунт на паузе до ${cooldownLabel(parked.untilIso)}, следующий круг его не возьмёт. ` +
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

  /**
   * НАШ таймаут (`withTimeout`) — тоже транспорт, и это не противоречит решению
   * выше про голый TIMEOUT.
   *
   * Голый gramJS-TIMEOUT идёт постоянным фоном и сам по себе поломки не
   * означает. Наш — другое: это значит, что соединение молчало целую минуту, а
   * такое молчание всегда про связь, а не про контакт.
   *
   * Разница стоила 33 живых контактов. Таймауты появились в боевом пути
   * 28.08.2026, попали в общую ветку «неизвестный сбой» и начали тратить
   * попытки: за трое суток 178 отложений, 33 контакта выжгли все три попытки и
   * ушли в failed. Аккаунты на медленных прокси при этом не отправили ничего —
   * порция уходила в отложенные целиком, круг за кругом.
   *
   * Метку узнаём по формату `withTimeout`, а не по слову TIMEOUT: подстрока
   * достаточно своеобразная, чтобы не поймать чужое сообщение.
   */
  if (m.includes(': НЕТ ОТВЕТА ЗА ')) {
    return { kind: 'transport_down', reason: 'нет ответа от Telegram через прокси' };
  }

  return { kind: 'retryable' };
}

/**
 * Неоднозначный «юзернейм не найден».
 *
 * ВАЖНО: gramJS в `_getEntityFromUsername` (telegram/client/users.js) ловит RPC
 * `USERNAME_NOT_OCCUPIED` и маскирует его в строку `No user has "X" as username`
 * — то есть сырой код в `err.message` до сюда НЕ доезжает. А на урезанном/frozen
 * аккаунте Telegram отдаёт USERNAME_NOT_OCCUPIED и на ЖИВЫЕ ники (аудит 25.08.2026,
 * TG_VBI, аккаунт 254360278 — 273 живых контакта сожжено; 26.08 TG_Roistat — те же
 * «отправлено 0, пропущено N» на живых polydamas/savinovadi/spasisohrany).
 *
 * Поэтому и строка «No user has X as username», и сырой username_not_occupied —
 * ОДИН и тот же неоднозначный сигнал: мёртвый ник ИЛИ замороженный аккаунт.
 * Ни то, ни другое нельзя скипать сразу: буферизуем и решаем по итогу порции.
 * Дискриминатор один: мёртвый ник — явление одиночное, а замороженный аккаунт
 * отдаёт этот ответ на каждый резолв порции.
 */
function isUsernameNotFoundAmbiguous(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes('as username')
    || m.includes('no user has')
    || m.includes('username_not_occupied');
}

/**
 * Честно кривой ник — недопустимый формат (USERNAME_INVALID). Это НЕ заморозка:
 * такой ник не «оживёт», его можно скипнуть сразу. На первом касании почти
 * недостижим (normalizeUsername уже режет ник до [a-z0-9_]{5,32}), но если
 * доедет — скипаем, а не паркуем аккаунт.
 */
function isUsernameInvalid(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes('username_invalid');
}

export async function sendFirstTouchBatch(args: SendBatchArgs): Promise<SendBatchResult> {
  const { db, client, campaignId, account, perDay, log } = args;
  const result: SendBatchResult = { sent: 0, skipped: 0, postponed: 0 };
  const maxChars = resolveMaxChars(args.maxChars);
  const resolveTimeoutMs = args.resolveTimeoutMs ?? FT_RESOLVE_TIMEOUT_MS;
  const sendTimeoutMs = args.sendTimeoutMs ?? FT_SEND_TIMEOUT_MS;

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

  // RPC USERNAME_NOT_OCCUPIED неоднозначен: так Telegram отвечает и за мёртвый
  // ник, и за замороженный аккаунт (на живые ники). Решаем судьбу таких контактов
  // только по итогу порции — по одному сигналу ничего сказать нельзя.
  const notOccupied: Array<{ contact: PendingContact; attempts: number }> = [];

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
      entity = (await withTimeout(
        client.getEntity(`@${contact.username}`),
        resolveTimeoutMs,
        'поиск контакта по юзернейму',
      )) as { id: unknown; username?: string };
    } catch (err) {
      // Честно кривой ник (недопустимый формат, USERNAME_INVALID) — это не
      // заморозка, такой ник не «оживёт». Скипаем сразу.
      if (isUsernameInvalid(err)) {
        await fdb.markContactSkipped(db, contact.id, 'юзернейм не найден в Telegram');
        log('info', `Первое касание: @${contact.username} пропущен — юзернейм не найден`);
        result.skipped++;
        continue;
      }

      // «No user has X as username» / USERNAME_NOT_OCCUPIED — неоднозначен: тот же
      // ответ Telegram отдаёт и на живые ники, когда аккаунт урезан/frozen. Сжигать
      // контакт здесь нельзя; буферизуем и решаем по итогу порции.
      if (isUsernameNotFoundAmbiguous(err)) {
        notOccupied.push({ contact, attempts });
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
            client,
            account,
            hours: args.cooldownHours,
            reason: failure.reason,
            rawError: msg,
            log,
          });
        if (!parked) {
          // Пауза не настроена — но сказать, временное это или навсегда, всё
          // равно обязаны: иначе оператор читает «Telegram ограничил аккаунт»
          // и не знает, ждать ему или менять номер.
          const restriction = failure.kind === 'account_limited'
            ? classifyRestriction(msg, Date.now())
            : null;
          const cause = failure.kind === 'transport_down'
            ? `обрыв связи или прокси (${failure.reason})`
            : restriction
              ? describeRestriction(restriction)
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
      await withTimeout(
        client.sendMessage(`@${contact.username}`, { message: contact.message }),
        sendTimeoutMs,
        'отправка первого сообщения',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      /**
       * Наш таймаут на ОТПРАВКЕ — особый случай, и повторять её нельзя.
       *
       * Ответа мы не дождались, но это не значит, что сообщение не ушло:
       * запрос мог дойти до Telegram и быть доставленным, а потеряться могло
       * подтверждение. Повторная попытка в следующем круге отправит человеку
       * то же самое второй раз — а для холодного аутрича задвоенное сообщение
       * выглядит как работа бота и стоит дороже, чем один недописанный контакт
       * из трёхсот.
       *
       * Поэтому считаем контакт обработанным и оставляем след в журнале, чтобы
       * при разборе было видно: тут не отказ, тут неизвестность.
       *
       * Таймауты на ЧТЕНИИ (резолв ника, история) сюда не попадают — их
       * повторять безопасно, и они уходят в общую классификацию ниже.
       */
      if (msg.includes('отправка первого сообщения: нет ответа')) {
        await fdb.markContactSkipped(db, contact.id, 'отправка без подтверждения — возможно, доставлено');
        log(
          'warning',
          `Первое касание: @${contact.username} — Telegram не подтвердил отправку за ${Math.round(sendTimeoutMs / 1000)}с. `
          + 'Сообщение могло уйти, поэтому повторять не буду: задвоенное первое касание хуже пропущенного контакта. '
          + 'Проверьте диалог руками, если контакт важен.',
        );
        result.skipped++;
        continue;
      }

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
            client,
            account,
            hours: args.cooldownHours,
            reason: failure.reason,
            rawError: msg,
            log,
          });
        if (!parked) {
          // Пауза не настроена — но сказать, временное это или навсегда, всё
          // равно обязаны: иначе оператор читает «Telegram ограничил аккаунт»
          // и не знает, ждать ему или менять номер.
          const restriction = failure.kind === 'account_limited'
            ? classifyRestriction(msg, Date.now())
            : null;
          const cause = failure.kind === 'transport_down'
            ? `обрыв связи или прокси (${failure.reason})`
            : restriction
              ? describeRestriction(restriction)
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

  // Решаем судьбу буфера «юзернейм не найден» по итогу порции.
  //
  // Вся порция «не найдена» (два и более контакта) — сильный признак того, что
  // заморожен наш аккаунт, а не что база мёртвая: мёртвый ник — одиночное
  // явление, а урезанный аккаунт отдаёт этот ответ на каждый резолв. Паркуем
  // аккаунт (cooldown_until), контакты оставляем в очереди нетронутыми — они
  // дождутся исправного номера. Если сигнала нет — откладываем каждый контакт
  // с попыткой: живой он может быть, а сжигать его навсегда нельзя.
  if (notOccupied.length >= 2 && notOccupied.length === picked.length) {
    /**
     * Здесь @SpamBot отвечает не только на вопрос «до какого числа», но и на
     * сам диагноз: заморозку он подтверждает словами, а «ограничений нет»
     * означает, что аккаунт-то цел и порция ников действительно мёртвая.
     * Паркуем в обоих случаях (сжигать базу дороже), но в журнале это теперь
     * две разные строки, а не одна догадка.
     */
    const parked = await parkAccountAfterLimit({
      db,
      client,
      account,
      hours: args.cooldownHours ?? 24,
      reason: 'USERNAME_NOT_OCCUPIED на всей порции',
      log,
    });
    if (parked) {
      log(
        'warning',
        `Первое касание остановлено: весь резолв порции вернул «юзернейм не найден» — ` +
          `Telegram, похоже, заморозил аккаунт, а не срезал ники. ${parked.diagnosis} ` +
          `Аккаунт на паузе до ${cooldownLabel(parked.untilIso)}, ` +
          `контакты остаются в очереди, попытки им не засчитываем.`,
      );
    }
    result.postponed += notOccupied.length;
  } else {
    for (const { contact, attempts } of notOccupied) {
      const outcome = await fdb.recordContactFailure(
        db,
        contact.id,
        attempts,
        'юзернейм не резолвился (возможно, заморожен аккаунт)',
      );
      log('warning', `Первое касание: @${contact.username} отложен — юзернейм не резолвился${attemptNote(outcome)}`);
      result.postponed++;
    }
  }

  // Ушедшее письмо незнакомому человеку — единственное доказательство, что
  // спам-блок снят: в профиле он не виден, и «отпустило» Telegram не сообщает.
  if (result.sent > 0) {
    await clearRestrictionAfterSend(db, account);
  }

  return result;
}
