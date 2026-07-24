/**
 * @jest-environment node
 *
 * Контракты качества stepValidateEmails (base-constructor):
 *   1. Идемпотентность: повторный запуск НЕ дублирует колонки «… Статус»/
 *      «… Провайдер», строки с финальным вердиктом (ok/invalid/disposable/
 *      catch_all) пропускаются, ''/unknown/error — перевалидируются.
 *   2. Мемоизация: дубли email'а в базе → одна SMTP-проба (validateEmail).
 *   3. Round-robin по доменам: пробы интерливятся, а не бьют бурстом в один MX.
 *   4. Мульти-email ячейки: валидируется каждый адрес, в статус пишется лучший,
 *      при чистке выкидываются только плохие адреса (живые склеиваются ', ').
 *   5. Отмена посреди шага → throw 'Отменено' (а не полу-валидированная
 *      матрица, где непроверенные строки упали бы как «без email»).
 *   6. Отложенный второй проход: «временные» unknown/error (greylist и т.п.)
 *      перепроверяются один раз после паузы.
 *
 * Реальный SMTP не дёргаем — validateEmail мокается (как в
 * processingStepsEmailTargeting.test.ts).
 */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => ({}) },
}));

jest.mock('@/lib/emailValidation/validator', () => ({
  validateEmail: jest.fn(),
}));

import { validateEmail } from '@/lib/emailValidation/validator';
import { stepValidateEmails } from '@/lib/tools/processingSteps';

const noopProgress = async () => {};

beforeEach(() => {
  (validateEmail as jest.Mock).mockReset();
});

// Helper: маппинг email → вердикт (строка-статус или { result, error }).
const mockValidator = (
  mapping: Record<string, string | { result: string; error?: string }>,
) => {
  (validateEmail as jest.Mock).mockImplementation(async (email: string) => {
    const v = mapping[email.toLowerCase()] ?? 'invalid';
    const verdict = typeof v === 'string' ? { result: v } : v;
    return {
      result: verdict.result,
      is_free: false,
      is_catch_all: verdict.result === 'catch_all',
      error: 'error' in verdict ? verdict.error : undefined,
    };
  });
};

describe('stepValidateEmails — идемпотентность', () => {
  it('повторный запуск: нет дублей колонок, финальные строки пропущены, unknown перевалидирован', async () => {
    mockValidator({ 'fresh@b.ru': 'ok', 'retry@c.ru': 'ok' });
    const data = [
      ['Email', 'Email Статус', 'Email Провайдер'],
      ['done@a.ru', 'ok', 'a.ru'], // финальный вердикт → НЕ трогаем
      ['fresh@b.ru', '', ''], // пустой статус → валидируем
      ['retry@c.ru', 'unknown', 'c.ru'], // unknown → перевалидируем
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    // Колонки НЕ задвоились.
    expect(out[0]).toEqual(['Email', 'Email Статус', 'Email Провайдер']);
    // Проверялись только 2 строки (fresh + retry), done@a.ru — пропущена.
    expect(validateEmail).toHaveBeenCalledTimes(2);
    expect(validateEmail).not.toHaveBeenCalledWith('done@a.ru', expect.anything());
    // Все строки сохранились (ok/ok/ok).
    expect(out).toHaveLength(4);
    // done@a.ru: статус и провайдер из прошлого запуска нетронуты.
    expect(out[1][0]).toBe('done@a.ru');
    expect(out[1][1]).toBe('ok');
    expect(out[1][2]).toBe('a.ru');
    // fresh@b.ru: провалидирован, статус+провайдер записаны.
    expect(out[2][1]).toBe('ok');
    expect(out[2][2]).toBe('b.ru');
    // retry@c.ru: unknown → перевалидирован в ok.
    expect(out[3][1]).toBe('ok');
  });

  it('прогон вывода шага через самого себя — no-op (ни одной новой пробы)', async () => {
    // Сценарий «re-uploaded export»: юзер выгрузил результат и загрузил обратно.
    mockValidator({ 'a@x.ru': 'ok', 'b@y.ru': 'catch_all' });
    const data = [
      ['Email'],
      ['a@x.ru'],
      ['b@y.ru'],
    ];
    const first = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    expect(first[0]).toEqual(['Email', 'Email Статус', 'Email Провайдер']);
    expect(validateEmail).toHaveBeenCalledTimes(2);

    (validateEmail as jest.Mock).mockClear();
    const second = await stepValidateEmails(first, noopProgress, undefined, {
      validateTarget: 'original',
    });
    // Одна пара колонок, ни одной повторной SMTP-пробы, строки на месте.
    expect(second[0]).toEqual(['Email', 'Email Статус', 'Email Провайдер']);
    expect(validateEmail).not.toHaveBeenCalled();
    expect(second).toHaveLength(3);
  });
});

describe('stepValidateEmails — мемоизация и порядок проб', () => {
  it('дубли адреса (в т.ч. внутри одной ячейки) → одна SMTP-проба', async () => {
    mockValidator({ 'dup@x.ru': 'ok' });
    const data = [
      ['Email'],
      ['dup@x.ru'],
      ['dup@x.ru, dup@x.ru'], // дубль внутри ячейки
      ['dup@x.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    expect(validateEmail).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(4);
    expect(out[1][1]).toBe('ok');
    expect(out[2][1]).toBe('ok');
    expect(out[3][1]).toBe('ok');
  });

  it('round-robin по доменам: пробы интерливятся, а не идут бурстом по одному домену', async () => {
    const calls: string[] = [];
    (validateEmail as jest.Mock).mockImplementation(async (email: string) => {
      calls.push(email);
      return { result: 'ok', is_free: false, is_catch_all: false };
    });
    // Вход сгруппирован по доменам: 6 × alpha.ru, потом 6 × beta.ru.
    // Без round-robin первые 6 проб ушли бы в один MX alpha.ru.
    const rows = [['Email']];
    for (let i = 1; i <= 6; i += 1) rows.push([`a${i}@alpha.ru`]);
    for (let i = 1; i <= 6; i += 1) rows.push([`b${i}@beta.ru`]);
    await stepValidateEmails(rows, noopProgress, undefined, { validateTarget: 'original' });
    expect(validateEmail).toHaveBeenCalledTimes(12);
    const firstEightDomains = calls.slice(0, 8).map((e) => e.split('@')[1]);
    expect(firstEightDomains).toEqual([
      'alpha.ru', 'beta.ru', 'alpha.ru', 'beta.ru',
      'alpha.ru', 'beta.ru', 'alpha.ru', 'beta.ru',
    ]);
  });
});

describe('stepValidateEmails — мульти-email ячейки', () => {
  it('первый адрес мёртв, второй жив → ячейка оставляет живой, строка сохраняется', async () => {
    mockValidator({ 'dead@x.ru': 'invalid', 'live@y.ru': 'ok' });
    const data = [
      ['Email'],
      ['dead@x.ru, live@y.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    expect(out).toHaveLength(2); // строка НЕ вылетела
    expect(out[1][0]).toBe('live@y.ru'); // мёртвый выкинут, живой остался
    expect(out[1][1]).toBe('ok'); // в статус пишем лучший адрес
    expect(validateEmail).toHaveBeenCalledTimes(2); // оба адреса проверены
  });

  it('мёртвый + непроверяемый → живой-непроверяемый остаётся, статус unknown', async () => {
    mockValidator({ 'dead@x.ru': 'invalid', 'maybe@y.ru': 'unknown' });
    const data = [
      ['Email'],
      ['dead@x.ru, maybe@y.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    expect(out).toHaveLength(2);
    expect(out[1][0]).toBe('maybe@y.ru');
    expect(out[1][1]).toBe('unknown');
  });

  it('keepUnverifiable=false и все адреса плохие → ячейка обнуляется, строка вылетает', async () => {
    mockValidator({ 'bad@x.ru': 'invalid', 'maybe@y.ru': 'unknown' });
    const data = [
      ['Email'],
      ['bad@x.ru, maybe@y.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
      keepUnverifiable: false,
    });
    expect(out).toHaveLength(1); // только header
  });
});

describe('stepValidateEmails — отмена и второй проход', () => {
  it('отмена посреди шага → throw «Отменено» (а не полу-валидированная матрица)', async () => {
    mockValidator({ 'a@x.ru': 'ok', 'b@x.ru': 'ok' });
    const data = [
      ['Email'],
      ['a@x.ru'],
      ['b@x.ru'],
    ];
    await expect(
      stepValidateEmails(data, noopProgress, async () => true, { validateTarget: 'original' }),
    ).rejects.toThrow('Отменено');
  });

  it('«временный» unknown (greylist) → второй проход после паузы обновляет статус', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      (validateEmail as jest.Mock).mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return {
            result: 'unknown',
            is_free: false,
            is_catch_all: false,
            error: 'greylisting, try again later',
          };
        }
        return { result: 'ok', is_free: false, is_catch_all: false };
      });
      const data = [
        ['Email'],
        ['grey@x.ru'],
      ];
      // Пины против stuck-reaper регресса: до финала шага прогресс НЕ должен
      // достигать 100 (autoCompleteIfStuck завершает джоб на progress>=100),
      // а во время паузы идут heartbeat-прогрессы 99 (джоб «жив»).
      const progressCalls: number[] = [];
      const progress = async (p: number) => { progressCalls.push(p); };
      const promise = stepValidateEmails(data, progress, undefined, {
        validateTarget: 'original',
      });
      // Даём основному пулу завершиться (микротаски), чтобы шаг дошёл до паузы.
      for (let i = 0; i < 50; i += 1) await Promise.resolve();
      // Основной проход мгновенный → ждёт ~5 мин. Прокручиваем fake timers.
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
      const out = await promise;
      // Одна и та же проба повторилась один раз, статус обновился на ok.
      expect(validateEmail).toHaveBeenCalledTimes(2);
      expect(out).toHaveLength(2);
      expect(out[1][1]).toBe('ok');
      // Прогресс: 100 — только последним вызовом (после фильтра), до того максимум 99.
      expect(progressCalls[progressCalls.length - 1]).toBe(100);
      expect(Math.max(...progressCalls.slice(0, -1))).toBeLessThanOrEqual(99);
      // Heartbeat 99 во время 5-минутной паузы был (stale-detector видит живой джоб).
      expect(progressCalls.filter((p) => p === 99).length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('unknown БЕЗ «временного» текста → второго прохода нет (и нет 5-мин паузы)', async () => {
    // Тест идёт на реальных таймерах: если бы шаг встал в 5-мин паузу,
    // упал бы по jest-таймауту.
    mockValidator({ 'maybe@x.ru': 'unknown', 'ok@y.ru': 'ok' });
    const data = [
      ['Email'],
      ['maybe@x.ru'],
      ['ok@y.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    expect(validateEmail).toHaveBeenCalledTimes(2); // без повторных проб
    expect(out).toHaveLength(3);
    const unknownRow = out.find((r) => r[0] === 'maybe@x.ru')!;
    expect(unknownRow[1]).toBe('unknown');
  });
});
