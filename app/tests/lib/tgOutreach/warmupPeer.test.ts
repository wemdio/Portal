/**
 * @jest-environment node
 *
 * Выбор способа найти собеседника. Сам вызов MTProto тестами не покрыть
 * осмысленно, а вот решение «идти по username или импортировать телефон» —
 * ровно та развилка, где ошибка стоит дорого: лишний импорт контакта оставляет
 * след в аккаунте, а неверная нормализация телефона просто не найдёт человека.
 */

import { chooseResolutionStrategy, normalizePhone } from '@/lib/tgOutreach/warmup/peer';

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
