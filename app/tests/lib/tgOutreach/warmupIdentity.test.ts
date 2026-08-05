/** @jest-environment node */

/**
 * Регрессия на зависший запуск прогрева (05.08.2026).
 *
 * getMe уходил в мобильный прокси, у которого сменился IP, и не возвращался
 * никогда: gramJS такой вызов не таймаутит. Цикл идентификации последовательный,
 * поэтому один мёртвый сокет вешал запуск на все 16 аккаунтов, а сторожевой
 * таймер воркера через 15 минут убивал процесс — за ночь 14 перезапусков и ноль
 * проведённых переписок.
 */

import { bootstrapAccountIdentity } from '@/lib/tgOutreach/warmup/identity';

type FakeClient = { getMe: () => Promise<unknown> };

function fakeDb(captured: Record<string, unknown>[]) {
  return {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        captured.push(patch);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  } as never;
}

describe('bootstrapAccountIdentity', () => {
  const OLD_ENV = process.env.TG_WARMUP_IDENTITY_TIMEOUT_MS;

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.TG_WARMUP_IDENTITY_TIMEOUT_MS;
    else process.env.TG_WARMUP_IDENTITY_TIMEOUT_MS = OLD_ENV;
  });

  it('падает по таймауту, а не висит вечно, если Telegram не отвечает', async () => {
    process.env.TG_WARMUP_IDENTITY_TIMEOUT_MS = '50';
    const client: FakeClient = { getMe: () => new Promise(() => { /* никогда */ }) };

    await expect(
      bootstrapAccountIdentity(fakeDb([]), client as never, { id: 'a1', phone: '' }),
    ).rejects.toThrow(/getMe: нет ответа/);
  });

  it('нормальный ответ проходит и пишется в БД', async () => {
    process.env.TG_WARMUP_IDENTITY_TIMEOUT_MS = '5000';
    const captured: Record<string, unknown>[] = [];
    const client: FakeClient = {
      getMe: async () => ({ id: 777, username: 'warm_acc', phone: '998910250742' }),
    };

    const identity = await bootstrapAccountIdentity(
      fakeDb(captured),
      client as never,
      { id: 'a1', phone: '' },
    );

    expect(identity.tg_user_id).toBe(777);
    expect(identity.tg_username).toBe('warm_acc');
    expect(captured[0]).toMatchObject({ tg_user_id: 777, tg_username: 'warm_acc' });
  });

  it('таймаут одного аккаунта не мешает следующему — вызовы независимы', async () => {
    process.env.TG_WARMUP_IDENTITY_TIMEOUT_MS = '50';
    const dead: FakeClient = { getMe: () => new Promise(() => { /* никогда */ }) };
    const alive: FakeClient = { getMe: async () => ({ id: 42, username: 'ok' }) };

    await expect(
      bootstrapAccountIdentity(fakeDb([]), dead as never, { id: 'dead', phone: '' }),
    ).rejects.toThrow();

    const identity = await bootstrapAccountIdentity(
      fakeDb([]),
      alive as never,
      { id: 'alive', phone: '' },
    );
    expect(identity.tg_user_id).toBe(42);
  });
});
