/** @jest-environment node */

/**
 * Правило «кто рассылает базу»: пустой фильтр = все аккаунты кампании,
 * непустой = только выбранные. Это новая ветка логики первого касания —
 * ошибка здесь либо разворачивает персональную базу обратно на весь пул
 * (пустой фильтр воспринялся как ограничение), либо запирает базу навсегда
 * (выбранный id не совпал из-за сравнения не с тем полем). Проверяем чистую
 * функцию без базы и Telegram.
 */

import { basesAllowedForAccount } from '@/lib/tgOutreach/firstTouch/db';

describe('basesAllowedForAccount — кому база доступна', () => {
  it('пустой фильтр = все аккаунты кампании (поведение баз до фичи)', () => {
    const bases = [
      { id: 'base-1', sending_account_ids: [] },
      { id: 'base-2', sending_account_ids: null },
    ];
    expect(basesAllowedForAccount(bases, 'acc-1')).toEqual(['base-1', 'base-2']);
  });

  it('непустой фильтр пускает только выбранных', () => {
    const bases = [
      { id: 'base-1', sending_account_ids: ['acc-1'] },
      { id: 'base-2', sending_account_ids: ['acc-2'] },
      { id: 'base-3', sending_account_ids: [] },
    ];
    expect(basesAllowedForAccount(bases, 'acc-1')).toEqual(['base-1', 'base-3']);
    expect(basesAllowedForAccount(bases, 'acc-2')).toEqual(['base-2', 'base-3']);
    expect(basesAllowedForAccount(bases, 'acc-3')).toEqual(['base-3']);
  });

  it('аккаунт, исключённый из всех баз, не получает ни одной', () => {
    const bases = [
      { id: 'base-1', sending_account_ids: ['acc-1'] },
      { id: 'base-2', sending_account_ids: ['acc-2'] },
    ];
    expect(basesAllowedForAccount(bases, 'acc-3')).toEqual([]);
  });

  it('порядок баз сохраняется — раунд-робин между ними не перестраивается', () => {
    const bases = [
      { id: 'base-2', sending_account_ids: [] },
      { id: 'base-1', sending_account_ids: [] },
    ];
    expect(basesAllowedForAccount(bases, 'acc-1')).toEqual(['base-2', 'base-1']);
  });
});
