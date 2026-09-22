/**
 * @jest-environment node
 *
 * Регрессия от 22.09.2026: место вызова updateQueueItem собирало объект
 * заново и теряло `note` — причину пустого результата. На проде это дало
 * 195 пустых строк, ни у одной причины, хотя scrapeEmails её отдавал.
 */

import { completedPayload } from '@/lib/enrich/websiteEnrichmentWorker';

describe('completedPayload', () => {
  it('доносит причину пустого результата до queue-строки', () => {
    expect(completedPayload({ text: '', note: 'Домен не резолвится' })).toEqual({
      text: '',
      note: 'Домен не резолвится',
    });
  });

  it('оставляет найденные адреса и не выдумывает причину', () => {
    expect(completedPayload({ text: 'info@acme.ru' })).toEqual({
      text: 'info@acme.ru',
      note: undefined,
    });
  });

  it('пустой результат без причины остаётся пустым', () => {
    expect(completedPayload({})).toEqual({ text: '', note: undefined });
  });
});
