/**
 * Прогрев в публичных чатах: работа с БД.
 *
 * Отдельно от `db.ts`: тот ведёт переписки между своими, этот — этап в чатах.
 * Файл, где лежит и то и другое, пришлось бы читать целиком ради любой правки.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlannedActivity, ChatAssignment } from './chatSchedule';
import type {
  WarmupActivity,
  WarmupChat,
  WarmupChatMember,
  WarmupChatMemberStatus,
} from './types';
import { CONVERSATION_STALE_MINUTES } from './types';

/** Чаты кампании, готовые к работе: резолвнутые и не выключенные оператором. */
export async function loadUsableChats(
  db: SupabaseClient,
  campaignId: string,
): Promise<WarmupChat[]> {
  const { data } = await db
    .from('tg_outreach_warmup_chats')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true)
    .eq('status', 'resolved')
    .order('created_at', { ascending: true });
  return (data ?? []) as WarmupChat[];
}

/**
 * Записать раскладку аккаунтов по чатам.
 *
 * Дубли отсекает уникальный индекс: повторный вызов после перезапуска воркера
 * безопасен и ничего не переназначает — состав чатов у аккаунта должен быть
 * постоянным, иначе он весь прогрев мигрирует по чатам, что само по себе след.
 */
export async function saveChatAssignments(
  db: SupabaseClient,
  run: { id: string; campaign_id: string },
  assignments: ChatAssignment[],
  plannedAt: Map<string, string>,
): Promise<void> {
  if (!assignments.length) return;
  await db.from('tg_outreach_warmup_chat_members').upsert(
    assignments.map((a) => ({
      run_id: run.id,
      campaign_id: run.campaign_id,
      account_id: a.accountId,
      chat_id: a.chatId,
      status: 'pending',
      planned_at: plannedAt.get(`${a.accountId}|${a.chatId}`) ?? null,
    })),
    { onConflict: 'run_id,account_id,chat_id', ignoreDuplicates: true },
  );
}

export async function hasChatAssignments(db: SupabaseClient, runId: string): Promise<boolean> {
  const { count } = await db
    .from('tg_outreach_warmup_chat_members')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId);
  return (count ?? 0) > 0;
}

/** Участия, которым пора вступать: время пришло, а вступление ещё не сделано. */
export async function loadDueJoins(
  db: SupabaseClient,
  runId: string,
  now: Date,
): Promise<WarmupChatMember[]> {
  const { data } = await db
    .from('tg_outreach_warmup_chat_members')
    .select('*')
    .eq('run_id', runId)
    .eq('status', 'pending')
    .lte('planned_at', now.toISOString())
    .order('planned_at', { ascending: true })
    .limit(20);
  return (data ?? []) as WarmupChatMember[];
}

export async function setMemberStatus(
  db: SupabaseClient,
  id: number,
  status: WarmupChatMemberStatus,
  errorReason?: string,
): Promise<void> {
  await db
    .from('tg_outreach_warmup_chat_members')
    .update({
      status,
      ...(status === 'joined' ? { joined_at: new Date().toISOString() } : {}),
      ...(errorReason ? { error_reason: errorReason.slice(0, 500) } : {}),
    })
    .eq('id', id);
}

/**
 * Пометить участие запрещённым сразу во всех прогонах кампании.
 *
 * Бан выдаётся аккаунту в чате, а не в рамках конкретного прогрева: если
 * помечать только текущий прогон, следующий прогрев пойдёт стучаться в тот же
 * запрет с первого дня.
 */
export async function forbidMember(
  db: SupabaseClient,
  params: { campaignId: string; accountId: string; chatId: string; reason: string },
): Promise<void> {
  await db
    .from('tg_outreach_warmup_chat_members')
    .update({ status: 'forbidden', error_reason: params.reason.slice(0, 500) })
    .eq('campaign_id', params.campaignId)
    .eq('account_id', params.accountId)
    .eq('chat_id', params.chatId);
}

/** Пары «аккаунт-чат», куда можно работать: вступление прошло, запрета нет. */
export async function loadJoinedAssignments(
  db: SupabaseClient,
  runId: string,
): Promise<ChatAssignment[]> {
  const { data } = await db
    .from('tg_outreach_warmup_chat_members')
    .select('account_id, chat_id')
    .eq('run_id', runId)
    .eq('status', 'joined');
  return ((data ?? []) as Array<{ account_id: string; chat_id: string }>).map((r) => ({
    accountId: r.account_id,
    chatId: r.chat_id,
  }));
}

export async function isActivityDayPlanned(
  db: SupabaseClient,
  runId: string,
  day: number,
): Promise<boolean> {
  const { count } = await db
    .from('tg_outreach_warmup_activities')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('day_no', day);
  return (count ?? 0) > 0;
}

export async function saveActivityPlan(
  db: SupabaseClient,
  run: { id: string; campaign_id: string },
  day: number,
  plan: PlannedActivity[],
): Promise<void> {
  if (!plan.length) return;
  await db.from('tg_outreach_warmup_activities').insert(
    plan.map((a) => ({
      run_id: run.id,
      campaign_id: run.campaign_id,
      day_no: day,
      account_id: a.accountId,
      chat_id: a.chatId,
      kind: a.kind,
      planned_at: a.plannedAt,
      status: 'pending',
    })),
  );
}

/**
 * Активности, которым пора выполниться.
 *
 * Зависшие в `running` возвращаются сюда же: если процесс умер посреди
 * активности, иначе она осталась бы в этом статусе навсегда.
 */
export async function loadDueActivities(
  db: SupabaseClient,
  runId: string,
  day: number,
  now: Date,
  staleMinutes: number,
): Promise<WarmupActivity[]> {
  const staleBefore = new Date(now.getTime() - staleMinutes * 60_000).toISOString();
  const { data } = await db
    .from('tg_outreach_warmup_activities')
    .select('*')
    .eq('run_id', runId)
    .eq('day_no', day)
    .lte('planned_at', now.toISOString())
    .or(`status.eq.pending,and(status.eq.running,started_at.lt.${staleBefore})`)
    .order('planned_at', { ascending: true })
    .limit(30);
  return (data ?? []) as WarmupActivity[];
}

export async function markActivityRunning(db: SupabaseClient, id: number): Promise<void> {
  await db
    .from('tg_outreach_warmup_activities')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', id);
}

export async function finishActivity(
  db: SupabaseClient,
  id: number,
  result: {
    status: 'done' | 'failed' | 'skipped';
    targetMessageId?: number;
    targetExcerpt?: string;
    content?: string;
    errorReason?: string;
  },
): Promise<void> {
  await db
    .from('tg_outreach_warmup_activities')
    .update({
      status: result.status,
      finished_at: new Date().toISOString(),
      ...(result.targetMessageId ? { target_message_id: result.targetMessageId } : {}),
      ...(result.targetExcerpt ? { target_excerpt: result.targetExcerpt.slice(0, 300) } : {}),
      ...(result.content ? { content: result.content.slice(0, 500) } : {}),
      ...(result.errorReason ? { error_reason: result.errorReason.slice(0, 500) } : {}),
    })
    .eq('id', id);
}

/**
 * Вернуть в очередь активности, зависшие в «выполняется» дольше порога.
 *
 * Порог появился вместе с арендой прогона, по той же причине, что и в
 * requeueStuckConversations (warmup/db.ts): раньше основанием для слепого
 * сброса было «процесс только что поднялся, значит своих активностей у него
 * нет». Под арендой процесс не единственный — уходящий владелец может ещё
 * дописывать ответ в публичный чат, и сброс отдал бы ту же активность второму
 * исполнителю, то есть чат получил бы два ответа от одного аккаунта.
 *
 * Порог тот же, по которому активность подбирает loadDueActivities
 * (CONVERSATION_STALE_MINUTES, 45 минут). `started_at is null` при
 * «выполняется» — отдельная ветка: такую строку не берёт ни один порог.
 */
export async function requeueStuckActivities(
  db: SupabaseClient,
  runId: string,
): Promise<number> {
  const staleBefore = new Date(
    Date.now() - CONVERSATION_STALE_MINUTES * 60_000,
  ).toISOString();
  const { data } = await db
    .from('tg_outreach_warmup_activities')
    .update({ status: 'pending', started_at: null })
    .eq('run_id', runId)
    .eq('status', 'running')
    .or(`started_at.is.null,started_at.lt."${staleBefore}"`)
    .select('id');
  return (data ?? []).length;
}

/** Закрыть день: не начатые активности помечаем пропущенными. */
export async function skipRemainingActivities(
  db: SupabaseClient,
  runId: string,
  day: number,
  reason: string,
): Promise<void> {
  await db
    .from('tg_outreach_warmup_activities')
    .update({ status: 'skipped', error_reason: reason, finished_at: new Date().toISOString() })
    .eq('run_id', runId)
    .eq('day_no', day)
    .in('status', ['pending', 'running']);
}
