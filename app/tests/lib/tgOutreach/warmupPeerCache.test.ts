/** @jest-environment node */

/**
 * Память о найденных собеседниках.
 *
 * Инцидент 07.08.2026: каждая переписка начиналась с поиска собеседника, а он
 * упирается в импорт контакта. За четыре дня это ~218 циклов «добавил-удалил»
 * по замкнутому кругу из 16 номеров — почерк сбора контактов. На четвёртом дне
 * Telegram перестал отвечать на эти запросы, и 32 переписки из 37 сорвались.
 *
 * Ключевая тонкость, которую здесь и проверяем: access_hash выдаётся под
 * конкретный аккаунт-наблюдатель. Перепутать направление пары — значит
 * отправить сообщение с чужим ключом доступа.
 */

import { Api } from 'telegram';
import bigInt from 'big-integer';
import { peerIdentity, peerKey, toInputPeer } from '@/lib/tgOutreach/warmup/peerCache';

describe('ключ кэша собеседников', () => {
  it('направление пары важно: A→B и B→A это разные записи', () => {
    expect(peerKey('a1', 'b2')).not.toBe(peerKey('b2', 'a1'));
  });

  it('один и тот же взгляд даёт один и тот же ключ', () => {
    expect(peerKey('a1', 'b2')).toBe(peerKey('a1', 'b2'));
  });
});

describe('извлечение того, что стоит запомнить', () => {
  function fakeUser(id: string, accessHash: string | null): Api.User {
    const user = Object.create(Api.User.prototype) as Api.User;
    Object.assign(user, {
      id: bigInt(id),
      accessHash: accessHash === null ? undefined : bigInt(accessHash),
    });
    return user;
  }

  it('запоминаем id и ключ доступа как строки', () => {
    // Оба числа 64-битные: в JS-число они не влезают без потери точности,
    // поэтому по всему пути живут строками.
    const identity = peerIdentity(fakeUser('7654321098765432', '1234567890123456789'));
    expect(identity).toEqual({
      tgUserId: '7654321098765432',
      accessHash: '1234567890123456789',
    });
  });

  it('без ключа доступа запоминать нечего — найдём заново', () => {
    expect(peerIdentity(fakeUser('777', null))).toBeNull();
  });
});

describe('сборка получателя из запомненного', () => {
  it('числа переживают путь через строки без потери точности', () => {
    const peer = toInputPeer({ tgUserId: '7654321098765432', accessHash: '1234567890123456789' });
    expect(peer).toBeInstanceOf(Api.InputPeerUser);
    expect(String(peer.userId)).toBe('7654321098765432');
    expect(String(peer.accessHash)).toBe('1234567890123456789');
  });
});
