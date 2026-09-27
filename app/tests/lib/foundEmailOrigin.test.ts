/**
 * @jest-environment node
 *
 * Происхождение адресов для validate_target 'original' | 'found' (см.
 * baseConstructorWorkerValidateTarget.test.ts — сквозной контракт).
 * Здесь — граничные случаи: ячейки с несколькими адресами без split,
 * битая служебная колонка, режимы VE2 и дефолты, которые не должны
 * включать учёт происхождения.
 */

jest.mock('@/lib/emailValidation/validator', () => ({
  validateEmail: jest.fn(),
}));

import { validateEmail } from '@/lib/emailValidation/validator';
import { stepSplitEmails, stepValidateEmails } from '@/lib/tools/processingSteps';
import { mergeFoundEmailColumn } from '@/lib/tools/baseConstructorWorker';
import { FOUND_EMAIL_ORIGIN_COL } from '@/lib/tools/baseConstructorCheckpoint';
import {
  compactFoundEmailOrigins,
  parseFoundEmailOrigin,
  shouldTrackFoundEmailOrigin,
} from '@/lib/tools/foundEmailOrigin';

const noopProgress = async () => {};

const STATUS: Record<string, string> = {
  'orig@a.com': 'ok',
  'good@a.com': 'ok',
  'bad@a.com': 'invalid',
};

beforeEach(() => {
  (validateEmail as jest.Mock).mockReset();
  (validateEmail as jest.Mock).mockImplementation(async (email: string) => ({
    result: STATUS[email] ?? 'unknown', is_free: false, is_catch_all: false, error: '',
  }));
});

describe('shouldTrackFoundEmailOrigin', () => {
  const E = { validate_target_explicit: true };
  it.each([
    [{ ...E, validate_target: 'found' }, true],
    [{ ...E, validate_target: 'original' }, true],
    [{ ...E, validate_target: 'found', find_emails: { merge_mode: 'all' } }, true],
    [{ ...E, validate_target: 'both' }, false],
    [{ ...E }, false],
    [{}, false],
    // Старый UI всегда слал 'original' без метки — проверяем всё, как раньше.
    [{ validate_target: 'original' }, false],
    // 'found' по умолчанию не бывал — осознанный выбор и без метки.
    [{ validate_target: 'found' }, true],
    [{ ...E, validate_target: 'found', find_emails: { merge_mode: 'prefer_found' } }, false],
    [{ ...E, validate_target: 'found', find_emails: { merge_mode: 'prefer_found_validated' } }, false],
  ])('%j → %p', (cfg, expected) => {
    expect(shouldTrackFoundEmailOrigin(cfg)).toBe(expected);
  });
});

describe('mergeFoundEmailColumn + trackFoundOrigin', () => {
  const data = [
    ['компания', 'email', 'Найденный Email'],
    ['A', 'orig@a.com', 'Good@a.com, orig@a.com'],
    ['B', 'b@b.com', ''],
  ];

  it('пишет адреса, пришедшие ТОЛЬКО со скрейпа; общий с исходной — исходный', () => {
    const out = mergeFoundEmailColumn(data, 'ru', 'all', { trackFoundOrigin: true });
    expect(out[0]).toEqual(['компания', 'email', FOUND_EMAIL_ORIGIN_COL]);
    expect(out[1]).toEqual(['A', 'orig@a.com, Good@a.com', '["good@a.com"]']);
    expect(out[2]).toEqual(['B', 'b@b.com', '[]']);
  });

  it('без опции — прежний результат, колонки нет', () => {
    expect(mergeFoundEmailColumn(data, 'ru', 'all')[0]).toEqual(['компания', 'email']);
  });

  it('режимы VE2 опцию игнорируют', () => {
    const out = mergeFoundEmailColumn(data, 'ru', 'prefer_found', { trackFoundOrigin: true });
    expect(out[0]).not.toContain(FOUND_EMAIL_ORIGIN_COL);
  });

  it('строка длиннее заголовка (лишний разделитель в CSV) — ячейка встаёт в свою колонку', () => {
    const out = mergeFoundEmailColumn(
      [['компания', 'email', 'Найденный Email'], ['A', 'orig@a.com', 'good@a.com', '']],
      'ru', 'all', { trackFoundOrigin: true },
    );
    const originIdx = out[0].indexOf(FOUND_EMAIL_ORIGIN_COL);
    expect(out[1][originIdx]).toBe('["good@a.com"]');
  });

  it('адрес из исходной колонки ЛЮБОЙ строки считается исходным', () => {
    const out = mergeFoundEmailColumn(
      [['компания', 'email', 'Найденный Email'], ['A', 'shared@x.com', ''], ['B', '', 'shared@x.com, sales@b.com']],
      'ru', 'all', { trackFoundOrigin: true },
    );
    expect(out[2][2]).toBe('["sales@b.com"]');
  });

  it('колонка происхождения уже есть — повторное слияние дополняет её', () => {
    const out = mergeFoundEmailColumn(
      [
        ['компания', 'email', FOUND_EMAIL_ORIGIN_COL, 'Найденный Email'],
        ['A', 'orig@a.com, early@a.com', '["early@a.com"]', 'late@a.com, early@a.com, orig@a.com'],
      ],
      'ru', 'all', { trackFoundOrigin: true },
    );
    expect(out[0]).toEqual(['компания', 'email', FOUND_EMAIL_ORIGIN_COL]);
    expect(parseFoundEmailOrigin(out[1][2])).toEqual(new Set(['early@a.com', 'late@a.com']));
  });

  it('нет исходной колонки — все адреса со скрейпа', () => {
    const out = mergeFoundEmailColumn(
      [['компания', 'Найденный Email'], ['A', 'x@a.com, y@a.com']], 'ru', 'all', { trackFoundOrigin: true },
    );
    expect(out[0]).toEqual(['компания', 'Email', FOUND_EMAIL_ORIGIN_COL]);
    expect(parseFoundEmailOrigin(out[1][2])).toEqual(new Set(['x@a.com', 'y@a.com']));
  });
});

describe('split_emails сжимает происхождение до адреса строки', () => {
  it('у найденного адреса — [адрес], у исходного — []', async () => {
    const merged = mergeFoundEmailColumn(
      [['компания', 'email', 'Найденный Email'], ['A', 'orig@a.com', 'good@a.com']], 'ru', 'all', { trackFoundOrigin: true },
    );
    const split = await stepSplitEmails(merged, noopProgress);
    expect(split.slice(1).map((r) => [r[1], r[2]])).toEqual([
      ['orig@a.com', '[]'],
      ['good@a.com', '["good@a.com"]'],
    ]);
  });

  it('без колонки — no-op', () => {
    const d = [['email'], ['a@a.com']];
    expect(compactFoundEmailOrigins(d)).toBe(d);
  });
});

describe('stepValidateEmails по источнику без split (несколько адресов в ячейке)', () => {
  const cell = (found: string[]) => [
    ['компания', 'email', FOUND_EMAIL_ORIGIN_COL],
    ['A', 'orig@a.com, good@a.com, bad@a.com', JSON.stringify(found)],
  ];

  it("'found': невалидный найденный удалён, исходный остаётся непроверенным", async () => {
    const out = await stepValidateEmails(cell(['good@a.com', 'bad@a.com']), noopProgress, undefined, { validateTarget: 'found' });
    expect((validateEmail as jest.Mock).mock.calls.map((c) => c[0]).sort()).toEqual(['bad@a.com', 'good@a.com']);
    const header = out[0];
    expect(header).not.toContain(FOUND_EMAIL_ORIGIN_COL);
    expect(out[1][header.indexOf('email')]).toBe('orig@a.com, good@a.com');
    expect(out[1][header.indexOf('email Статус')]).toBe('ok');
  });

  it("'found': все найденные невалидны — строка остаётся с исходным, статус очищен", async () => {
    const out = await stepValidateEmails(
      [['компания', 'email', FOUND_EMAIL_ORIGIN_COL], ['A', 'orig@a.com, bad@a.com', '["bad@a.com"]']],
      noopProgress, undefined, { validateTarget: 'found' },
    );
    expect(out).toHaveLength(2);
    expect(out[1][out[0].indexOf('email')]).toBe('orig@a.com');
    expect(out[1][out[0].indexOf('email Статус')]).toBe('');
  });

  it('битая ячейка происхождения — проверяется всё (безопасный откат)', async () => {
    const data = [['компания', 'email', FOUND_EMAIL_ORIGIN_COL], ['A', 'orig@a.com, bad@a.com', 'not-json']];
    const out = await stepValidateEmails(data, noopProgress, undefined, { validateTarget: 'found' });
    expect((validateEmail as jest.Mock).mock.calls.map((c) => c[0]).sort()).toEqual(['bad@a.com', 'orig@a.com']);
    expect(out[1][out[0].indexOf('email')]).toBe('orig@a.com');
  });

  it("'both' колонку происхождения игнорирует — проверяется всё", async () => {
    await stepValidateEmails(cell(['good@a.com', 'bad@a.com']), noopProgress, undefined, { validateTarget: 'both' });
    expect((validateEmail as jest.Mock).mock.calls).toHaveLength(3);
  });
});
