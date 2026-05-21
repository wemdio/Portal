/**
 * @jest-environment node
 *
 * Контракты mergeFoundEmailColumn — финальное слияние двух email-колонок
 * (исходной и «Найденный Email») в одну перед экспортом.
 *
 * Запрос специалиста: «главное чтобы в итоговом файле были почты в одной
 * колонке, например если выбрано обе». В пайплайне можем хранить раздельно
 * (для validate-target='both', чтобы знать какой источник), но на финале —
 * одна колонка. Дедуп case-insensitive (B-вариант из обсуждения).
 */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => ({}) },
}));

import { mergeFoundEmailColumn } from '@/lib/tools/baseConstructorWorker';
import { FOUND_EMAIL_COL } from '@/lib/tools/processingSteps';

describe('mergeFoundEmailColumn', () => {
  it('no-op если FOUND_EMAIL_COL отсутствует', () => {
    const data = [
      ['Компания', 'Email'],
      ['Acme', 'a@x.ru'],
    ];
    expect(mergeFoundEmailColumn(data)).toEqual(data);
  });

  it('no-op для пустых данных', () => {
    expect(mergeFoundEmailColumn([])).toEqual([]);
  });

  it('обе колонки заполнены, разные email — мерджим через запятую', () => {
    const data = [
      ['Компания', 'Email', FOUND_EMAIL_COL],
      ['Acme', 'orig@a.ru', 'found@a.ru'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[0]).toEqual(['Компания', 'Email']); // FOUND_EMAIL_COL удалена
    expect(out[1]).toEqual(['Acme', 'orig@a.ru, found@a.ru']);
  });

  it('дедуп case-insensitive: одинаковый email в обеих → одна копия с регистром первого', () => {
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['Sales@x.ru', 'sales@x.ru, info@x.ru'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[1][0]).toBe('Sales@x.ru, info@x.ru'); // регистр первого вхождения сохранён
  });

  it('исходная пустая, найденная заполнена — берём найденные', () => {
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['', 'found@x.ru, more@x.ru'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[1][0]).toBe('found@x.ru, more@x.ru');
  });

  it('исходная заполнена, найденная пустая — оставляем исходную как есть', () => {
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['only-orig@x.ru', ''],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[1][0]).toBe('only-orig@x.ru');
  });

  it('обе пустые — итог пустой', () => {
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['', ''],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[1][0]).toBe('');
  });

  it('исходная с несколькими email, найденная с одним — мердж + дедуп', () => {
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['a@x.ru, b@x.ru', 'b@x.ru, c@x.ru'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[1][0]).toBe('a@x.ru, b@x.ru, c@x.ru');
  });

  it('FOUND_EMAIL_COL есть, но исходной email-колонки НЕТ → переименовываем FOUND в Email', () => {
    // Защитный case: не должно случаться в норме (stepFindEmails сам fallback'нется
    // в 'same' если нет исходной), но если кто-то вручную создаст такую data —
    // не теряем найденные.
    const data = [
      ['Компания', FOUND_EMAIL_COL],
      ['Acme', 'found@x.ru'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[0]).toEqual(['Компания', 'Email']);
    expect(out[1]).toEqual(['Acme', 'found@x.ru']);
  });

  it('сохраняет порядок: исходные сначала, найденные потом', () => {
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['alpha@x.ru', 'beta@y.ru'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[1][0]).toBe('alpha@x.ru, beta@y.ru'); // alpha (orig) ПЕРВЫМ
  });

  it('сохраняет другие колонки нетронутыми', () => {
    const data = [
      ['Компания', 'Сайт', 'Email', FOUND_EMAIL_COL, 'Описание'],
      ['Acme', 'acme.com', 'a@x.ru', 'b@x.ru', 'Делает виджеты'],
      ['Beta', 'beta.io', '', 'c@y.ru', 'Кофе'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[0]).toEqual(['Компания', 'Сайт', 'Email', 'Описание']);
    expect(out[1]).toEqual(['Acme', 'acme.com', 'a@x.ru, b@x.ru', 'Делает виджеты']);
    expect(out[2]).toEqual(['Beta', 'beta.io', 'c@y.ru', 'Кофе']);
  });

  it('игнорирует мусор который не выглядит как email', () => {
    // Если в колонке вместо email строка типа «не указан» — она просто не
    // матчится EMAIL_RE и пропадает. Это OK поведение: validate всё равно
    // её отфильтровал бы как невалидный email.
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['не указан', 'real@x.ru'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out[1][0]).toBe('real@x.ru');
  });
});
