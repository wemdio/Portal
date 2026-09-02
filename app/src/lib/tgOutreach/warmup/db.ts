/**
 * Прогрев: работа с БД.
 *
 * Всё состояние живёт здесь, а не в памяти воркера. Четыре дня гарантированно
 * переживут несколько перезапусков процесса (деплой, сторожевой таймер на 15
 * минут простоя), и прогрев обязан продолжаться с той же точки, а не начинаться
 * заново.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlannedConversation } from './schedule';
import type {
  WarmupConversation,
  WarmupMessage,
  WarmupPerAccountStat,
  WarmupRun,
  WarmupSummary,
} from './types';
import { CONVERSATION_STALE_MINUTES } from './types';

/**
 * Записать событие прогрева.
 *
 * Своя таблица, а не общий tg_outreach_logs: там идёт поток боевого цикла
 * («круг завершён», «пауза перед переходом к следующему аккаунту»), и во
 * вкладке «Прогрев» он полностью заглушал события прогрева.
 */
export async function logWarmup(
  db: SupabaseClient,
  entry: {
    runId: string;
    campaignId: string;
    accountId?: string | null;
    level: 'info' | 'warning' | 'error';
    message: string;
  },
): Promise<void> {
  await db.from('tg_outreach_warmup_logs').insert({
    run_id: entry.runId,
    campaign_id: entry.campaignId,
    account_id: entry.accountId ?? null,
    level: entry.level,
    message: entry.message.slice(0, 2000),
  });
}

/**
 * Пометить кампанию как греющуюся (или вернуть в «остановлена»).
 *
 * Статус кампании — то место, где правило «либо греем, либо работаем по лидам»
 * становится видимым и проверяемым: воркер не берёт `warming` в боевой
 * auto-resume, а API отказывает в запуске аутрича.
 */
/**
 * Обе стороны ограждены статусом, и обе — по одной причине.
 *
 * Пока прогрев держался слотом в памяти воркера, ни одна из этих записей
 * физически не могла попасть на кампанию, которую ведёт боевой цикл: слот был
 * один на двоих. Под арендой прогон живёт своей жизнью, и безусловная запись
 * стала бы способом отобрать чужую кампанию:
 *  - `false` без фильтра остановил бы аутрич, который тем временем законно
 *    владеет кампанией;
 *  - `true` без фильтра затёр бы `running`, поставленный командой «старт»,
 *    проскочившей в узком окне между проверкой владельца в начале прогрева и
 *    этой записью. Оба цикла пошли бы по одним и тем же аккаунтам.
 *
 * Поэтому взятие замка (`true`) разрешено только из состояний, в которых
 * кампанией никто не занят: `stopped`, `error` и уже стоящий `warming` (его
 * ставит интерфейс сразу по нажатию кнопки — повторная запись идемпотентна).
 *
 * Возвращает, легла ли запись. Для `true` это ответ «замок наш»: false значит
 * кампанию перехватил аутрич, и продолжать прогрев нельзя.
 */
export async function setCampaignWarming(
  db: SupabaseClient,
  campaignId: string,
  warming: boolean,
): Promise<boolean> {
  const q = db
    .from('tg_outreach_campaigns')
    .update({ status: warming ? 'warming' : 'stopped', updated_at: new Date().toISOString() })
    .eq('id', campaignId);
  const { data } = await (warming
    ? q.in('status', ['stopped', 'error', 'warming'])
    : q.eq('status', 'warming')
  ).select('id');
  return (data ?? []).length > 0;
}

/** Идущий или ожидающий запуск прогрева. Активный может быть только один. */
export async function getActiveRun(
  db: SupabaseClient,
  campaignId: string,
): Promise<WarmupRun | null> {
  const { data } = await db
    .from('tg_outreach_warmup_runs')
    .select('*')
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'running'])
    .maybeSingle();
  return (data as WarmupRun | null) ?? null;
}

export async function getLatestRun(
  db: SupabaseClient,
  campaignId: string,
): Promise<WarmupRun | null> {
  const { data } = await db
    .from('tg_outreach_warmup_runs')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as WarmupRun | null) ?? null;
}

export async function createRun(
  db: SupabaseClient,
  campaignId: string,
  days: number,
  settings: Record<string, unknown>,
): Promise<{ run: WarmupRun | null; error: string | null }> {
  const { data, error } = await db
    .from('tg_outreach_warmup_runs')
    .insert({ campaign_id: campaignId, days, settings, status: 'pending' })
    .select('*')
    .maybeSingle();
  return { run: (data as WarmupRun | null) ?? null, error: error?.message ?? null };
}

/**
 * Записать в строку прогона — с ограждением по жетону аренды.
 *
 * `runToken` необязателен, потому что прогон переехал на единый жизненный цикл
 * задач (lib/jobs/lifecycle.ts) с `manageTerminalStatus: false`: терминальный
 * статус пишет само тело прогрева, и библиотека эти записи оградить не может.
 * Без жетона вытесненный исполнитель проштамповал бы `finished`/`failed` или
 * сдвинул `current_day` поверх работы нового владельца строки. Когда жетона
 * нет (вызов вне раннера), фильтр не добавляется и поведение остаётся прежним —
 * тот же приём, что в safeUpdateSearchJob (lib/parsers/searchParserWorker.ts).
 */
export async function setRunStatus(
  db: SupabaseClient,
  runId: string,
  patch: {
    status?: WarmupRun['status'];
    current_day?: number;
    error_message?: string | null;
    started_at?: string;
    finished_at?: string;
    summary?: WarmupSummary;
    /** Снятие владения вместе с терминальным статусом (см. lib/jobs/lifecycle.ts). */
    lease_until?: null;
    run_token?: null;
    worker_id?: null;
  },
  runToken?: string | null,
): Promise<void> {
  const q = db.from('tg_outreach_warmup_runs').update(patch).eq('id', runId);
  await (runToken ? q.eq('run_token', runToken) : q);
}

/**
 * Сохранить план дня. Дубль пары внутри одного дня отсекается уникальным
 * индексом, поэтому повторный вызов после перезапуска безопасен.
 */
export async function saveDayPlan(
  db: SupabaseClient,
  run: Pick<WarmupRun, 'id' | 'campaign_id'>,
  day: number,
  plan: PlannedConversation[],
): Promise<void> {
  if (!plan.length) return;
  await db.from('tg_outreach_warmup_conversations').upsert(
    plan.map((c) => ({
      run_id: run.id,
      campaign_id: run.campaign_id,
      day_no: day,
      account_a_id: c.accountAId,
      account_b_id: c.accountBId,
      initiator_account_id: c.initiatorAccountId,
      planned_at: c.plannedAt,
      planned_messages: c.plannedMessages,
      status: 'pending',
    })),
    { onConflict: 'run_id,day_no,account_a_id,account_b_id', ignoreDuplicates: true },
  );
}

export async function isDayPlanned(
  db: SupabaseClient,
  runId: string,
  day: number,
): Promise<boolean> {
  const { count } = await db
    .from('tg_outreach_warmup_conversations')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('day_no', day);
  return (count ?? 0) > 0;
}

/** Пары, уже общавшиеся в этом прогреве — вход для планировщика следующего дня. */
export async function loadPreviousPairs(
  db: SupabaseClient,
  runId: string,
): Promise<Array<[string, string]>> {
  const { data } = await db
    .from('tg_outreach_warmup_conversations')
    .select('account_a_id, account_b_id')
    .eq('run_id', runId);
  return ((data ?? []) as Array<{ account_a_id: string; account_b_id: string }>).map(
    (r) => [r.account_a_id, r.account_b_id] as [string, string],
  );
}

/**
 * Переписки, которым пора начаться.
 *
 * Сюда же возвращаются зависшие в running: если процесс умер посреди переписки,
 * она иначе осталась бы в этом статусе навсегда и день никогда бы не закрылся.
 */
export async function loadDueConversations(
  db: SupabaseClient,
  runId: string,
  day: number,
  now: Date,
): Promise<WarmupConversation[]> {
  const staleBefore = new Date(
    now.getTime() - CONVERSATION_STALE_MINUTES * 60_000,
  ).toISOString();
  const { data } = await db
    .from('tg_outreach_warmup_conversations')
    .select('*')
    .eq('run_id', runId)
    .eq('day_no', day)
    .lte('planned_at', now.toISOString())
    .or(`status.eq.pending,and(status.eq.running,started_at.lt.${staleBefore})`)
    .order('planned_at', { ascending: true })
    .limit(50);
  return (data ?? []) as WarmupConversation[];
}

export async function markConversationRunning(
  db: SupabaseClient,
  id: number,
): Promise<void> {
  await db
    .from('tg_outreach_warmup_conversations')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', id);
}

/**
 * Инкрементально сохранить сообщения идущей переписки — после каждой отправки.
 *
 * Сообщение, реально ушедшее в Telegram, должно пережить смерть процесса:
 * до 06.08.2026 messages писались только при успешном финише, и оборванная
 * переписка выглядела пустой, хотя половина реплик дошла до адресата.
 */
export async function updateConversationMessages(
  db: SupabaseClient,
  id: number,
  messages: WarmupMessage[],
): Promise<void> {
  await db
    .from('tg_outreach_warmup_conversations')
    .update({ messages })
    .eq('id', id);
}

export async function finishConversation(
  db: SupabaseClient,
  id: number,
  result: {
    status: 'done' | 'failed' | 'skipped';
    messages?: WarmupMessage[];
    errorReason?: string;
  },
): Promise<void> {
  await db
    .from('tg_outreach_warmup_conversations')
    .update({
      status: result.status,
      finished_at: new Date().toISOString(),
      ...(result.messages ? { messages: result.messages } : {}),
      ...(result.errorReason ? { error_reason: result.errorReason.slice(0, 500) } : {}),
    })
    .eq('id', id);
}

/**
 * Вернуть в очередь переписки прогона, зависшие в `running` дольше порога.
 *
 * Зовётся ПОСЛЕ захвата прогона, когда аренда уже наша, и только по своей
 * строке прогона — но этого мало, поэтому порог остался. Чем это отличается от
 * прежнего поведения:
 *
 *  - БЫЛО: слепой сброс ВСЕХ `running`-переписок прогона при входе в цикл.
 *    Основание — «процесс только что поднялся, значит ни одна переписка
 *    физически не может идти». Пока прогон жил в памяти одного процесса, это
 *    было правдой.
 *  - СТАЛО: под арендой процесс не единственный. Библиотека намеренно допускает
 *    окно, когда уходящий владелец ещё дописывает переписку, а сосед уже
 *    захватил прогон (lib/jobs/lifecycle.ts, «Терпеть, что сосед начал ту же
 *    задачу раньше»). Слепой сброс в этом окне выдернул бы живую переписку:
 *    два процесса повели бы один и тот же диалог теми же двумя аккаунтами, и
 *    собеседники получили бы по второму комплекту реплик.
 *
 * Порог — тот же CONVERSATION_STALE_MINUTES (45 минут), по которому переписку
 * подбирает loadDueConversations: переписка из 10 реплик с паузами до 90 с
 * укладывается в ~15 минут, то есть запас тройной. Функция после этого не
 * ускоряет подбор (loadDueConversations взял бы ту же строку), а приводит её
 * статус в порядок и даёт число для журнала.
 *
 * `started_at is null` при `running` — отдельная ветка: такую строку не берёт
 * ни один порог, и без неё она осталась бы `running` навсегда.
 *
 * Возвращает, сколько записей вернули — вызывающий код пишет это в журнал.
 */
export async function requeueStuckConversations(
  db: SupabaseClient,
  runId: string,
): Promise<number> {
  const staleBefore = new Date(
    Date.now() - CONVERSATION_STALE_MINUTES * 60_000,
  ).toISOString();
  const { data } = await db
    .from('tg_outreach_warmup_conversations')
    .update({ status: 'pending', started_at: null })
    .eq('run_id', runId)
    .eq('status', 'running')
    .or(`started_at.is.null,started_at.lt."${staleBefore}"`)
    .select('id');
  return (data ?? []).length;
}

/** Закрыть день: всё, что не успело начаться, помечаем пропущенным. */
export async function skipRemainingForDay(
  db: SupabaseClient,
  runId: string,
  day: number,
  reason: string,
): Promise<void> {
  await db
    .from('tg_outreach_warmup_conversations')
    .update({
      status: 'skipped',
      error_reason: reason,
      finished_at: new Date().toISOString(),
    })
    .eq('run_id', runId)
    .eq('day_no', day)
    .in('status', ['pending', 'running']);
}

/**
 * Сводка прогрева — то, по чему оператор решает, пускать ли аккаунты в бой.
 * «Чистым» считаем аккаунт, у которого есть успешные переписки и ни одной
 * провальной: половинчатый результат должен быть виден, а не усреднён.
 */
export async function buildSummary(
  db: SupabaseClient,
  runId: string,
  accounts: Array<{ id: string; session_name: string }>,
): Promise<WarmupSummary> {
  const { data } = await db
    .from('tg_outreach_warmup_conversations')
    .select('account_a_id, account_b_id, status, messages, error_reason')
    .eq('run_id', runId);
  const rows = (data ?? []) as Array<{
    account_a_id: string;
    account_b_id: string;
    status: string;
    messages: WarmupMessage[] | null;
    error_reason: string | null;
  }>;

  const per = new Map<string, WarmupPerAccountStat>(
    accounts.map((a) => [
      a.id,
      { account_id: a.id, session_name: a.session_name, done: 0, failed: 0, last_error: null },
    ]),
  );

  let done = 0;
  let failed = 0;
  let messages = 0;
  for (const r of rows) {
    if (r.status === 'done') {
      done++;
      messages += (r.messages ?? []).length;
    } else if (r.status === 'failed') {
      failed++;
    }
    for (const id of [r.account_a_id, r.account_b_id]) {
      const slot = per.get(id);
      if (!slot) continue;
      if (r.status === 'done') slot.done++;
      else if (r.status === 'failed') {
        slot.failed++;
        if (r.error_reason) slot.last_error = r.error_reason;
      }
    }
  }

  const perAccount = [...per.values()];
  return {
    accounts_total: accounts.length,
    accounts_ok: perAccount.filter((a) => a.done > 0 && a.failed === 0).length,
    accounts_failed: perAccount.filter((a) => a.failed > 0).length,
    conversations_done: done,
    conversations_failed: failed,
    messages_sent: messages,
    per_account: perAccount,
  };
}
