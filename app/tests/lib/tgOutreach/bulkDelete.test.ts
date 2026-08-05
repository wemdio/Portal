import { parseBulkDeleteBody, BULK_DELETE_MAX_IDS } from '@/lib/tgOutreach/bulkDelete';

describe('parseBulkDeleteBody', () => {
  it('принимает корректное тело', () => {
    const r = parseBulkDeleteBody({ campaign_id: 'c1', ids: ['a', 'b'] });
    expect(r).toEqual({ ok: true, campaignId: 'c1', ids: ['a', 'b'] });
  });

  it('схлопывает дубли — иначе delete .in() выполняется по раздутому списку', () => {
    const r = parseBulkDeleteBody({ campaign_id: 'c1', ids: ['a', 'a', 'b'] });
    expect(r).toEqual({ ok: true, campaignId: 'c1', ids: ['a', 'b'] });
  });

  it('чистит пустые строки и не-строки, пришедшие из UI', () => {
    const r = parseBulkDeleteBody({ campaign_id: 'c1', ids: ['a', '', '  ', null, 42, ' b '] });
    expect(r).toEqual({ ok: true, campaignId: 'c1', ids: ['a', 'b'] });
  });

  it('требует campaign_id — без него удаление не ограничено кампанией', () => {
    expect(parseBulkDeleteBody({ ids: ['a'] })).toEqual({
      ok: false,
      error: 'campaign_id обязателен',
    });
    expect(parseBulkDeleteBody({ campaign_id: '   ', ids: ['a'] })).toEqual({
      ok: false,
      error: 'campaign_id обязателен',
    });
  });

  it('отклоняет пустой список, чтобы delete не ушёл без фильтра по id', () => {
    for (const ids of [[], ['', '  '], 'a', undefined]) {
      const r = parseBulkDeleteBody({ campaign_id: 'c1', ids });
      expect(r.ok).toBe(false);
    }
  });

  it('ограничивает размер пачки', () => {
    const ids = Array.from({ length: BULK_DELETE_MAX_IDS + 1 }, (_, i) => `id-${i}`);
    const r = parseBulkDeleteBody({ campaign_id: 'c1', ids });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/не больше 500/);
  });

  it('отклоняет мусор вместо объекта', () => {
    for (const body of [null, undefined, 'str', 42, ['a']]) {
      expect(parseBulkDeleteBody(body).ok).toBe(false);
    }
  });
});
