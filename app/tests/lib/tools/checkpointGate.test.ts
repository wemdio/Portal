/** @jest-environment node */

/**
 * Когда шаг конструктора сохраняет промежуточный результат.
 *
 * 12.08.2026: база в 6602 строки, шаг «Найти Email» доходил до 3% и падал в
 * ноль, снова до 3% и снова в ноль — бесконечно. Механизм resume работал
 * исправно, восстанавливать было нечего: чекпоинт писался раз в 250 строк, а
 * 250 строк от 6602 — это 3.8%, до которых задача не доживала. Ни одной записи
 * за весь прогон.
 *
 * Отсюда свойство, которое тесты и держат: чем больше база, тем меньше должен
 * значить счётчик строк, и тем важнее время.
 */

import {
  makeCheckpointGate,
  DEFAULT_CHECKPOINT_EVERY_ROWS,
} from '@/lib/tools/checkpointGate';

/** Управляемые часы: тест не должен зависеть от реального времени. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('makeCheckpointGate', () => {
  it('пишет по счётчику строк, как раньше', () => {
    const c = clock();
    const gate = makeCheckpointGate({ everyRows: 250, intervalMs: 60_000, now: c.now });

    expect(gate(1, false)).toBe(false);
    expect(gate(249, false)).toBe(false);
    expect(gate(250, false)).toBe(true);
    expect(gate(251, false)).toBe(false);
    expect(gate(500, false)).toBe(true);
  });

  /** Тот самый случай: до 250-й строки дело не доходит. */
  it('пишет по времени, не дожидаясь счётчика строк', () => {
    const c = clock();
    const gate = makeCheckpointGate({ everyRows: 250, intervalMs: 60_000, now: c.now });

    for (let done = 1; done <= 100; done++) expect(gate(done, false)).toBe(false);

    c.advance(60_000);
    expect(gate(101, false)).toBe(true);
    // после записи таймер сброшен
    expect(gate(102, false)).toBe(false);
  });

  it('после срабатывания по строкам таймер тоже сбрасывается — двойной записи нет', () => {
    const c = clock();
    const gate = makeCheckpointGate({ everyRows: 250, intervalMs: 60_000, now: c.now });

    c.advance(59_000);
    expect(gate(250, false)).toBe(true);
    c.advance(30_000);
    expect(gate(251, false)).toBe(false); // с прошлой записи прошло 30с, не 60
    c.advance(30_000);
    expect(gate(252, false)).toBe(true);
  });

  it('последнюю строку сохраняем всегда — следующего шанса не будет', () => {
    const c = clock();
    const gate = makeCheckpointGate({ everyRows: 250, intervalMs: 60_000, now: c.now });
    expect(gate(7, true)).toBe(true);
  });

  it('нулевой строкой чекпоинт не провоцируется', () => {
    const c = clock();
    const gate = makeCheckpointGate({ everyRows: 250, intervalMs: 60_000, now: c.now });
    expect(gate(0, false)).toBe(false);
  });

  it('мусорные настройки не превращают гейт в запись на каждой строке', () => {
    const c = clock();
    const gate = makeCheckpointGate({ everyRows: 0, intervalMs: 0, now: c.now });
    // everyRows зажат в 1 — по строкам пишем всегда; интервал зажат снизу,
    // чтобы «0 мс» не означало «на каждой итерации по таймеру».
    expect(gate(1, false)).toBe(true);
    expect(gate(2, false)).toBe(true);
  });

  it('дефолт по строкам остался прежним', () => {
    expect(DEFAULT_CHECKPOINT_EVERY_ROWS).toBe(250);
  });

  /**
   * Свойство, ради которого всё делалось: на большой базе первый чекпоинт
   * приходит по времени задолго до 250-й строки.
   */
  it('на базе 6602 строки первая запись случается сильно раньше 3.8%', () => {
    const c = clock();
    const gate = makeCheckpointGate({ now: c.now });

    let firstAt: number | null = null;
    for (let done = 1; done <= 250; done++) {
      c.advance(1_000); // строка в секунду — реальный темп скрапа
      if (gate(done, false) && firstAt === null) firstAt = done;
    }

    expect(firstAt).not.toBeNull();
    expect(firstAt!).toBeLessThan(250);
    expect(firstAt! / 6602).toBeLessThan(0.02);
  });
});
