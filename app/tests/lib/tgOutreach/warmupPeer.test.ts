/**
 * @jest-environment node
 *
 * Выбор способа найти собеседника. Сам вызов MTProto тестами не покрыть
 * осмысленно, а вот решение «идти по username или импортировать телефон» —
 * ровно та развилка, где ошибка стоит дорого: лишний импорт контакта оставляет
 * след в аккаунте, а неверная нормализация телефона просто не найдёт человека.
 */

import { Api } from 'telegram';
import { chooseResolutionStrategy, normalizePhone, resolveWarmupPeer } from '@/lib/tgOutreach/warmup/peer';

describe('warmup peer — нормализация телефона', () => {
  it('оставляет только цифры', () => {
    expect(normalizePhone('+998 (90) 111-22-33')).toBe('998901112233');
  });

  it('слишком короткий или нечисловой ввод отбрасывается', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('warmup peer — выбор стратегии', () => {
  it('username выигрывает у телефона: он не требует импорта контакта', () => {
    expect(chooseResolutionStrategy({ tg_username: 'ivan', phone: '998901112233' }))
      .toEqual({ kind: 'username', username: 'ivan' });
  });

  it('без username идём через импорт телефона', () => {
    expect(chooseResolutionStrategy({ tg_username: null, phone: '+998 90 111-22-33' }))
      .toEqual({ kind: 'phone', phone: '998901112233' });
  });

  it('@ в начале username отбрасывается', () => {
    expect(chooseResolutionStrategy({ tg_username: '@ivan', phone: null }))
      .toEqual({ kind: 'username', username: 'ivan' });
  });

  it('пустые строки не считаются значением', () => {
    expect(chooseResolutionStrategy({ tg_username: '  ', phone: '' }))
      .toEqual({ kind: 'none' });
  });

  it('нет ни username, ни телефона — резолвить нечем', () => {
    expect(chooseResolutionStrategy({ tg_username: null, phone: null }))
      .toEqual({ kind: 'none' });
  });

  it('битый телефон без username даёт none, а не попытку импорта', () => {
    expect(chooseResolutionStrategy({ tg_username: null, phone: '123' }))
      .toEqual({ kind: 'none' });
  });
});

/**
 * Регрессия 06.08.2026: резолв по @username упал внутри gramJS с «Cannot read
 * properties of undefined (reading 'classType')» — неполный кэш сущностей в
 * загруженной сессии. Переписка ушла в failed, хотя телефон собеседника был
 * известен и импорт контакта сработал бы.
 */
describe('warmup peer — резолв собеседника', () => {
  const fakeUser = Object.create(Api.User.prototype) as Api.User;

  function fakeClient(handlers: {
    resolve?: () => Promise<unknown>;
    importContacts?: () => Promise<unknown>;
  }) {
    return {
      invoke: (request: unknown) => {
        if (request instanceof Api.contacts.ResolveUsername) {
          return handlers.resolve
            ? handlers.resolve()
            : Promise.reject(new Error('resolve не ожидался'));
        }
        if (request instanceof Api.contacts.ImportContacts) {
          return handlers.importContacts
            ? handlers.importContacts()
            : Promise.reject(new Error('импорт не ожидался'));
        }
        return Promise.reject(new Error('неизвестный запрос'));
      },
    } as never;
  }

  it('username резолвится без импорта контакта', async () => {
    const peer = await resolveWarmupPeer(
      fakeClient({ resolve: async () => ({ users: [fakeUser] }) }),
      { tg_username: 'ivan', phone: '998901112233' },
    );
    expect(peer).toEqual({ entity: fakeUser, imported: false });
  });

  it('сбой резолва по username не теряет переписку: идём через телефон', async () => {
    const peer = await resolveWarmupPeer(
      fakeClient({
        resolve: async () => { throw new Error("Cannot read properties of undefined (reading 'classType')"); },
        importContacts: async () => ({ users: [fakeUser] }),
      }),
      { tg_username: 'ivan', phone: '998901112233' },
    );
    expect(peer).toEqual({ entity: fakeUser, imported: true });
  });

  /**
   * Регрессия 07.08.2026: username-запрос завис в мобильном прокси, внешний
   * общий таймаут гасил всю функцию до перехода на телефон, и 7 переписок
   * подряд ушли в failed вместо fallback.
   */
  it('зависший username падает по своему таймауту и переключается на телефон', async () => {
    const OLD = process.env.TG_WARMUP_RESOLVE_USERNAME_TIMEOUT_MS;
    process.env.TG_WARMUP_RESOLVE_USERNAME_TIMEOUT_MS = '50';
    try {
      const peer = await resolveWarmupPeer(
        fakeClient({
          resolve: () => new Promise(() => { /* никогда */ }),
          importContacts: async () => ({ users: [fakeUser] }),
        }),
        { tg_username: 'ivan', phone: '998901112233' },
      );
      expect(peer).toEqual({ entity: fakeUser, imported: true });
    } finally {
      if (OLD === undefined) delete process.env.TG_WARMUP_RESOLVE_USERNAME_TIMEOUT_MS;
      else process.env.TG_WARMUP_RESOLVE_USERNAME_TIMEOUT_MS = OLD;
    }
  });

  it('пустой ответ на username тоже уводит на телефон', async () => {
    const peer = await resolveWarmupPeer(
      fakeClient({
        resolve: async () => ({ users: [] }),
        importContacts: async () => ({ users: [fakeUser] }),
      }),
      { tg_username: 'ivan', phone: '998901112233' },
    );
    expect(peer?.imported).toBe(true);
  });

  it('без телефона сбой резолва пробрасывается наверх — прятать нечего', async () => {
    await expect(
      resolveWarmupPeer(
        fakeClient({ resolve: async () => { throw new Error('USERNAME_NOT_OCCUPIED'); } }),
        { tg_username: 'ivan', phone: null },
      ),
    ).rejects.toThrow('USERNAME_NOT_OCCUPIED');
  });

  it('адресовать нечем — null без единого запроса', async () => {
    const peer = await resolveWarmupPeer(fakeClient({}), { tg_username: null, phone: null });
    expect(peer).toBeNull();
  });
});
