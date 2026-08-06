/** @jest-environment node */

/**
 * Ограничение по времени для вызовов Telegram.
 *
 * Инцидент 06.08.2026: запрос ушёл в мобильный прокси, у которого сменился IP,
 * и не вернулся. Цикл прогрева перестал отчитываться, сторожевой таймер
 * воркера через 16 минут погасил кампанию, через 3 минуты уронил процесс — и
 * вместе с прогревом перезапустились все пять боевых кампаний.
 */

import { withTimeout } from '@/lib/tgOutreach/withTimeout';

describe('withTimeout', () => {
  it('успевший ответ проходит как есть', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'запрос')).resolves.toBe('ok');
  });

  it('ошибка исходного запроса не подменяется таймаутом', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('PEER_FLOOD')), 1000, 'запрос'),
    ).rejects.toThrow('PEER_FLOOD');
  });

  it('зависший запрос падает, а не ждёт вечно', async () => {
    await expect(
      withTimeout(new Promise(() => { /* никогда */ }), 30, 'отправка сообщения'),
    ).rejects.toThrow('отправка сообщения: нет ответа за 0с');
  });

  it('таймер снимается после успеха — процесс не держится живым', async () => {
    jest.useFakeTimers();
    try {
      const p = withTimeout(Promise.resolve(1), 60_000, 'запрос');
      await expect(p).resolves.toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
