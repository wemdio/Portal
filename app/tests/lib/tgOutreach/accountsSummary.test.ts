/** @jest-environment node */

/**
 * Числа в шапке вкладки «Аккаунты» оператор читает первыми и по ним решает,
 * идти ли разбираться. Ошибка здесь дороже ошибки в вёрстке — отсюда тесты на
 * саму арифметику, а не на её отображение.
 */

import { summarizeAccounts, type AccountsSummaryAccount } from '@/lib/tgOutreach/accountsSummary';

const acc = (over: Partial<AccountsSummaryAccount> = {}): AccountsSummaryAccount => ({
  session_name: 'acc-1',
  is_active: true,
  check_status: 'ok',
  checked_at: '2026-08-12T09:00:00.000Z',
  ...over,
});

const NOW = new Date('2026-08-12T12:00:00.000Z').getTime();

describe('summarizeAccounts', () => {
  it('раскладывает партию по итогу последней проверки', () => {
    const s = summarizeAccounts(
      [
        acc({ session_name: 'a' }),
        acc({ session_name: 'b' }),
        acc({ session_name: 'c', check_status: 'banned' }),
        acc({ session_name: 'd', check_status: 'session_revoked' }),
        acc({ session_name: 'e', check_status: null, checked_at: null }),
      ],
      {},
      NOW,
    );

    expect(s.alive).toBe(2);
    expect(s.dead).toBe(2);
    expect(s.unchecked).toBe(1);
    expect(s.byStatus).toEqual({ banned: 1, session_revoked: 1 });
  });

  /**
   * Главное свойство: живые, мёртвые и непроверенные — разбиение. Если они
   * перестанут складываться в общее число, экран начнёт врать молча.
   */
  it('жив + не жив + не проверялись = всего аккаунтов', () => {
    const accounts = [
      acc({ session_name: 'a' }),
      acc({ session_name: 'b', check_status: 'proxy_dead' }),
      acc({ session_name: 'c', check_status: undefined }),
      acc({ session_name: 'd', check_status: 'restricted' }),
    ];
    const s = summarizeAccounts(accounts, {}, NOW);
    expect(s.alive + s.dead + s.unchecked).toBe(accounts.length);
  });

  it('«выключен» считается отдельно и не мешает разбиению', () => {
    const s = summarizeAccounts(
      [
        acc({ session_name: 'a', is_active: false }),
        acc({ session_name: 'b', is_active: false, check_status: 'session_duplicate' }),
        acc({ session_name: 'c' }),
      ],
      {},
      NOW,
    );

    expect(s.disabled).toBe(2);
    // Выключенный, но живой по проверке, остаётся в «жив» — это разные вопросы.
    expect(s.alive).toBe(2);
    expect(s.dead).toBe(1);
  });

  describe('ошибки за окно', () => {
    it('считает аккаунты, а не строки; сумму строк отдаёт отдельно', () => {
      const s = summarizeAccounts(
        [acc({ session_name: 'a' }), acc({ session_name: 'b' }), acc({ session_name: 'c' })],
        {
          a: { error: 5, warning: 2 },
          b: { error: 1, warning: 0 },
        },
        NOW,
      );

      expect(s.withErrors).toBe(2);
      expect(s.errorTotal).toBe(6);
    });

    it('аккаунт с ошибками и предупреждениями разом считается один раз — по худшему', () => {
      const s = summarizeAccounts(
        [acc({ session_name: 'a' }), acc({ session_name: 'b' })],
        {
          a: { error: 3, warning: 4 },
          b: { error: 0, warning: 7 },
        },
        NOW,
      );

      expect(s.withErrors).toBe(1);
      expect(s.withWarningsOnly).toBe(1);
    });

    it('аккаунт без строк в логах не попадает никуда', () => {
      const s = summarizeAccounts([acc({ session_name: 'a' })], {}, NOW);
      expect(s.withErrors).toBe(0);
      expect(s.withWarningsOnly).toBe(0);
      expect(s.errorTotal).toBe(0);
    });
  });

  describe('возраст проверки', () => {
    it('берёт самую свежую проверку по партии', () => {
      const s = summarizeAccounts(
        [
          acc({ session_name: 'a', checked_at: '2026-08-10T09:00:00.000Z' }),
          acc({ session_name: 'b', checked_at: '2026-08-12T09:00:00.000Z' }),
        ],
        {},
        NOW,
      );

      expect(s.newestCheck).toBe(new Date('2026-08-12T09:00:00.000Z').getTime());
      expect(s.ageHours).toBe(3);
    });

    it('проверок не было — возраста нет, а не ноль', () => {
      const s = summarizeAccounts([acc({ check_status: null, checked_at: null })], {}, NOW);
      expect(s.newestCheck).toBeNull();
      expect(s.ageHours).toBeNull();
    });

    it('битую дату проверки игнорируем', () => {
      const s = summarizeAccounts([acc({ checked_at: 'не дата' })], {}, NOW);
      expect(s.newestCheck).toBeNull();
    });

    it('данные ещё не загрузились — возраст не считаем', () => {
      const s = summarizeAccounts([acc()], {}, null);
      expect(s.ageHours).toBeNull();
      expect(s.newestCheck).not.toBeNull();
    });
  });

  it('пустая партия не падает', () => {
    const s = summarizeAccounts([], {}, NOW);
    expect(s).toMatchObject({ alive: 0, dead: 0, unchecked: 0, disabled: 0, withErrors: 0 });
  });
});
