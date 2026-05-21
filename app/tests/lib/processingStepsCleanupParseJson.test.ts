/**
 * @jest-environment node
 *
 * Контракты parseCleanupResponseJson — основного JSON-mode парсера cleanup.
 *
 * После перехода `stepNameCleanup` на `response_format: json_object` модель
 * обязана вернуть JSON со структурой {cleaned: [{idx, name}, ...]}. Эти
 * тесты закрепляют:
 *   - чистый JSON парсится корректно;
 *   - markdown-обёртка (```json ... ```) — salvage'ится;
 *   - мусор/частичный ответ не падает, а возвращает что есть или null;
 *   - safety stripNumberPrefix всё равно работает (вдруг AI вшил «1. » в name);
 *   - idx 0-based в JSON транслируется в idx+1 в map (совпадает с lookup'ом
 *     в stepNameCleanup: cleanedMap.get(i + 1)).
 */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => ({}) },
}));

import { parseCleanupResponseJson } from '@/lib/tools/processingSteps';

describe('parseCleanupResponseJson', () => {
  it('parses clean JSON object with cleaned array (the happy path)', () => {
    const content = JSON.stringify({
      cleaned: [
        { idx: 0, name: 'Apple' },
        { idx: 1, name: 'Microsoft' },
        { idx: 2, name: 'Google' },
      ],
    });
    const result = parseCleanupResponseJson(content);
    expect(result).not.toBeNull();
    // idx 0 → key 1 (stepNameCleanup лукапит get(i+1)).
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
    expect(result!.get(3)).toBe('Google');
    expect(result!.size).toBe(3);
  });

  it('salvages JSON wrapped in markdown code fence (```json ... ```)', () => {
    const content = '```json\n' + JSON.stringify({
      cleaned: [
        { idx: 0, name: 'Apple' },
        { idx: 1, name: 'Microsoft' },
      ],
    }) + '\n```';
    const result = parseCleanupResponseJson(content);
    expect(result).not.toBeNull();
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
  });

  it('salvages plain ``` fence без языка', () => {
    const content = '```\n' + JSON.stringify({
      cleaned: [{ idx: 0, name: 'Apple' }],
    }) + '\n```';
    const result = parseCleanupResponseJson(content);
    expect(result).not.toBeNull();
    expect(result!.get(1)).toBe('Apple');
  });

  it('salvages JSON object surrounded by garbage prose', () => {
    // Модель проигнорила response_format и накидала вступления.
    const content =
      'Вот очищенные названия:\n' +
      JSON.stringify({ cleaned: [{ idx: 0, name: 'Apple' }] }) +
      '\nГотово.';
    const result = parseCleanupResponseJson(content);
    expect(result).not.toBeNull();
    expect(result!.get(1)).toBe('Apple');
  });

  it('strips lingering number prefix in name as safety net («1. Apple» → «Apple»)', () => {
    // AI поленился и вшил префикс в name даже в JSON. Safety net срабатывает.
    const content = JSON.stringify({
      cleaned: [
        { idx: 0, name: '1. Apple' },
        { idx: 1, name: '2) Microsoft' },
        { idx: 2, name: '10. 11. NestedName' },
      ],
    });
    const result = parseCleanupResponseJson(content);
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
    expect(result!.get(3)).toBe('NestedName');
  });

  it('handles partial response (AI вернул не все элементы)', () => {
    // Из 5 запрошенных вернулось 3. Map содержит только эти 3 — stepNameCleanup
    // не обновит остальные строки (оставит оригиналы).
    const content = JSON.stringify({
      cleaned: [
        { idx: 0, name: 'Apple' },
        { idx: 2, name: 'Google' },
        { idx: 4, name: 'Amazon' },
      ],
    });
    const result = parseCleanupResponseJson(content);
    expect(result!.size).toBe(3);
    expect(result!.get(1)).toBe('Apple');
    expect(result!.has(2)).toBe(false);
    expect(result!.get(3)).toBe('Google');
    expect(result!.has(4)).toBe(false);
    expect(result!.get(5)).toBe('Amazon');
  });

  it('skips items with missing/invalid idx or name', () => {
    const content = JSON.stringify({
      cleaned: [
        { idx: 0, name: 'Apple' },
        { name: 'NoIdx' }, // нет idx
        { idx: 'two', name: 'StringIdx' }, // idx не число
        { idx: -1, name: 'NegativeIdx' }, // отрицательный idx
        { idx: 2.5, name: 'FractionalIdx' }, // не целое
        { idx: 3, name: '' }, // пустое имя
        { idx: 4, name: 123 }, // не строка
        { idx: 5, name: 'Valid' },
      ],
    });
    const result = parseCleanupResponseJson(content);
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(6)).toBe('Valid');
    expect(result!.size).toBe(2); // остальные отброшены
  });

  it('returns null on completely garbage content', () => {
    expect(parseCleanupResponseJson('')).toBeNull();
    expect(parseCleanupResponseJson('not json at all')).toBeNull();
    expect(parseCleanupResponseJson('{"wrong_key": []}')).toBeNull();
  });

  it('returns null if cleaned is not an array', () => {
    expect(parseCleanupResponseJson('{"cleaned": "string"}')).toBeNull();
    expect(parseCleanupResponseJson('{"cleaned": 42}')).toBeNull();
    expect(parseCleanupResponseJson('{"cleaned": null}')).toBeNull();
  });

  it('returns null if cleaned is empty array (nothing to apply)', () => {
    expect(parseCleanupResponseJson('{"cleaned": []}')).toBeNull();
  });

  it('handles large batch (100 items) without losing any', () => {
    // Реальный размер батча в production — CLEANUP_BATCH=100. Smoke test
    // что parser не теряет элементы и не падает на полном объёме.
    const items = Array.from({ length: 100 }, (_, k) => ({
      idx: k,
      name: `Company${k}`,
    }));
    const content = JSON.stringify({ cleaned: items });
    const result = parseCleanupResponseJson(content);
    expect(result!.size).toBe(100);
    expect(result!.get(1)).toBe('Company0');
    expect(result!.get(100)).toBe('Company99');
  });

  it('trims whitespace in name', () => {
    const content = JSON.stringify({
      cleaned: [
        { idx: 0, name: '  Apple  ' },
        { idx: 1, name: '\tMicrosoft\n' },
      ],
    });
    const result = parseCleanupResponseJson(content);
    expect(result!.get(1)).toBe('Apple');
    expect(result!.get(2)).toBe('Microsoft');
  });

  it('user bug regression: even if AI returned repeated idx values, last wins (no leak)', () => {
    // Предыдущий баг был про positional fallback в text-mode. В JSON-mode
    // если AI повторил один idx — последний перетирает предыдущие, и в map
    // окажется одна запись с этим ключом. НЕ происходит «леака» цифры
    // в начало нерелевантной строки (которая случилась бы в text-fallback).
    const content = JSON.stringify({
      cleaned: [
        { idx: 0, name: 'A' },
        { idx: 0, name: 'B' }, // тот же idx
        { idx: 0, name: 'C' }, // тот же idx
      ],
    });
    const result = parseCleanupResponseJson(content);
    expect(result!.size).toBe(1);
    expect(result!.get(1)).toBe('C'); // последняя выиграла
    // Главное: rows 2 и 3 НЕ получили мусорные значения с префиксом «10. ...».
    expect(result!.has(2)).toBe(false);
    expect(result!.has(3)).toBe(false);
  });
});
