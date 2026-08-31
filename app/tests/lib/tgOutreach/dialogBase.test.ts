/** @jest-environment node */

/**
 * Из какой базы пришёл собеседник.
 *
 * Проверяем не «функция что-то вернула», а правила связи: по каким ключам
 * диалог сходится с контактом и какая база выигрывает, когда ник лежит сразу в
 * нескольких гипотезах. Ошибка здесь не видна глазом — бейдж выглядит одинаково
 * убедительно и когда он прав, и когда врёт.
 */

import { buildDialogBaseIndex, type DialogBaseContact } from '@/lib/tgOutreach/dialogBase';

const BASES = [
  { id: 'b1', name: 'Гипотеза 1' },
  { id: 'b2', name: 'Гипотеза 2' },
];

const contact = (over: Partial<DialogBaseContact> = {}): DialogBaseContact => ({
  base_id: 'b1',
  username: 'someone',
  tg_user_id: null,
  sent_at: null,
  ...over,
});

describe('buildDialogBaseIndex — по какому ключу сходится', () => {
  it('находит базу по нику, не глядя на регистр и «@»', () => {
    const match = buildDialogBaseIndex(BASES, [contact({ username: 'ivan_petrov' })]);
    expect(match({ tg_username: '@Ivan_Petrov', tg_user_id: 42 })).toEqual({
      id: 'b1',
      name: 'Гипотеза 1',
      alsoIn: [],
    });
  });

  it('находит базу по tg_user_id, когда ник у собеседника сменился', () => {
    const match = buildDialogBaseIndex(BASES, [
      contact({ username: 'old_nick', tg_user_id: 777, sent_at: '2026-08-20T10:00:00.000Z' }),
    ]);
    expect(match({ tg_username: 'new_nick', tg_user_id: 777 })?.name).toBe('Гипотеза 1');
  });

  it('молчит, когда контакта нет ни в одной базе кампании', () => {
    const match = buildDialogBaseIndex(BASES, [contact({ username: 'someone' })]);
    expect(match({ tg_username: 'chance_visitor', tg_user_id: 5 })).toBeNull();
  });

  it('не приписывает базу чужой кампании, если её контакт попал в выборку', () => {
    const match = buildDialogBaseIndex(BASES, [contact({ base_id: 'alien', username: 'ivan' })]);
    expect(match({ tg_username: 'ivan', tg_user_id: 1 })).toBeNull();
  });
});

describe('buildDialogBaseIndex — ник в нескольких гипотезах', () => {
  it('главной называет ту базу, из которой человеку писали', () => {
    const match = buildDialogBaseIndex(BASES, [
      contact({ base_id: 'b1', username: 'ivan', sent_at: null }),
      contact({ base_id: 'b2', username: 'ivan', sent_at: '2026-08-20T10:00:00.000Z' }),
    ]);
    expect(match({ tg_username: 'ivan', tg_user_id: 1 })).toEqual({
      id: 'b2',
      name: 'Гипотеза 2',
      alsoIn: ['Гипотеза 1'],
    });
  });

  it('из двух отправивших берёт последнюю по времени', () => {
    const match = buildDialogBaseIndex(BASES, [
      contact({ base_id: 'b1', username: 'ivan', sent_at: '2026-08-01T10:00:00.000Z' }),
      contact({ base_id: 'b2', username: 'ivan', sent_at: '2026-08-20T10:00:00.000Z' }),
    ]);
    expect(match({ tg_username: 'ivan', tg_user_id: 1 })?.name).toBe('Гипотеза 2');
  });

  it('один и тот же контакт, найденный и по нику, и по id, не двоится', () => {
    const match = buildDialogBaseIndex(BASES, [
      contact({ base_id: 'b1', username: 'ivan', tg_user_id: 9, sent_at: '2026-08-20T10:00:00.000Z' }),
      contact({ base_id: 'b1', username: 'ivan', tg_user_id: 9, sent_at: '2026-08-20T10:00:00.000Z' }),
    ]);
    expect(match({ tg_username: 'ivan', tg_user_id: 9 })).toEqual({
      id: 'b1',
      name: 'Гипотеза 1',
      alsoIn: [],
    });
  });
});
