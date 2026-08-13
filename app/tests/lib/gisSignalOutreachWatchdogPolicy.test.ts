/** @jest-environment node */

jest.mock('server-only', () => ({}));

import {
  decideWatchdogAction,
  mskParts,
  MAX_RUNS_PER_DAY,
  WATCHDOG_GRACE_MS,
} from '@/lib/gisSignalOutreach/watchdogPolicy';

/** Момент по МСК → Date (Москва без DST, всегда +03:00). */
const msk = (iso: string): Date => new Date(`${iso}+03:00`);

/** Четверг 13.08.2026, 07:30 МСК — прогон должен идти, окно перезапуска открыто. */
const THU_0730 = msk('2026-08-13T07:30:00');

function run(id: string, startedMsk: string) {
  return { id, started_at: msk(startedMsk).toISOString() };
}

function input(over: Partial<Parameters<typeof decideWatchdogAction>[0]> = {}) {
  return {
    now: THU_0730,
    runningRuns: [],
    liveProcess: false,
    runsToday: 0,
    completedToday: 0,
    ...over,
  };
}

describe('mskParts', () => {
  it('считает московские сутки независимо от TZ процесса', () => {
    // 23:30 UTC = 02:30 МСК СЛЕДУЮЩИХ суток — наивный getHours дал бы прошлый день.
    const p = mskParts(new Date('2026-08-12T23:30:00Z'));
    expect(p.dateKey).toBe('2026-08-13');
    expect(p.minutes).toBe(2 * 60 + 30);
    expect(p.weekday).toBe(4); // четверг
  });

  it('полночь по Москве не превращается в 24:00', () => {
    expect(mskParts(msk('2026-08-13T00:00:00')).minutes).toBe(0);
  });

  it('различает выходные', () => {
    expect(mskParts(msk('2026-08-15T08:00:00')).weekday).toBe(6); // суббота
    expect(mskParts(msk('2026-08-16T08:00:00')).weekday).toBe(7); // воскресенье
  });
});

describe('decideWatchdogAction — живой процесс неприкосновенен', () => {
  it('процесс жив → ни реапа, ни перезапуска, даже если строка старая', () => {
    const d = decideWatchdogAction(input({
      liveProcess: true,
      runningRuns: [run('r1', '2026-08-13T06:07:00')],
      runsToday: 1,
    }));
    expect(d.reap).toEqual([]);
    expect(d.restart).toBe(false);
    expect(d.reason).toContain('процесс жив');
  });
});

describe('decideWatchdogAction — реап трупов', () => {
  it('строка running без процесса и старше grace → реап + перезапуск дня', () => {
    const d = decideWatchdogAction(input({
      runningRuns: [run('r1', '2026-08-13T06:07:00')], // 83 мин назад
      runsToday: 1,
    }));
    expect(d.reap.map((r) => r.id)).toEqual(['r1']);
    expect(d.restart).toBe(true);
  });

  it('свежая running-строка (моложе grace) не реапится и блокирует перезапуск', () => {
    const youngStart = new Date(THU_0730.getTime() - WATCHDOG_GRACE_MS + 60_000);
    const d = decideWatchdogAction(input({
      runningRuns: [{ id: 'r1', started_at: youngStart.toISOString() }],
      runsToday: 1,
    }));
    expect(d.reap).toEqual([]);
    expect(d.restart).toBe(false);
    expect(d.reason).toContain('моложе');
  });

  it('битый started_at считается свежим — непонятное не реапим', () => {
    const d = decideWatchdogAction(input({
      runningRuns: [{ id: 'r1', started_at: 'не-дата' }],
      runsToday: 1,
    }));
    expect(d.reap).toEqual([]);
    expect(d.restart).toBe(false);
  });
});

describe('decideWatchdogAction — ограничители перезапуска', () => {
  it('крон вообще не отработал (0 прогонов, процесса нет) → запускаем день', () => {
    const d = decideWatchdogAction(input());
    expect(d.reap).toEqual([]);
    expect(d.restart).toBe(true);
    expect(d.reason).toContain('крон не отработал');
  });

  it('до 06:40 МСК не лезем — крон стартует в 06:07 и имеет право разгоняться', () => {
    expect(decideWatchdogAction(input({ now: msk('2026-08-13T06:39:00') })).restart).toBe(false);
    expect(decideWatchdogAction(input({ now: msk('2026-08-13T06:41:00') })).restart).toBe(true);
  });

  it('после 13:00 МСК день уже не спасаем', () => {
    expect(decideWatchdogAction(input({ now: msk('2026-08-13T12:59:00') })).restart).toBe(true);
    const late = decideWatchdogAction(input({ now: msk('2026-08-13T13:00:00') }));
    expect(late.restart).toBe(false);
    expect(late.reason).toContain('вне окна');
  });

  it('выходные пропускаем — крон прогона тоже только 1-5', () => {
    const sat = decideWatchdogAction(input({ now: msk('2026-08-15T08:00:00') }));
    expect(sat.restart).toBe(false);
    expect(sat.reason).toContain('выходной');
  });

  it('успешный прогон сегодня уже был → второй не запускаем', () => {
    const d = decideWatchdogAction(input({ runsToday: 1, completedToday: 1 }));
    expect(d.restart).toBe(false);
    expect(d.reason).toContain('успешный прогон');
  });

  it('потолок прогонов в сутки гасит петлю детерминированного падения', () => {
    const d = decideWatchdogAction(input({ runsToday: MAX_RUNS_PER_DAY }));
    expect(d.restart).toBe(false);
    expect(d.reason).toContain('лимит');
  });

  it('труп реапится даже когда перезапуск запрещён (строка не должна виснуть)', () => {
    const d = decideWatchdogAction(input({
      now: msk('2026-08-13T18:00:00'), // вне окна
      runningRuns: [run('r1', '2026-08-13T06:07:00')],
      runsToday: 1,
    }));
    expect(d.reap.map((r) => r.id)).toEqual(['r1']);
    expect(d.restart).toBe(false);
  });
});
