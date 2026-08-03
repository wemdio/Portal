/**
 * Прогрев: проведение одной переписки.
 *
 * Обе стороны наши, поэтому ждать ответа опросом не нужно — ведём оба клиента
 * по очереди. Логика чередования и сборки истории живёт поверх абстракции
 * WarmupSide, чтобы проверяться без Telegram.
 */
import type { DialogMessage } from '../types';
import type { WarmupMessage } from './types';
import { REPLY_DELAY_RANGE_SEC } from './types';
import { fallbackReply } from './prompt';

export interface WarmupSide {
  accountId: string;
  send(text: string): Promise<void>;
}

export interface RunWarmupConversationParams {
  sideA: WarmupSide;
  sideB: WarmupSide;
  initiatorAccountId: string;
  plannedMessages: number;
  generate: (history: DialogMessage[]) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  delayRangeSec?: [number, number];
}

/**
 * Провести переписку и вернуть отправленные сообщения.
 *
 * Два типа сбоя обрабатываются по-разному, и это осознанно. Ошибку отправки НЕ
 * глотаем: недоставленное сообщение означает, что с аккаунтом или прокси что-то
 * не так, и вызывающий код должен пометить переписку failed. А сбой GPT глотаем
 * и подставляем банальную реплику — оборванный на полуслове диалог выглядит
 * подозрительнее, чем скучный ответ.
 */
export async function runWarmupConversation(
  params: RunWarmupConversationParams,
): Promise<WarmupMessage[]> {
  const { sideA, sideB, initiatorAccountId, plannedMessages, generate, sleep, random } = params;
  const [minSec, maxSec] = params.delayRangeSec ?? REPLY_DELAY_RANGE_SEC;

  const first = sideA.accountId === initiatorAccountId ? sideA : sideB;
  const second = first === sideA ? sideB : sideA;
  const out: WarmupMessage[] = [];

  for (let i = 0; i < plannedMessages; i++) {
    const speaker = i % 2 === 0 ? first : second;

    if (i > 0) {
      await sleep(Math.round((minSec + random() * (maxSec - minSec)) * 1000));
    }

    const history: DialogMessage[] = out.map((m) => ({
      role: m.account_id === speaker.accountId ? 'assistant' : 'user',
      content: m.content,
    }));

    let text: string;
    try {
      text = (await generate(history))?.trim() || fallbackReply(i);
    } catch {
      text = fallbackReply(i);
    }

    await speaker.send(text);
    out.push({
      account_id: speaker.accountId,
      content: text,
      timestamp: new Date().toISOString(),
    });
  }

  return out;
}
