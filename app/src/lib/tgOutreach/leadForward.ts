/**
 * Исполнение ручной передачи лида или партнёра.
 *
 * Оператор жмёт кнопку в интерфейсе — задача ложится в
 * `tg_outreach_lead_forwards`. Отправить оттуда нельзя: живое соединение с
 * Telegram есть только у воркера, а второе подключение к той же сессии даёт
 * AUTH_KEY_DUPLICATED и выключенный аккаунт. Поэтому отправляет воркер
 * кампании тем же клиентом, что вёл переписку.
 *
 * До 02.09.2026 очередь разбирали по ходу круга: воркер доходил до аккаунта,
 * разбирал его входящие и только потом смотрел, нет ли для него передач.
 * Круг по 31 аккаунту с паузами 5–10 минут между ними идёт полтора-два часа,
 * а ночью ещё и стоит в «тихий час» — лид, поставленный вечером, уходил
 * утром, через 12 часов. Менеджер за это время успевал остыть, лид — тем
 * более.
 *
 * Теперь очередь опрашивает отдельный цикл (`runLeadForwardPoller`): все
 * аккаунты кампании подключены с самого старта и держат соединение весь
 * запуск, так что ждать «своего хода» в круге незачем. Задача уходит через
 * секунды после нажатия — в любую паузу круга и в «тихий час» тоже: адресат
 * здесь наш менеджер, а не лид, и ночная тишина его не касается.
 *
 * Порядок: сначала карточка по шаблону, следом нативная пересылка переписки.
 * Карточка отвечает на «кто это и откуда», пересылка даёт оригиналы сообщений,
 * на которые менеджер может ответить прямо из своего чата.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramClient } from 'telegram';
import { splitTelegramMessage } from './leadMessage';
import { forwardKindLabel, forwardWho } from './campaignLog';
import { withTimeout } from './withTimeout';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface PendingForward {
  id: string;
  kind: string;
  account_id: string;
  target_chat: string;
  message_text: string;
  dialog_id: string;
  /** Кто поставил задачу — чтобы журнал связывал нажатие и отправку. */
  requested_by_name: string | null;
  requested_at: string | null;
}

export interface ForwardDialogRef {
  tg_user_id: number | null;
  tg_username: string | null;
}

/** Сколько сообщений диалога тянем для нативной пересылки. */
const HISTORY_LIMIT = 200;

/**
 * Предел ожидания одного вызова Telegram.
 *
 * gramJS сам не таймаутит: мобильный прокси сменил IP — сокет «жив», запрос
 * ушёл в никуда. 01.09.2026 у аккаунта 256396681 так умерла отметка
 * «прочитано» (её таймаут сработал), а следом отправка карточки лида без
 * таймаута повисла на семь часов, пока сторожевой таймер не перезапустил
 * воркер. Задача при этом осталась `pending` и ушла утром.
 */
export const FORWARD_CALL_TIMEOUT_MS = 60_000;

/** Как часто опрашивать очередь. Секунды — то, чего ждёт нажавший кнопку. */
export const FORWARD_POLL_INTERVAL_MS = 10_000;

/**
 * Через сколько повторять задачу после сетевого сбоя и сколько раз.
 *
 * Мёртвый сокет чинит круг кампании, когда доберётся до аккаунта и
 * пересоздаст клиент; до тех пор дёргать его каждые 10 секунд — только
 * засорять журнал таймаутами по минуте каждый.
 */
export const FORWARD_RETRY_DELAY_MS = 5 * 60_000;
export const FORWARD_MAX_TRANSIENT_ATTEMPTS = 5;

function targetPeer(target: string): string {
  return target.startsWith('@') ? target.slice(1) : target;
}

/**
 * Сбой, после которого задачу стоит повторить, а не хоронить.
 *
 * Таймаут, порванный сокет, FLOOD_WAIT — всё это про состояние аккаунта в эту
 * минуту, а не про саму передачу. Отметить её «не отправлена» значит заставить
 * оператора ставить лида заново, хотя через пять минут ушло бы само.
 */
export function isTransientForwardError(message: string): boolean {
  return /нет ответа за|TIMEOUT|FLOOD_WAIT|ECONN|EHOSTUNREACH|EPIPE|socket|Not connected|disconnect/i.test(message);
}

/** Сколько раз задача уже срывалась по сети и когда её можно брать снова. */
interface RetryState {
  attempts: number;
  notBefore: number;
}

/**
 * Отправить одну задачу.
 *
 * Возвращает `sent` / `failed` / `retry`; статус в базе меняет сама, кроме
 * `retry` — там задача остаётся `pending`, чтобы её взял следующий опрос.
 */
export async function sendLeadForward(args: {
  db: SupabaseClient;
  client: TelegramClient;
  task: PendingForward;
  accountName: string;
  log: LogFn;
  timeoutMs?: number;
}): Promise<'sent' | 'failed' | 'retry'> {
  const { db, client, task, accountName, log } = args;
  const timeoutMs = args.timeoutMs ?? FORWARD_CALL_TIMEOUT_MS;
  const label = forwardKindLabel(task.kind);
  let who = 'диалог';
  try {
    const { data: dialogRow } = await db
      .from('tg_outreach_dialogs')
      .select('tg_user_id, tg_username')
      .eq('id', task.dialog_id)
      .maybeSingle();
    const dialog = dialogRow as ForwardDialogRef | null;
    if (!dialog) throw new Error('диалог удалён из портала');
    who = forwardWho(dialog.tg_username, dialog.tg_user_id);

    const peer = dialog.tg_username ? `@${dialog.tg_username}` : dialog.tg_user_id;
    if (!peer) throw new Error('у диалога нет ни юзернейма, ни числового id — некого пересылать');

    const target = targetPeer(task.target_chat);

    log('info', `Передача (${label}) ${who}: взял в работу, получатель ${task.target_chat}, поставил ${task.requested_by_name || '—'}`);

    // Карточка идёт первой: менеджер сначала понимает, что перед ним, и
    // только потом читает переписку.
    for (const part of splitTelegramMessage(task.message_text)) {
      await withTimeout(client.sendMessage(target, { message: part }), timeoutMs, 'отправка карточки');
    }

    // Пересылка — лучшее усилие. Карточка уже ушла и содержит переписку
    // текстом, поэтому сбой здесь не повод считать передачу несостоявшейся:
    // менеджер получил всё нужное.
    try {
      const entity = await withTimeout(client.getEntity(peer as string | number), timeoutMs, 'поиск собеседника');
      const history = await withTimeout(client.getMessages(entity, { limit: HISTORY_LIMIT }), timeoutMs, 'чтение переписки');
      const ids = history.map((m) => m.id).sort((a, b) => a - b);
      if (ids.length) {
        await withTimeout(client.forwardMessages(target, { fromPeer: entity, messages: ids }), timeoutMs, 'пересылка переписки');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('warning', `Передача (${label}) ${who}: карточка ушла, но оригиналы переписки переслать не удалось — ${msg}`);
    }

    await db
      .from('tg_outreach_lead_forwards')
      .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: null })
      .eq('id', task.id);

    log('info', `Передача (${label}) ${who}: отправлена в ${task.target_chat} аккаунтом ${accountName}`);
    return 'sent';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isTransientForwardError(msg)) {
      // Причину пишем в задачу, не меняя статуса: на карточке диалога видно,
      // почему «в очереди» затянулось, а сама задача никуда не делась.
      await db
        .from('tg_outreach_lead_forwards')
        .update({ error_message: `Повторю через ${Math.round(FORWARD_RETRY_DELAY_MS / 60_000)} мин: ${msg}`.slice(0, 500) })
        .eq('id', task.id);
      log('warning', `Передача (${label}) ${who}: не ушла в ${task.target_chat} аккаунтом ${accountName} — ${msg}. Осталась в очереди, повторю через ${Math.round(FORWARD_RETRY_DELAY_MS / 60_000)} мин.`);
      return 'retry';
    }
    await db
      .from('tg_outreach_lead_forwards')
      .update({ status: 'failed', error_message: msg.slice(0, 500) })
      .eq('id', task.id);
    // Причина целиком, без сокращений: по ней оператор и чинит — то ли
    // менеджер не принимает сообщения от незнакомого аккаунта, то ли чат
    // указан с опечаткой, то ли аккаунт под ограничением.
    log('error', `Передача (${label}) ${who}: НЕ отправлена в ${task.target_chat} аккаунтом ${accountName} — ${msg}`);
    return 'failed';
  }
}

/**
 * Один проход по очереди кампании: всё, что `pending` и чей аккаунт сейчас
 * подключён, — отправить.
 *
 * Ошибка одной задачи не мешает остальным: у каждой свой получатель и свой
 * собеседник. Аккаунт без живого клиента (не подключился на старте) задачу
 * не теряет — она дождётся переподключения; о ней предупреждаем один раз,
 * чтобы оператор знал, за чем встало.
 */
export async function processLeadForwards(args: {
  db: SupabaseClient;
  campaignId: string;
  getClient: (accountId: string) => { client: TelegramClient; accountName: string } | null;
  log: LogFn;
  shouldStop?: () => boolean;
  retries?: Map<string, RetryState>;
  warnedNoClient?: Set<string>;
  timeoutMs?: number;
  now?: () => number;
}): Promise<{ sent: number; failed: number; retried: number }> {
  const { db, campaignId, getClient, log } = args;
  const retries = args.retries ?? new Map<string, RetryState>();
  const warnedNoClient = args.warnedNoClient ?? new Set<string>();
  const now = args.now ?? Date.now;
  const result = { sent: 0, failed: 0, retried: 0 };

  const { data: rows, error } = await db
    .from('tg_outreach_lead_forwards')
    .select('id, kind, account_id, target_chat, message_text, dialog_id, requested_by_name, requested_at')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(20);
  if (error) throw new Error(error.message);

  const pending = (rows ?? []) as PendingForward[];
  if (!pending.length) return result;

  for (const task of pending) {
    if (args.shouldStop?.()) break;

    const retry = retries.get(task.id);
    if (retry && retry.notBefore > now()) continue;

    const holder = getClient(task.account_id);
    if (!holder) {
      if (!warnedNoClient.has(task.id)) {
        warnedNoClient.add(task.id);
        log('warning', `Передача (${forwardKindLabel(task.kind)}): аккаунт задачи не подключён — жду, пока он поднимется. Поставил ${task.requested_by_name || '—'}.`);
      }
      continue;
    }

    const outcome = await sendLeadForward({
      db,
      client: holder.client,
      task,
      accountName: holder.accountName,
      log,
      timeoutMs: args.timeoutMs,
    });

    if (outcome === 'retry') {
      const attempts = (retry?.attempts ?? 0) + 1;
      if (attempts >= FORWARD_MAX_TRANSIENT_ATTEMPTS) {
        // Пять раз по пять минут — аккаунт не оживает; дальше ждать молча
        // значит прятать проблему. Оператор увидит «не отправлена» и решит:
        // поставить заново или разобраться с аккаунтом.
        await db
          .from('tg_outreach_lead_forwards')
          .update({ status: 'failed', error_message: `Аккаунт ${holder.accountName} не отвечает: ${attempts} попыток подряд сорвались по сети` })
          .eq('id', task.id);
        log('error', `Передача (${forwardKindLabel(task.kind)}): НЕ отправлена — аккаунт ${holder.accountName} не отвечает ${attempts} попыток подряд. Проверьте прокси и аккаунт, затем поставьте передачу заново.`);
        retries.delete(task.id);
        result.failed++;
      } else {
        retries.set(task.id, { attempts, notBefore: now() + FORWARD_RETRY_DELAY_MS });
        result.retried++;
      }
      continue;
    }

    retries.delete(task.id);
    if (outcome === 'sent') result.sent++; else result.failed++;
  }

  return result;
}

/**
 * Опрос очереди на всё время работы кампании.
 *
 * Крутится рядом с кругом, а не внутри него: круг может часами спать в
 * паузах и в «тихий час», а нажавший кнопку ждёт секунды. Клиент берётся
 * через `getClient` в момент отправки — круг пересоздаёт клиенты на мёртвых
 * сокетах, и брать надо свежий, а не тот, что был на старте.
 *
 * Сбой самого опроса (например, недоступна база) цикл не роняет: пишем в
 * журнал и пробуем в следующий раз.
 */
export async function runLeadForwardPoller(args: {
  db: SupabaseClient;
  campaignId: string;
  getClient: (accountId: string) => { client: TelegramClient; accountName: string } | null;
  log: LogFn;
  shouldStop: () => boolean;
  intervalMs?: number;
}): Promise<void> {
  const intervalMs = args.intervalMs ?? FORWARD_POLL_INTERVAL_MS;
  const retries = new Map<string, RetryState>();
  const warnedNoClient = new Set<string>();

  while (!args.shouldStop()) {
    try {
      await processLeadForwards({ ...args, retries, warnedNoClient });
    } catch (err) {
      args.log('warning', `Очередь передач не отработала — ${err instanceof Error ? err.message : String(err)}. Повторю через ${Math.round(intervalMs / 1000)} с.`);
    }
    // Ждём кусками, чтобы остановка кампании не тянулась до конца паузы.
    const end = Date.now() + intervalMs;
    while (Date.now() < end && !args.shouldStop()) {
      await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
    }
  }
}
