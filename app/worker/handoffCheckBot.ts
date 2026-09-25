/**
 * Проверка карточки AMO при передаче проекта: читает ветку «Передача проектов»
 * группы «Продажи Polza» и отвечает реплаем, только если карточка сделки
 * недозаполнена (или в сообщении нет ссылки на AMO). Всё в порядке — молчит.
 * Раз в день в 10:00 МСК перепроверяет открытые проблемы.
 *
 * Спека: docs/superpowers/specs/2026-09-25-handoff-card-check-design.md.
 * Решения «что ответить» — чистые функции `@/lib/handoffCheck/decide`; здесь
 * только Telegram, AMO и таблица `handoff_card_checks`.
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
  setupGracefulShutdown,
  sleep,
  type WorkerLogger,
} from './_shared';
import {
  getChatMember,
  getMe,
  getUpdates,
  getWebhookInfo,
  sendMessage,
  type TelegramMessage,
  type TelegramUpdate,
} from '@/lib/tgBot/telegramClient';
import { sendWorkerAlert } from '@/lib/telegram/workerAlert';
import { parseHandoff } from '@/lib/handoffCheck/parseHandoff';
import { checkCard } from '@/lib/handoffCheck/checkCard';
import { fetchCard } from '@/lib/handoffCheck/amoApi';
import { noLinkReply, problemsReply, reminderReply, resolvedReply } from '@/lib/handoffCheck/formatReply';
import {
  earliestCheckAt,
  getCheck,
  listOpen,
  upsertCheck,
  type HandoffCheckRow,
  type HandoffCheckUpsert,
} from '@/lib/handoffCheck/store';
import {
  REPLY_PENDING,
  chatVisibleProblems,
  decide,
  isDailyPassDue,
  isExpired,
  moscowDateKey,
  todayDailyPassStart,
  type CheckOutcome,
  type Decision,
  type PrevState,
  type ReplyKind,
} from '@/lib/handoffCheck/decide';

const WORKER_ID = 'handoff-check-bot';

function numberEnv(name: string, fallback: number): number {
  const value = Number((process.env[name] ?? '').trim());
  return Number.isFinite(value) && value !== 0 ? value : fallback;
}

const TOKEN = (process.env.HANDOFF_BOT_TOKEN ?? '').trim();
const CHAT_ID = numberEnv('HANDOFF_CHAT_ID', -1001852890744);
const THREAD_ID = numberEnv('HANDOFF_THREAD_ID', 3781);
const PIPELINE_ID = numberEnv('FIRST_SALES_PIPELINE_ID', 7670334);

const HOUR_MS = 60 * 60 * 1000;
const CONFLICT_PAUSE_MS = 5 * 60 * 1000;
const ERROR_PAUSE_MS = 10_000;

type Db = ReturnType<typeof requireSupabaseAdmin>;

interface Ctx {
  db: Db;
  log: WorkerLogger;
  shouldStop: () => boolean;
  alerts: AlertOnce;
  /** Момент первого запуска бота: более ранние сообщения не проверяем (спека §10). */
  launchedAtMs: number;
}

/** Алерт в health-чат один раз на состояние, пока оно не прошло. */
class AlertOnce {
  private readonly active = new Set<string>();

  constructor(private readonly log: WorkerLogger) {}

  async raise(key: string, subject: string, error: unknown): Promise<void> {
    this.log('warn', subject, error);
    if (this.active.has(key)) return;
    this.active.add(key);
    await sendWorkerAlert({ workerId: WORKER_ID, subject, error });
  }

  clear(key: string): void {
    this.active.delete(key);
  }
}

/** Сон, который прерывается остановкой контейнера. */
async function pause(ms: number, shouldStop: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (!shouldStop() && Date.now() < end) {
    await sleep(Math.min(1_000, end - Date.now()));
  }
}

// ── AMO ──────────────────────────────────────────────────────────────────────

async function evaluate(
  ctx: Ctx,
  amoId: number | null,
  stated: { amount: number | null; source: string | null },
): Promise<CheckOutcome> {
  if (amoId == null) return { kind: 'no_link' };
  try {
    const card = await fetchCard(ctx.db, amoId);
    return { kind: 'checked', problems: checkCard(card, stated, PIPELINE_ID) };
  } catch (error) {
    // Любой сбой чтения — не «сделка не найдена»: строка ждёт перепроверки,
    // в чат ничего не уходит.
    ctx.log('warn', `AMO read failed for lead ${amoId}`, error);
    return { kind: 'amo_unavailable' };
  }
}

// ── Telegram ────────────────────────────────────────────────────────────────

function replyText(kind: ReplyKind, decision: Decision, amoUrl: string): string {
  const problems = chatVisibleProblems(decision.problems);
  if (kind === 'no_link') return noLinkReply();
  if (kind === 'resolved') return resolvedReply();
  if (kind === 'reminder') return reminderReply(problems, amoUrl);
  return problemsReply(problems, amoUrl);
}

/** Реплай на сообщение о передаче; null — не отправилось. */
async function sendReply(ctx: Ctx, messageId: number, text: string): Promise<number | null> {
  try {
    const sent = await sendMessage(TOKEN, {
      chatId: CHAT_ID,
      text,
      messageThreadId: THREAD_ID,
      replyToMessageId: messageId,
      disableWebPagePreview: true,
    });
    ctx.alerts.clear('send-failed');
    return sent.message_id;
  } catch (error) {
    await ctx.alerts.raise('send-failed', `не удалось ответить в ветку (сообщение ${messageId})`, error);
    return null;
  }
}

function amoUrlFor(amoUrl: string | null, amoId: number | null): string {
  if (amoUrl) return amoUrl;
  const base = (process.env.AMO_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const origin = base.startsWith('http') ? base : `https://${base}`;
  return `${origin}/leads/detail/${amoId ?? ''}`;
}

function authorOf(message: TelegramMessage): string | null {
  const from = message.from;
  if (!from) return null;
  return from.username ? `@${from.username}` : (from.first_name ?? String(from.id));
}

// ── Применение решения ───────────────────────────────────────────────────────

function isWarning(reply: ReplyKind | null): boolean {
  return reply === 'problems' || reply === 'no_link';
}

/** Строка с итогом решения — пишется ДО отправки ответа. */
function claimedRow(prev: PrevState | null, decision: Decision, fields: HandoffCheckUpsert, nowIso: string): HandoffCheckUpsert {
  const replyMessageId =
    decision.replyMessageId === 'new'
      ? REPLY_PENDING
      : decision.replyMessageId === 'clear'
        ? null
        : (prev?.reply_message_id ?? null);
  return {
    ...fields,
    status: decision.status,
    problems: decision.problems,
    reply_message_id: replyMessageId,
    warned_at: prev?.warned_at ?? (isWarning(decision.reply) ? nowIso : null),
    reminded_at: decision.markReminded ? nowIso : (prev?.reminded_at ?? null),
    resolved_at: decision.markResolved ? nowIso : (prev?.resolved_at ?? null),
    last_checked_at: nowIso,
  };
}

/** Ответ не ушёл — откатываем то, что было записано в расчёте на него. */
function revertAfterFailedSend(prev: PrevState | null, decision: Decision): Partial<HandoffCheckUpsert> {
  if (decision.reply === 'reminder') return { reminded_at: prev?.reminded_at ?? null };
  if (decision.reply === 'resolved' && prev) {
    // Предупреждение остаётся в чате — ежедневный проход попробует снова.
    return {
      status: prev.status,
      problems: prev.problems,
      reply_message_id: prev.reply_message_id,
      resolved_at: prev.resolved_at,
    };
  }
  // Предупреждения в чате нет — ежедневный проход (или правка) отправит его заново.
  return { reply_message_id: null, warned_at: prev?.warned_at ?? null };
}

async function applyDecision(
  ctx: Ctx,
  prev: PrevState | null,
  decision: Decision,
  target: { messageId: number; amoUrl: string },
  fields: HandoffCheckUpsert,
): Promise<void> {
  const nowIso = new Date().toISOString();
  // Сначала запись, потом ответ: если процесс упадёт между ними, повтор
  // обновления увидит «ответ уже отправляется» и не ответит второй раз.
  await upsertCheck(ctx.db, claimedRow(prev, decision, fields, nowIso));
  if (!decision.reply) return;

  const sentId = await sendReply(ctx, target.messageId, replyText(decision.reply, decision, target.amoUrl));
  ctx.log('info', `message ${target.messageId}: ${decision.reply} reply ${sentId != null ? 'sent' : 'FAILED'}`);

  const key = { chat_id: fields.chat_id, message_id: fields.message_id, status: decision.status };
  if (sentId == null) {
    await upsertCheck(ctx.db, { ...key, ...revertAfterFailedSend(prev, decision) });
  } else if (decision.replyMessageId === 'new') {
    await upsertCheck(ctx.db, { ...key, reply_message_id: sentId });
  }
}

// ── Новые и исправленные сообщения ──────────────────────────────────────────

function isWatchedMessage(message: TelegramMessage): boolean {
  return message.chat.id === CHAT_ID && message.message_thread_id === THREAD_ID;
}

/** Отправлено до первого запуска бота — задним числом не проверяем (правки тоже: `date` у правки — исходная). */
function isBeforeLaunch(ctx: Ctx, message: TelegramMessage): boolean {
  return message.date != null && message.date * 1000 < ctx.launchedAtMs;
}

export async function handleUpdate(ctx: Ctx, update: TelegramUpdate): Promise<void> {
  const message = update.message ?? update.edited_message;
  if (!message || !isWatchedMessage(message)) return;
  const text = message.text ?? message.caption;
  if (!text) return;

  const parsed = parseHandoff(text);
  if (!parsed.isHandoff) return;

  const prev = await getCheck(ctx.db, CHAT_ID, message.message_id);
  // Уже проверявшиеся сообщения продолжаем вести, даже если отправлены
  // чуть раньше первой записи в таблице.
  if (!prev && isBeforeLaunch(ctx, message)) return;

  const outcome = await evaluate(ctx, parsed.amoId, { amount: parsed.statedAmount, source: parsed.statedSource });
  const decision = decide(prev, outcome, 'message', new Date());
  await applyDecision(
    ctx,
    prev,
    decision,
    { messageId: message.message_id, amoUrl: amoUrlFor(parsed.amoUrl, parsed.amoId) },
    {
      chat_id: CHAT_ID,
      message_id: message.message_id,
      thread_id: THREAD_ID,
      amo_id: parsed.amoId,
      message_text: text,
      author: authorOf(message),
      stated_amount: parsed.statedAmount,
      stated_source: parsed.statedSource,
      status: decision.status,
    },
  );
}

// ── Ежедневная перепроверка ─────────────────────────────────────────────────

async function recheckRow(ctx: Ctx, row: HandoffCheckRow, now: Date): Promise<void> {
  const key = { chat_id: row.chat_id, message_id: row.message_id };
  if (isExpired(row, now)) {
    await upsertCheck(ctx.db, { ...key, status: 'expired', last_checked_at: now.toISOString() });
    return;
  }
  // Нет ссылки — ждём правку сообщения, AMO проверять нечего. (Строка
  // `no_link` со ссылкой — правка добавила ссылку, но «✅» не ушёл: проверяем.)
  if (row.amo_id == null) return;

  const stated = {
    amount: row.stated_amount == null ? null : Number(row.stated_amount),
    source: row.stated_source,
  };
  const outcome = await evaluate(ctx, row.amo_id, stated);
  const decision = decide(row, outcome, 'daily', now);
  const amoUrl = amoUrlFor(row.message_text ? parseHandoff(row.message_text).amoUrl : null, row.amo_id);
  await applyDecision(ctx, row, decision, { messageId: row.message_id, amoUrl }, { ...key, status: decision.status });
}

/** Возвращает число строк, которые не удалось перепроверить. */
async function runDailyPass(ctx: Ctx, now: Date): Promise<number> {
  const rows = await listOpen(ctx.db);
  // Строки, уже проверенные после сегодняшних 10:00 (правкой или прошлым
  // запуском воркера до рестарта), повторно не трогаем.
  const passStart = todayDailyPassStart(now).getTime();
  const due = rows.filter((row) => Date.parse(row.last_checked_at) < passStart);
  ctx.log('info', `daily pass: ${due.length} of ${rows.length} open checks`);
  let failed = 0;
  for (const row of due) {
    if (ctx.shouldStop()) break;
    try {
      await recheckRow(ctx, row, now);
    } catch (error) {
      failed += 1;
      ctx.log('error', `daily recheck failed for message ${row.message_id}`, error);
    }
  }
  return failed;
}

/** Возвращает ключ даты последнего прохода. */
async function maybeRunDailyPass(ctx: Ctx, lastPassKey: string | null): Promise<string | null> {
  const now = new Date();
  if (!isDailyPassDue(now, lastPassKey)) return lastPassKey;
  try {
    const failed = await runDailyPass(ctx, now);
    if (failed > 0) {
      await ctx.alerts.raise('daily-failed', `ежедневная перепроверка: ${failed} строк с ошибкой`, 'see worker logs');
    } else {
      ctx.alerts.clear('daily-failed');
    }
    return moscowDateKey(now);
  } catch (error) {
    await ctx.alerts.raise('daily-failed', 'ежедневная перепроверка не запустилась; повторим', error);
    return lastPassKey;
  }
}

// ── Запуск ───────────────────────────────────────────────────────────────────

function isConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b409\b|conflict/i.test(text);
}

/** Webhook у бота — не снимаем его сами (он может быть нужен заявкам с сайта), а ждём человека. */
async function waitUntilNoWebhook(ctx: Ctx): Promise<void> {
  while (!ctx.shouldStop()) {
    let url = '';
    try {
      url = (await getWebhookInfo(TOKEN)).url ?? '';
    } catch (error) {
      ctx.log('warn', 'getWebhookInfo failed; starting long polling anyway', error);
      return;
    }
    if (!url) {
      ctx.alerts.clear('webhook');
      return;
    }
    await ctx.alerts.raise('webhook', 'у бота стоит webhook, чтение ветки не запущено', `webhook: ${url}`);
    await pause(HOUR_MS, ctx.shouldStop);
  }
}

/** С включённой приватностью бот-не-админ не видит обычных сообщений группы. */
async function checkPrivacy(ctx: Ctx): Promise<void> {
  try {
    const me = await getMe(TOKEN);
    if (me.can_read_all_group_messages) return;
    const member = await getChatMember(TOKEN, CHAT_ID, me.id);
    if (member.status === 'administrator' || member.status === 'creator') return;
    await ctx.alerts.raise(
      'privacy',
      'у бота включена приватность и он не админ — он не видит сообщения ветки; выключите /setprivacy в BotFather или сделайте его админом',
      `chat member status: ${member.status}`,
    );
  } catch (error) {
    ctx.log('warn', 'privacy check failed', error);
  }
}

/** Первый запуск = самая ранняя строка таблицы; таблица пуста — этот запуск. */
async function resolveLaunchedAt(db: Db, log: WorkerLogger): Promise<number> {
  const now = Date.now();
  try {
    const earliest = await earliestCheckAt(db);
    const earliestMs = earliest ? Date.parse(earliest) : Number.NaN;
    return Number.isFinite(earliestMs) ? Math.min(earliestMs, now) : now;
  } catch (error) {
    log('warn', 'cannot read earliest check; treating this start as launch', error);
    return now;
  }
}

async function pollUpdates(ctx: Ctx, offset: number): Promise<number> {
  let updates: TelegramUpdate[];
  try {
    updates = await getUpdates(TOKEN, offset, ['message', 'edited_message']);
    ctx.alerts.clear('conflict');
  } catch (error) {
    if (isConflict(error)) {
      await ctx.alerts.raise('conflict', 'getUpdates 409: обновления бота читает кто-то ещё', error);
      await pause(CONFLICT_PAUSE_MS, ctx.shouldStop);
    } else {
      ctx.log('error', 'getUpdates failed; retrying in 10 seconds', error);
      await pause(ERROR_PAUSE_MS, ctx.shouldStop);
    }
    return offset;
  }

  let next = offset;
  for (const update of updates) {
    // Offset двигаем до обработки: одно сломанное обновление не должно
    // крутиться вечно и блокировать остальные.
    next = Math.max(next, update.update_id + 1);
    try {
      await handleUpdate(ctx, update);
      ctx.alerts.clear('update-failed');
    } catch (error) {
      await ctx.alerts.raise('update-failed', `не удалось обработать сообщение (update ${update.update_id})`, error);
    }
  }
  return next;
}

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  const shouldStop = setupGracefulShutdown(log);
  const alerts = new AlertOnce(log);

  if (!TOKEN) {
    // Не падаем в рестарт-цикл: токен добавят в .env и пересоздадут контейнер.
    await alerts.raise('no-token', 'HANDOFF_BOT_TOKEN не задан, проверка передачи проектов не работает', 'no token');
    while (!shouldStop()) await pause(HOUR_MS, shouldStop);
    return;
  }

  const db = requireSupabaseAdmin(log);
  const ctx: Ctx = { db, log, shouldStop, alerts, launchedAtMs: await resolveLaunchedAt(db, log) };
  await waitUntilNoWebhook(ctx);
  await checkPrivacy(ctx);

  log('info', `long polling started (chat ${CHAT_ID}, thread ${THREAD_ID}, launched ${new Date(ctx.launchedAtMs).toISOString()})`);
  let offset = 0;
  let lastPassKey: string | null = null;
  while (!shouldStop()) {
    lastPassKey = await maybeRunDailyPass(ctx, lastPassKey);
    offset = await pollUpdates(ctx, offset);
  }
  log('info', 'long polling stopped');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[handoffCheckBot] fatal', error);
    process.exit(1);
  });
}
