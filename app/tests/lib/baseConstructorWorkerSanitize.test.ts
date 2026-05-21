/**
 * @jest-environment node
 *
 * Контракты sanitizeRowsForJsonb — защита от двух типов мусора, на которых
 * PostgREST падает с PGRST102 «Empty or invalid json» и весь job уходит
 * в failed (production bug job 6b7b0bb4 + жалоба специалиста на 3к/8к базы).
 *
 *   1. Control chars (NUL, LS, PS, FFFE/FFFF и т.д., кроме \t/\n/\r).
 *   2. Непарные UTF-16 суррогаты — \uD800..\uDFFF без партнёра. Возникают
 *      от String#slice/substring посреди surrogate pair'а (типичный случай:
 *      `text.slice(0, 2000)` для скрапленного описания с эмодзи).
 *
 * Эти тесты ловят регресс если кто-то вернёт «упрощённый» regex-санитайзер
 * без обработки суррогатов — это была прошлая реализация и она пропускала
 * битые эмодзи дальше в PostgREST.
 */

// supabaseAdmin импортируется на module-level в baseConstructorWorker —
// мокаем чтобы при импорте sanitizer'a не пытались ходить в БД.
jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => ({}) },
}));

import { sanitizeRowsForJsonb } from '@/lib/tools/baseConstructorWorker';

// Через \u-escape'ы JS вычисляет нужные кодпоинты в runtime'е, в исходнике
// не остаётся литеральных NUL/LS/PS/orphan-суррогатов (редакторы их теряют,
// git diff показывает как <U+0000>, etc).
const NUL = '\u0000';
const LS = '\u2028';
const PS = '\u2029';
const HIGH = '\uD83D'; // high surrogate половинка от 😀
const LOW = '\uDE00'; // low surrogate половинка от 😀
const EMOJI_SMILE = '😀'; // полное 😀
const EMOJI_ROCKET = '🚀'; // 🚀

describe('sanitizeRowsForJsonb', () => {
  it('keeps clean ASCII/Cyrillic rows untouched', () => {
    const rows = [
      ['Компания', 'Сайт', 'Описание'],
      ['ООО Ромашка', 'romashka.ru', 'Производит цветы для офисов'],
      ['LLC Example', 'example.com', 'Sells widgets'],
    ];
    const out = sanitizeRowsForJsonb(rows);
    expect(out).toEqual(rows);
  });

  it('keeps valid emoji surrogate pairs intact (no false positives)', () => {
    const rows = [
      ['Описание'],
      [`Наш продукт ${EMOJI_SMILE} быстрее ${EMOJI_ROCKET} конкурентов`],
    ];
    const out = sanitizeRowsForJsonb(rows);
    expect(out[1][0]).toContain(EMOJI_SMILE);
    expect(out[1][0]).toContain(EMOJI_ROCKET);
    // Длина не изменилась — пары валидны, ничего не вырезали.
    expect(out[1][0].length).toBe(rows[1][0].length);
  });

  it('strips NUL bytes (PostgreSQL refuses them in jsonb)', () => {
    const rows = [['col'], [`prefix${NUL}suffix`]];
    const out = sanitizeRowsForJsonb(rows);
    expect(out[1][0]).toBe('prefixsuffix');
  });

  it('strips LS/PS separators (U+2028/U+2029) that PostgREST chokes on', () => {
    const rows = [['col'], [`line1${LS}line2${PS}line3`]];
    const out = sanitizeRowsForJsonb(rows);
    expect(out[1][0]).toBe('line1line2line3');
  });

  it('replaces a lone high surrogate (cut at the start of a pair) with a space', () => {
    // 😀 = HIGH+LOW. Срезаем после HIGH — типичная картина от `slice(0, N)`
    // где N попало посреди пары.
    const cut = `Компания ${HIGH}`;
    const rows = [['col'], [cut]];
    const out = sanitizeRowsForJsonb(rows);
    expect(out[1][0]).toBe('Компания  '); // HIGH → пробел
    expect(out[1][0].includes(HIGH)).toBe(false);
  });

  it('replaces a lone low surrogate (orphan tail) with a space', () => {
    const orphan = `${LOW} в начале`;
    const rows = [['col'], [orphan]];
    const out = sanitizeRowsForJsonb(rows);
    expect(out[1][0]).toBe('  в начале'); // LOW → пробел
    expect(out[1][0].includes(LOW)).toBe(false);
  });

  it('handles mixed bag: ctl + valid emoji + orphan surrogate in one cell', () => {
    const messy = `pre${NUL}ok ${EMOJI_SMILE} valid then ${HIGH} orphan`;
    const rows = [['col'], [messy]];
    const out = sanitizeRowsForJsonb(rows);
    // NUL ушёл, valid pair остался, orphan HIGH → пробел.
    expect(out[1][0]).toBe(`preok ${EMOJI_SMILE} valid then   orphan`);
  });

  it('passes non-string cells through unchanged', () => {
    // jsonb принимает числа/булевы напрямую — санитайзер не должен их кастить.
    const rows: unknown[][] = [['col'], [42, true, null]];
    const out = sanitizeRowsForJsonb(rows as string[][]);
    expect(out[1][0]).toBe(42);
    expect(out[1][1]).toBe(true);
    expect(out[1][2]).toBe(null);
  });

  it('result must JSON.stringify roundtrip cleanly (PGRST102 regression)', () => {
    // Финальный smoke: ровно то что делает persistData — JSON.stringify
    // санитизированных rows. Если орфан-суррогаты не вычищены, HTTP-передача
    // в PostgREST падает с «Empty or invalid json». Здесь проверяем что
    // после санитайзера результат stringify'ится и парсится обратно эквивалентно.
    const dirty = [
      ['col'],
      [`mid ${HIGH} orphan`],
      [`mid ${LOW} orphan`],
      [`ok ${EMOJI_SMILE} ok`],
    ];
    const clean = sanitizeRowsForJsonb(dirty);
    const json = JSON.stringify(clean);
    expect(JSON.parse(json)).toEqual(clean);
  });

  it('preserves \\t, \\n, \\r — допустимые в jsonb whitespace-ы', () => {
    const rows = [['col'], ['tab\there\nnewline\rcarriage']];
    const out = sanitizeRowsForJsonb(rows);
    expect(out[1][0]).toBe('tab\there\nnewline\rcarriage');
  });
});
