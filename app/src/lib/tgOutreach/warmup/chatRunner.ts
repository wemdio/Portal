/**
 * Прогрев в публичных чатах: выполнение запланированных действий.
 *
 * Отдельный модуль, а не ещё пара функций в `loop.ts`: цикл прогрева и так
 * ведёт переписки, план дня и сторожевые отметки. Здесь собрано всё, что
 * происходит внутри одной активности, — от чтения чата до записи результата.
 *
 * Главный принцип этапа: пропуск дешевле плохого действия. Мёртвый чат,
 * неподходящая тема, слоу-мод — всё это `skipped`, а не `failed`, и прогрев
 * идёт дальше. Ошибкой считается только то, что говорит о проблеме аккаунта.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramClient } from 'telegram';
import type { ActiveClient } from '../gramClient';
import { openaiGenerate } from '../openaiChat';
import * as cdb from './chatDb';
import {
  ChatForbiddenError,
  availableReactions,
  chatEntity,
  describeChatError,
  fetchRecentMessages,
  joinChat,
  looksThrottled,
  replyToMessage,
  sendReaction,
} from './chatOps';
import { pickReactionTarget, pickReplyTarget } from './chatSchedule';
import { publicReplyOpenAISettings } from './prompt';
import type { WarmupActivity, WarmupChat } from './types';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string, accountId?: string) => void;

export interface RunActivityDeps {
  db: SupabaseClient;
  activity: WarmupActivity;
  chat: WarmupChat;
  client: ActiveClient;
  /** tg_user_id всех аккаунтов кампании: своим на публике не отвечаем. */
  ownUserIds: Set<number>;
  accountName: string;
  log: LogFn;
  onProgress?: () => void;
}

/** Отрывок исходного сообщения для журнала: за ним в Telegram потом не сходишь. */
function excerpt(text: string, limit = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Выполнить одну активность: ответ или реакцию.
 *
 * Никогда не бросает: сбой одной активности не должен ронять проход цикла, в
 * котором ещё десяток других и переписки между своими.
 */
export async function runActivity(deps: RunActivityDeps): Promise<void> {
  const { db, activity, chat, client, onProgress } = deps;

  await cdb.markActivityRunning(db, activity.id);

  try {
    const entity = await chatEntity(client.client, chat);
    onProgress?.();

    const messages = await fetchRecentMessages(client.client, entity);
    onProgress?.();

    if (activity.kind === 'reaction') {
      await runReaction({ ...deps, entity, messages });
      return;
    }
    await runReply({ ...deps, entity, messages });
  } catch (e) {
    await handleActivityError(e, deps);
  }
}

type WithChat = RunActivityDeps & {
  entity: Awaited<ReturnType<typeof chatEntity>>;
  messages: Awaited<ReturnType<typeof fetchRecentMessages>>;
};

async function runReaction(deps: WithChat): Promise<void> {
  const { db, activity, chat, client, ownUserIds, accountName, log, entity, messages } = deps;

  const target = pickReactionTarget({
    messages,
    now: new Date(),
    ownUserIds,
    random: Math.random,
  });
  if (!target) {
    await cdb.finishActivity(db, activity.id, {
      status: 'skipped',
      errorReason: 'в чате нет свежих сообщений',
    });
    return;
  }

  const emojis = await availableReactions(client.client, entity);
  if (!emojis.length) {
    await cdb.finishActivity(db, activity.id, {
      status: 'skipped',
      errorReason: 'в чате выключены реакции',
    });
    return;
  }

  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  await sendReaction(client.client, entity, target.id, emoji);

  await cdb.finishActivity(db, activity.id, {
    status: 'done',
    targetMessageId: target.id,
    targetExcerpt: excerpt(target.text),
    content: emoji,
  });
  log(
    'info',
    `${accountName} поставил ${emoji} в «${chat.title ?? chat.link}»${target.text ? `: «${excerpt(target.text, 60)}»` : ''}`,
    activity.account_id,
  );
}

async function runReply(deps: WithChat): Promise<void> {
  const { db, activity, chat, client, ownUserIds, accountName, log, entity, messages } = deps;

  const target = pickReplyTarget({
    messages,
    now: new Date(),
    ownUserIds,
    random: Math.random,
  });
  if (!target) {
    await cdb.finishActivity(db, activity.id, {
      status: 'skipped',
      errorReason: 'в чате нечего ответить',
    });
    return;
  }

  // Пустой ответ — не сбой, а решение модели промолчать: тема спорная и любой
  // ответ хуже молчания. См. промпт публичных ответов.
  const text = (
    await openaiGenerate(publicReplyOpenAISettings(), [
      { role: 'user', content: target.text },
    ])
  )?.trim();

  if (!text) {
    await cdb.finishActivity(db, activity.id, {
      status: 'skipped',
      targetMessageId: target.id,
      targetExcerpt: excerpt(target.text),
      errorReason: 'тема не подошла для ответа',
    });
    return;
  }

  await replyToMessage(client.client, entity, target.id, text);

  await cdb.finishActivity(db, activity.id, {
    status: 'done',
    targetMessageId: target.id,
    targetExcerpt: excerpt(target.text),
    content: text,
  });
  log(
    'info',
    `${accountName} ответил в «${chat.title ?? chat.link}» на «${excerpt(target.text, 60)}»: «${excerpt(text, 90)}»`,
    activity.account_id,
  );
}

/**
 * Разложить сбой активности на три исхода.
 *
 * Запрет писать — единственный случай, когда мы что-то меняем надолго: участие
 * переводится в `forbidden`, и активности этому аккаунту в этот чат больше не
 * планируются. Слоу-мод и флуд — временные, просто пропускаем. Всё остальное
 * пишем как сбой, но прогрев не трогаем.
 */
async function handleActivityError(e: unknown, deps: RunActivityDeps): Promise<void> {
  const { db, activity, chat, accountName, log } = deps;
  const raw = e instanceof Error ? e.message : String(e);
  const human = describeChatError(e);
  const chatName = chat.title ?? chat.link;

  if (e instanceof ChatForbiddenError || raw.includes('CHAT_WRITE_FORBIDDEN')) {
    await cdb.forbidMember(db, {
      campaignId: activity.campaign_id,
      accountId: activity.account_id,
      chatId: activity.chat_id,
      reason: human,
    });
    await cdb.finishActivity(db, activity.id, { status: 'failed', errorReason: human });
    log(
      'warning',
      `${accountName}: в «${chatName}» больше не работаем — ${human}.`,
      activity.account_id,
    );
    return;
  }

  if (looksThrottled(raw)) {
    await cdb.finishActivity(db, activity.id, { status: 'skipped', errorReason: human });
    log('info', `${accountName}: пропуск активности в «${chatName}» — ${human}.`, activity.account_id);
    return;
  }

  await cdb.finishActivity(db, activity.id, { status: 'failed', errorReason: human });
  log('warning', `${accountName}: активность в «${chatName}» не удалась — ${human}.`, activity.account_id);
}

export interface RunJoinDeps {
  db: SupabaseClient;
  member: { id: number; account_id: string; chat_id: string; campaign_id: string };
  chat: WarmupChat;
  client: TelegramClient;
  accountName: string;
  log: LogFn;
}

/** Вступить в чат по запланированному участию. Тоже никогда не бросает. */
export async function runJoin(deps: RunJoinDeps): Promise<void> {
  const { db, member, chat, client, accountName, log } = deps;
  const chatName = chat.title ?? chat.link;

  try {
    const entity = await chatEntity(client, chat);
    await joinChat(client, entity);
    await cdb.setMemberStatus(db, member.id, 'joined');
    log('info', `${accountName} вступил в «${chatName}».`, member.account_id);
  } catch (e) {
    const human = describeChatError(e);
    const forbidden = e instanceof ChatForbiddenError;
    await cdb.setMemberStatus(db, member.id, forbidden ? 'forbidden' : 'failed', human);
    log(
      'warning',
      `${accountName}: не вступил в «${chatName}» — ${human}.`,
      member.account_id,
    );
  }
}
