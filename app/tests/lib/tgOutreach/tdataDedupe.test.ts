/**
 * @jest-environment node
 */
import { splitExistingAccounts } from '@/lib/tgOutreach/tdataImport';
import type { TdataCandidate } from '@/lib/tgOutreach/tdataImport';

const candidate = (name: string, tgUserId: number): TdataCandidate => ({
  name,
  tgUserId,
  sessionString: `sess-${tgUserId}`,
  apiId: 2040,
  apiHash: 'hash',
});

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
});
