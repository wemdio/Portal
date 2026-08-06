/**
 * @jest-environment node
 *
 * Проведение одной переписки прогрева. Обе стороны наши, поэтому рантайм ведёт
 * оба клиента по очереди и не ждёт ответа опросом — проверяем именно это
 * чередование, сборку истории для GPT и разное отношение к двум типам сбоя:
 * ошибку отправки пробрасываем (переписка не состоялась), сбой GPT глотаем
 * (молчание посреди разговора хуже банальной фразы).
 *
 * Telegram в тестах не участвует: стороны — это фейки поверх WarmupSide.
 */

import {
  runWarmupConversation,
  WarmupSendError,
  type WarmupSide,
} from '@/lib/tgOutreach/warmup/conversation';

interface Sent { from: string; text: string }

function fakeSide(accountId: string, sent: Sent[]): WarmupSide {
  return {
    accountId,
    send: async (text: string) => { sent.push({ from: accountId, text }); },
  };
}

const noSleep = async () => {};

describe('warmup conversation', () => {
  it('отправляет ровно запланированное число сообщений', async () => {
    const sent: Sent[] = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 5,
      generate: async () => 'привет', sleep: noSleep, random: () => 0.5,
    });
    expect(sent).toHaveLength(5);
    expect(messages).toHaveLength(5);
  });

  it('стороны чередуются, начиная с инициатора', async () => {
    const sent: Sent[] = [];
    await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'b', plannedMessages: 4,
      generate: async () => 'ок', sleep: noSleep, random: () => 0.5,
    });
    expect(sent.map((m) => m.from)).toEqual(['b', 'a', 'b', 'a']);
  });

  it('история для GPT собирается с точки зрения говорящего', async () => {
    const sent: Sent[] = [];
    const histories: Array<Array<{ role: string; content: string }>> = [];
    let n = 0;
    await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 3,
      generate: async (history) => {
        histories.push(history.map((h) => ({ role: h.role, content: h.content })));
        return `msg${++n}`;
      },
      sleep: noSleep, random: () => 0.5,
    });
    expect(histories[0]).toEqual([]);
    // Второе сообщение пишет B — реплика A для него чужая (user).
    expect(histories[1]).toEqual([{ role: 'user', content: 'msg1' }]);
    // Третье пишет A: своя первая реплика assistant, ответ B — user.
    expect(histories[2]).toEqual([
      { role: 'assistant', content: 'msg1' },
      { role: 'user', content: 'msg2' },
    ]);
  });

  it('в сообщениях проставлен автор', async () => {
    const sent: Sent[] = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 2,
      generate: async () => 'ок', sleep: noSleep, random: () => 0.5,
    });
    expect(messages.map((m) => m.account_id)).toEqual(['a', 'b']);
    for (const m of messages) expect(m.timestamp).toBeTruthy();
  });

  it('пустой ответ GPT заменяется запасной репликой', async () => {
    const sent: Sent[] = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 3,
      generate: async () => null, sleep: noSleep, random: () => 0.5,
    });
    expect(messages).toHaveLength(3);
    for (const m of messages) expect(m.content.length).toBeGreaterThan(0);
  });

  it('падение GPT не роняет переписку', async () => {
    const sent: Sent[] = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 2,
      generate: async () => { throw new Error('gpt down'); },
      sleep: noSleep, random: () => 0.5,
    });
    expect(messages).toHaveLength(2);
    expect(sent).toHaveLength(2);
  });

  it('ошибка отправки прерывает переписку и пробрасывается наверх', async () => {
    const sent: Sent[] = [];
    const brokenB: WarmupSide = {
      accountId: 'b',
      send: async () => { throw new Error('PEER_FLOOD'); },
    };
    await expect(runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: brokenB,
      initiatorAccountId: 'a', plannedMessages: 4,
      generate: async () => 'привет', sleep: noSleep, random: () => 0.5,
    })).rejects.toThrow('PEER_FLOOD');
    // Первая реплика ушла, на второй сломались — дальше не пошли.
    expect(sent).toHaveLength(1);
  });

  it('ошибка отправки доносит частичный прогресс и виновника', async () => {
    const sent: Sent[] = [];
    const brokenB: WarmupSide = {
      accountId: 'b',
      send: async () => { throw new Error('PEER_FLOOD'); },
    };
    let err: unknown;
    try {
      await runWarmupConversation({
        sideA: fakeSide('a', sent), sideB: brokenB,
        initiatorAccountId: 'a', plannedMessages: 4,
        generate: async () => 'привет', sleep: noSleep, random: () => 0.5,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WarmupSendError);
    const sendErr = err as WarmupSendError;
    // Уже отправленное не теряется: первая реплика A дошла и сохранена.
    expect(sendErr.sent).toHaveLength(1);
    expect(sendErr.sent[0].account_id).toBe('a');
    expect(sendErr.failedAccountId).toBe('b');
  });

  it('onMessage вызывается на каждую отправку с номером и итогом', async () => {
    const sent: Sent[] = [];
    const seen: Array<{ from: string; index: number; total: number }> = [];
    await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 3,
      generate: async () => 'ок', sleep: noSleep, random: () => 0.5,
      onMessage: async (msg, index, total) => {
        seen.push({ from: msg.account_id, index, total });
      },
    });
    expect(seen).toEqual([
      { from: 'a', index: 0, total: 3 },
      { from: 'b', index: 1, total: 3 },
      { from: 'a', index: 2, total: 3 },
    ]);
  });

  it('сбой onMessage не роняет переписку', async () => {
    const sent: Sent[] = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 2,
      generate: async () => 'ок', sleep: noSleep, random: () => 0.5,
      onMessage: async () => { throw new Error('db down'); },
    });
    expect(messages).toHaveLength(2);
  });

  it('между репликами выдерживается пауза из диапазона, перед первой — нет', async () => {
    const sent: Sent[] = [];
    const delays: number[] = [];
    await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 3,
      generate: async () => 'ок',
      sleep: async (ms) => { delays.push(ms); },
      random: () => 0.5, delayRangeSec: [10, 20],
    });
    expect(delays).toHaveLength(2);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(10_000);
      expect(d).toBeLessThanOrEqual(20_000);
    }
  });

  it('нулевая длина переписки не отправляет ничего', async () => {
    const sent: Sent[] = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 0,
      generate: async () => 'ок', sleep: noSleep, random: () => 0.5,
    });
    expect(messages).toEqual([]);
    expect(sent).toEqual([]);
  });
});
