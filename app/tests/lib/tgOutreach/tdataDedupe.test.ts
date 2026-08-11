/**
 * @jest-environment node
 */
import { splitExistingAccounts } from '@/lib/tgOutreach/tdataImport';
import type { TdataCandidate } from '@/lib/tgOutreach/tdataImport';
import { buildGramJsSessionString } from '@/lib/telegram/sessionUtils';

const candidate = (name: string, tgUserId: number): TdataCandidate => ({
  name,
  tgUserId,
  sessionString: `sess-${tgUserId}`,
  apiId: 2040,
  apiHash: 'hash',
});

/** Кандидат с настоящей строкой сессии — по ней считается отпечаток ключа. */
const withSession = (name: string, tgUserId: number, sessionString: string): TdataCandidate => ({
  ...candidate(name, tgUserId),
  sessionString,
});

const session = (keyFill: number, address = '149.154.167.41') =>
  buildGramJsSessionString(2, address, 443, Buffer.alloc(256, keyFill));

describe('splitExistingAccounts', () => {
  it('пропускает уже загруженный аккаунт и называет кампанию', () => {
    const result = splitExistingAccounts(
      [candidate('a', 111), candidate('b', 222)],
      [{ tg_user_id: 111, campaign_name: 'ATOL' }],
    );

    expect(result.fresh.map((c) => c.name)).toEqual(['b']);
    expect(result.skipped).toEqual([
      { name: 'a', reason: 'уже загружен в кампанию «ATOL» (совпал telegram-id)' },
    ]);
  });

  it('называет аккаунт, а не только кампанию', () => {
    // Оператор ищет строку в списке кампании: без имени и телефона искать не
    // по чему, а строк там десятки.
    const result = splitExistingAccounts(
      [candidate('из-архива', 111)],
      [{
        tg_user_id: 111,
        campaign_name: 'Profitsol 3.0',
        session_name: 'acc_17',
        first_name: 'Иван',
        last_name: 'Петров',
        tg_username: 'ivanp',
        phone: '+79991234567',
      }],
    );

    expect(result.skipped[0].reason).toBe(
      'уже загружен в кампанию «Profitsol 3.0» — acc_17, Иван Петров, @ivanp, +79991234567 '
      + '(совпал telegram-id)',
    );
  });

  it('не оставляет пустых запятых, когда полей нет', () => {
    // У строки из tdata телефона нет до первой проверки, имени — до «Проверить».
    const result = splitExistingAccounts(
      [candidate('из-архива', 111)],
      [{
        tg_user_id: 111,
        campaign_name: 'ATOL',
        session_name: 'acc_17',
        phone: '',
        first_name: '',
        last_name: '',
        tg_username: null,
      }],
    );

    expect(result.skipped[0].reason).toBe(
      'уже загружен в кампанию «ATOL» — acc_17 (совпал telegram-id)',
    );
  });

  it('не оставляет висящего тире, когда об аккаунте ничего не известно', () => {
    const result = splitExistingAccounts(
      [candidate('из-архива', 111)],
      [{ tg_user_id: 111, campaign_name: 'ATOL' }],
    );

    expect(result.skipped[0].reason).toBe('уже загружен в кампанию «ATOL» (совпал telegram-id)');
  });

  it('не задваивает собачку в имени пользователя', () => {
    const result = splitExistingAccounts(
      [candidate('из-архива', 111)],
      [{ tg_user_id: 111, campaign_name: null, tg_username: '@ivanp' }],
    );

    expect(result.skipped[0].reason).toBe(
      'уже загружен в другую кампанию — @ivanp (совпал telegram-id)',
    );
  });

  it('без названия кампании всё равно не пускает дубль', () => {
    const result = splitExistingAccounts(
      [candidate('a', 111)],
      [{ tg_user_id: 111, campaign_name: null }],
    );

    expect(result.fresh).toEqual([]);
    expect(result.skipped[0].reason).toBe('уже загружен в другую кампанию (совпал telegram-id)');
  });

  it('на пустой базе пропускает всех вперёд', () => {
    const result = splitExistingAccounts([candidate('a', 111)], []);

    expect(result.fresh).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it('ловит дубль по ключу, когда у старой строки нет телеграм-id', () => {
    // Двадцать аккаунтов уже залиты старым путём (.session) и конвертированы
    // руками: tg_user_id у них пуст, потому что getMe() по ним не ходил.
    // Тот же аккаунт из tdata несёт другой адрес DC, но тот же ключ.
    const result = splitExistingAccounts(
      [withSession('из-архива', 777, session(5))],
      [{
        tg_user_id: null,
        campaign_name: 'ATOL',
        session_data: session(5, '149.154.167.50'),
        session_name: 'acc_04',
        phone: '+79990000004',
      }],
    );

    expect(result.fresh).toEqual([]);
    expect(result.skipped).toEqual([
      {
        name: 'из-архива',
        reason: 'уже загружен в кампанию «ATOL» — acc_04, +79990000004 (совпал ключ входа)',
      },
    ]);
  });

  it('без названия кампании дубль по ключу тоже не проходит', () => {
    const result = splitExistingAccounts(
      [withSession('из-архива', 777, session(5))],
      [{ tg_user_id: null, campaign_name: null, session_data: session(5) }],
    );

    expect(result.fresh).toEqual([]);
    expect(result.skipped[0].reason).toBe('уже загружен в другую кампанию (совпал ключ входа)');
  });

  it('пустой session_data ничего не проглатывает', () => {
    const result = splitExistingAccounts(
      [withSession('a', 111, session(3))],
      [
        { tg_user_id: null, campaign_name: 'ATOL', session_data: '' },
        { tg_user_id: null, campaign_name: 'ATOL', session_data: null },
      ],
    );

    expect(result.fresh.map((c) => c.name)).toEqual(['a']);
    expect(result.skipped).toEqual([]);
  });

  it('сверка по id работает и при разных строках сессии', () => {
    const result = splitExistingAccounts(
      [withSession('a', 111, session(1))],
      [{ tg_user_id: 111, campaign_name: 'ATOL', session_data: session(2) }],
    );

    expect(result.fresh).toEqual([]);
    expect(result.skipped[0].reason).toBe('уже загружен в кампанию «ATOL» (совпал telegram-id)');
  });
});
