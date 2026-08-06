/** @jest-environment node */

/**
 * Проверяем до похода в Telegram: отказ от сервера приходит кодом вроде
 * FIRSTNAME_INVALID, оператору он ничего не объясняет, а попытка стоит
 * подключения через мобильный прокси.
 */

import { validateProfile, PROFILE_LIMITS } from '@/lib/tgOutreach/profile/validateProfile';

describe('validateProfile', () => {
  it('обычный профиль проходит', () => {
    expect(validateProfile({ first_name: 'Иван', last_name: 'Петров', bio: 'Продажи в IT' })).toEqual({ ok: true });
  });

  it('имя обязательно — в Telegram аккаунт без имени невозможен', () => {
    expect(validateProfile({ first_name: '', last_name: '', bio: '' })).toEqual({
      ok: false,
      field: 'first_name',
      reason: 'Имя не может быть пустым',
    });
    expect(validateProfile({ first_name: '   ', last_name: '', bio: '' }).ok).toBe(false);
  });

  it('лимиты Telegram: имя и фамилия по 64, описание 70', () => {
    expect(PROFILE_LIMITS).toEqual({ first_name: 64, last_name: 64, bio: 70 });
    expect(validateProfile({ first_name: 'и'.repeat(64), last_name: '', bio: '' }).ok).toBe(true);
    expect(validateProfile({ first_name: 'и'.repeat(65), last_name: '', bio: '' })).toMatchObject({
      ok: false,
      field: 'first_name',
    });
    expect(validateProfile({ first_name: 'Иван', last_name: 'п'.repeat(65), bio: '' })).toMatchObject({
      ok: false,
      field: 'last_name',
    });
    expect(validateProfile({ first_name: 'Иван', last_name: '', bio: 'б'.repeat(71) })).toMatchObject({
      ok: false,
      field: 'bio',
    });
  });

  it('фамилия и описание могут быть пустыми', () => {
    expect(validateProfile({ first_name: 'Иван', last_name: '', bio: '' })).toEqual({ ok: true });
  });
});
