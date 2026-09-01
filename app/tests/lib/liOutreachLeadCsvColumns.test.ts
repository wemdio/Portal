/** @jest-environment node */

/**
 * Разбор шапки CSV при импорте лидов LinkedIn.
 *
 * Импорт понимал ровно одно написание заголовка — `name`. Файл с колонкой
 * `Person` (обычная ручная таблица) или `Full Name` (выгрузка Sales Navigator)
 * проходил весь разбор и возвращал ноль импортированных: каждая строка
 * отбраковывалась как «нет имени». Со стороны оператора это выглядело как
 * «портал не принимает файл», и искал он проблему в данных, а не в шапке.
 */

import { resolveLeadCsvColumns } from '@/lib/liOutreach/leadHelpers';

describe('шапка CSV с лидами', () => {
  it('узнаёт человеческие названия колонок, а не только name', () => {
    const cols = resolveLeadCsvColumns(['Person', 'Компания', 'Profile URL', 'сайт']);
    expect(cols.name).toBe(0);
    expect(cols.company).toBe(1);
    expect(cols.profileUrl).toBe(2);
  });

  it('снимает BOM, который Excel ставит перед первым заголовком', () => {
    // Excel сохраняет UTF-8 CSV с меткой в начале файла, и первый заголовок
    // приезжает как `﻿name` — не совпадая ни с одним написанием.
    const cols = resolveLeadCsvColumns(['﻿name', 'company']);
    expect(cols.name).toBe(0);
  });

  it('отсутствие колонки — это -1, а не случайное совпадение', () => {
    const cols = resolveLeadCsvColumns(['name', 'profile_url']);
    expect(cols.company).toBe(-1);
    expect(cols.position).toBe(-1);
  });

  it('«Имя» и «Фамилия» разбираются как две колонки, а не как полное имя', () => {
    const cols = resolveLeadCsvColumns(['Имя', 'Фамилия', 'LinkedIn URL']);
    expect(cols.name).toBe(-1);
    expect(cols.firstName).toBe(0);
    expect(cols.lastName).toBe(1);
    expect(cols.profileUrl).toBe(2);
  });
});
