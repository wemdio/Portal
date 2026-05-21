/**
 * @jest-environment node
 *
 * Контракты parseCleanupResponse — парсера AI-ответа в stepNameCleanup.
 *
 * Жалоба специалиста: «когда жмешь очистить названия, в рандомных компаниях
 * появляются цифры в начале». Источник — positional fallback пути, где
 * raw allLines[j] (с префиксом «N. ») лили в БД когда <80% строк нумерованы.
 * Эти тесты закрепляют: stripNumberPrefix применяется ВО ВСЕХ режимах.
 */

// Мокаем supabaseAdmin: processingSteps его не использует напрямую, но
// модуль импортируется как часть цепочки.
jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => ({}) },
}));

import { parseCleanupResponse } from '@/lib/tools/processingSteps';

describe('parseCleanupResponse', () => {
  it('strict mode: clean numbered list parsed into row → name map', () => {
    const content = ['1. Apple', '2. Microsoft', '3. Google'].join('\n');
    const result = parseCleanupResponse(content, 3);
    expect(result).not.toBeNull();
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
    expect(result!.get(3)).toBe('Google');
    expect(result!.size).toBe(3);
  });

  it('strict mode: handles N) parenthesis format too', () => {
    const content = ['1) Apple', '2) Microsoft', '3) Google'].join('\n');
    const result = parseCleanupResponse(content, 3);
    expect(result).not.toBeNull();
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
    expect(result!.get(3)).toBe('Google');
  });

  it('strict mode: strips nested prefixes («1. 10. Name» → «Name»)', () => {
    // Модель иногда оборачивает оригинал с уже-существующим номером:
    // input «1. 10. ПК ЗВМП» → output «1. 10. ПК ЗВМП». Надо стрипать ОБА.
    const content = ['1. 10. ПК ЗВМП', '2. 11. Полиазрные', '3. Apple'].join('\n');
    const result = parseCleanupResponse(content, 3);
    expect(result!.get(1)).toBe('ПК ЗВМП');
    expect(result!.get(2)).toBe('Полиазрные');
    expect(result!.get(3)).toBe('Apple');
  });

  it('strict mode: ignores junk header lines like «Очищенные названия:»', () => {
    // Иногда модель добавляет преамбулу. Она в numbered не попадёт
    // (нет «N.» префикса), но cleanLines её включит — это нормально пока
    // strict-режим срабатывает (numbered.size >= 0.8 * expected).
    const content = ['Очищенные названия:', '1. Apple', '2. Microsoft', '3. Google'].join('\n');
    const result = parseCleanupResponse(content, 3);
    // strict mode сработал, 3 numbered из expected 3 (преамбула не учитывается в numbered).
    expect(result!.size).toBe(3);
    expect(result!.get(1)).toBe('Apple');
  });

  it('positional fallback: repeated numbers (the user bug) → prefix stripped', () => {
    // Конкретно жалоба специалиста: AI вернул один и тот же номер для всех
    // строк (10. A, 10. B, 10. C). numbered содержит только одну запись
    // (последняя перетёрла предыдущие), 1 < 3*0.8 → positional fallback.
    // Раньше fallback бы вернул «10. A», «10. B», «10. C» с префиксами.
    // Теперь префикс стрипается одинаково в обоих режимах.
    const content = ['10. ПК ЗВМП', '10. Полиазрные', '10. Сарсенбаева'].join('\n');
    const result = parseCleanupResponse(content, 3);
    expect(result).not.toBeNull();
    expect(result!.get(1)).toBe('ПК ЗВМП');
    expect(result!.get(2)).toBe('Полиазрные');
    expect(result!.get(3)).toBe('Сарсенбаева');
  });

  it('positional fallback: lines without prefix kept as-is (no spurious changes)', () => {
    // Модель забыла нумеровать, просто вывалила список. Positional fallback,
    // префикса нет → строка не меняется.
    const content = ['Apple', 'Microsoft', 'Google'].join('\n');
    const result = parseCleanupResponse(content, 3);
    expect(result).not.toBeNull();
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
    expect(result!.get(3)).toBe('Google');
  });

  it('positional fallback: mixed numbered + unnumbered lines, prefix stripped on numbered', () => {
    const content = ['1. Apple', 'Microsoft', '3. Google'].join('\n');
    // 2 of 3 numbered → 2 < 0.8 * 3 = 2.4 → fallback. Все строки
    // стрипаются префиксом.
    const result = parseCleanupResponse(content, 3);
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
    expect(result!.get(3)).toBe('Google');
  });

  it('returns null on empty response', () => {
    expect(parseCleanupResponse('', 5)).toBeNull();
    expect(parseCleanupResponse('\n\n\n', 5)).toBeNull();
  });

  it('skips lines that consist only of a prefix («1.» с пустым телом)', () => {
    // Модель вывалила «1.» без названия — это мусор, в positional не должен
    // занять позицию (иначе сдвинет всех остальных).
    const content = ['1.', '2. Apple', '3. Microsoft'].join('\n');
    const result = parseCleanupResponse(content, 3);
    // strict mode: numbered.size — какое получится. «1.» с пустым телом
    // не попадает в numbered (cleaned === '' → skip). Итого: numbered = {2:Apple, 3:Microsoft}.
    // 2 >= 0.8*3=2.4? Нет, 2 < 2.4 → fallback. cleanLines = [Apple, Microsoft].
    // positional: {1:Apple, 2:Microsoft}.
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
    expect(result!.has(3)).toBe(false);
  });

  it('does NOT confuse decimal numbers in body («Цена 5.99») with prefix', () => {
    // «Цена 5.99» начинается не с числа+точки, а с буквы. Префикс не стрипается.
    const content = ['1. Цена 5.99', '2. Версия 2.0', '3. PI 3.14'].join('\n');
    const result = parseCleanupResponse(content, 3);
    expect(result!.get(1)).toBe('Цена 5.99');
    expect(result!.get(2)).toBe('Версия 2.0');
    expect(result!.get(3)).toBe('PI 3.14');
  });

  it('handles N >= 100 (3-digit prefixes)', () => {
    const content = ['100. Apple', '101. Microsoft'].join('\n');
    const result = parseCleanupResponse(content, 2);
    expect(result!.get(100)).toBe('Apple');
    expect(result!.get(101)).toBe('Microsoft');
  });

  it('strict mode: extra lines beyond expectedCount are not silently dropped — they go in by number key', () => {
    // AI вернул на 1 больше, чем спросили. Лишний 4. Extra попадёт
    // в numbered (с ключом 4), но stepNameCleanup потом смотрит только
    // get(i+1) до chunk.length, так что extra не повредит.
    const content = ['1. A', '2. B', '3. C', '4. Extra'].join('\n');
    const result = parseCleanupResponse(content, 3);
    expect(result!.size).toBe(4); // все попали
    expect(result!.get(4)).toBe('Extra'); // но stepNameCleanup до 4 не дойдёт
  });

  it('positional fallback truncates to expectedCount (AI hallucinated extra rows)', () => {
    // AI вывалил 10 строк когда просили 3. В positional fallback берём
    // только первые expectedCount.
    const content = Array.from({ length: 10 }, (_, k) => `Row${k + 1}`).join('\n');
    const result = parseCleanupResponse(content, 3);
    expect(result!.size).toBe(3);
    expect(result!.get(1)).toBe('Row1');
    expect(result!.get(2)).toBe('Row2');
    expect(result!.get(3)).toBe('Row3');
    expect(result!.has(4)).toBe(false);
  });
});
