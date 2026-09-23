/** @jest-environment node */

/**
 * Отпечаток отбора сохранённой проверки.
 *
 * Детектор застоя сравнивает отбор прохода с предыдущим. Пока в отпечаток
 * входила рябь, к самой проверке не относящаяся (число готовых контактов базы
 * и сырой статус валидации соседнего адреса), детектор не защёлкивался:
 * 21.09.2026 база 912c19df сорок раз подряд уточняла одни и те же 479
 * контактов 110 компаний, не обращаясь к провайдеру ни разу.
 */

import { veRelevanceRowKey, veSavedReviewSignature } from '@/lib/verticalEngineV2/relevanceReserve';

const decision = (extra: Record<string, unknown> = {}) => ({
  version: 2, status: 'needs_review', reason: 'Нет сведений о деятельности', evidence: [],
  context_hash: 'a'.repeat(64), review_attempts: 0, triage_version: 1, ...extra,
});

const mainRow = {
  company: 'Клиника А', inn: '7701234567', website: 'a.test', email: 'chief@a.test',
  _email_status: 'catch_all', _ve_relevance: decision(),
};
const siblingRow = {
  company: 'Клиника А', inn: '7701234567', website: 'a.test', email: 'info@a.test',
  _email_status: 'unknown', _ve_relevance: decision(),
};

const sign = (rows: Array<Record<string, unknown>>, triage = true) =>
  JSON.stringify(veSavedReviewSignature(rows, { triage }));

describe('veSavedReviewSignature', () => {
  it('не замечает статус валидации соседнего адреса, пока тот не стал годным', () => {
    const before = sign([mainRow, siblingRow]);
    // Дочерняя валидация ответила «невалидный»: получателем адрес не стал,
    // отбор сохранённой проверки не изменился — это не продвижение.
    expect(sign([mainRow, { ...siblingRow, _email_status: 'invalid' }])).toBe(before);
    expect(sign([mainRow, { ...siblingRow, _email_status: 'disposable' }])).toBe(before);
    // А годный адрес меняет отбор и обязан считаться продвижением.
    expect(sign([mainRow, { ...siblingRow, _email_status: 'ok' }])).not.toBe(before);
    expect(sign([mainRow, { ...siblingRow, _email_status: 'catch_all' }])).not.toBe(before);
  });

  it('замечает всё, чем сама проверка двигает отбор', () => {
    const before = sign([mainRow, siblingRow]);
    for (const changed of [
      { ...decision(), status: 'relevant' },
      { ...decision(), review_attempts: 1 },
      { ...decision(), website_review_version: 4 },
      { ...decision(), search_deferred: true },
      { ...decision(), triage_version: 2 },
      // Отметка правил отбора выводит строку из разового прохода.
      { ...decision(), rules_version: 2 },
    ]) {
      expect(sign([{ ...mainRow, _ve_relevance: changed }, siblingRow])).not.toBe(before);
    }
    // Состав отбора: выбывшая или добавившаяся компания — тоже изменение.
    expect(sign([mainRow])).not.toBe(before);
  });

  it('у строк без отметки правил отбора отпечаток прежний: раскатка не даёт лишнего прохода', () => {
    expect(veSavedReviewSignature([mainRow], { triage: true }))
      .toEqual([[veRelevanceRowKey(mainRow), true, 'needs_review', 0, null, null, 1]]);
    expect(veSavedReviewSignature([mainRow], { triage: false }))
      .toEqual([[veRelevanceRowKey(mainRow), true, 'needs_review', 0, null, null]]);
  });

  it('не зависит от порядка строк и от версии триажа при выключенном триаже', () => {
    expect(sign([siblingRow, mainRow])).toBe(sign([mainRow, siblingRow]));
    const off = sign([mainRow, siblingRow], false);
    expect(sign([{ ...mainRow, _ve_relevance: decision({ triage_version: 7 }) }, siblingRow], false)).toBe(off);
  });

  it('различает строки одной компании и переживает отсутствие вердикта', () => {
    expect(sign([mainRow])).not.toBe(sign([siblingRow]));
    const noDecision = { company: 'Клиника Б', inn: '', website: 'b.test', email: 'chief@b.test', _email_status: 'ok' };
    expect(() => sign([noDecision])).not.toThrow();
    expect(sign([noDecision])).not.toBe(sign([{ ...noDecision, _ve_relevance: decision() }]));
  });
});
