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
      { name: 'a', reason: 'уже загружен в кампанию «ATOL»' },
    ]);
  });

  it('без названия кампании всё равно не пускает дубль', () => {
    const result = splitExistingAccounts(
      [candidate('a', 111)],
      [{ tg_user_id: 111, campaign_name: null }],
    );

    expect(result.fresh).toEqual([]);
    expect(result.skipped[0].reason).toBe('уже загружен в другую кампанию');
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
      [{ tg_user_id: null, campaign_name: 'ATOL', session_data: session(5, '149.154.167.50') }],
    );

    expect(result.fresh).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'из-архива', reason: 'эта же сессия уже загружена в кампанию «ATOL» — совпал ключ входа' },
    ]);
  });

  it('без названия кампании дубль по ключу тоже не проходит', () => {
    const result = splitExistingAccounts(
      [withSession('из-архива', 777, session(5))],
      [{ tg_user_id: null, campaign_name: null, session_data: session(5) }],
    );

    expect(result.fresh).toEqual([]);
    expect(result.skipped[0].reason).toBe(
      'эта же сессия уже загружена в другую кампанию — совпал ключ входа',
    );
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
    expect(result.skipped[0].reason).toBe('уже загружен в кампанию «ATOL»');
  });
});
