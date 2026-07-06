import { buildSequenceHandoffSteps } from '@/lib/clientLaunch/sequenceHandoff';

const L = (subject: string, body: string, wait_days = 2) => ({ subject, body, wait_days });

describe('buildSequenceHandoffSteps', () => {
  it('пустая цепочка → []', () => {
    expect(buildSequenceHandoffSteps([])).toEqual([]);
  });

  it('темы писем становятся A/B-вариантами первого шага (одинаковое тело = тело 1-го), фоллоу-апы — пустая тема', () => {
    const letters = [
      L('Тема 1', 'Тело 1', 0),
      L('Тема 2', 'Тело 2', 2),
      L('Тема 3', 'Тело 3', 4),
    ];
    const steps = buildSequenceHandoffSteps(letters);

    expect(steps).toHaveLength(3);
    // Первый шаг: тема из письма 1, варианты — темы 2 и 3, ВСЕ с телом первого письма.
    expect(steps[0].subject).toBe('Тема 1');
    expect(steps[0].body).toBe('Тело 1');
    expect(steps[0].wait_days).toBe(0);
    expect(steps[0].variants).toEqual([
      { subject: 'Тема 2', body: 'Тело 1' },
      { subject: 'Тема 3', body: 'Тело 1' },
    ]);
    // Фоллоу-апы: пустая тема (та же ветка), СВОИ тела и задержки.
    expect(steps[1]).toEqual({ subject: '', body: 'Тело 2', wait_days: 2 });
    expect(steps[2]).toEqual({ subject: '', body: 'Тело 3', wait_days: 4 });
  });

  it('лимит вариантов: >4 уникальных тем → только первые 4 как A/B/C/D', () => {
    const letters = [
      L('T1', 'B1', 0),
      L('T2', 'B2', 2),
      L('T3', 'B3', 2),
      L('T4', 'B4', 2),
      L('T5', 'B5', 2),
      L('T6', 'B6', 2),
    ];
    const steps = buildSequenceHandoffSteps(letters, 4);
    // 4 темы всего: главная + 3 варианта; T5/T6 как темы отброшены.
    expect(steps[0].variants).toHaveLength(3);
    expect([steps[0].subject, ...steps[0].variants!.map((v) => v.subject)]).toEqual(['T1', 'T2', 'T3', 'T4']);
    // но тела всех 6 писем сохранены отдельными шагами.
    expect(steps).toHaveLength(6);
    expect(steps.slice(1).map((s) => s.body)).toEqual(['B2', 'B3', 'B4', 'B5', 'B6']);
    expect(steps.slice(1).every((s) => s.subject === '')).toBe(true);
  });

  it('одинаковые темы дедуплицируются → без вариантов', () => {
    const steps = buildSequenceHandoffSteps([L('Одна тема', 'B1', 0), L('Одна тема', 'B2', 2)]);
    expect(steps[0].subject).toBe('Одна тема');
    expect(steps[0].variants).toBeUndefined();
    expect(steps[1]).toEqual({ subject: '', body: 'B2', wait_days: 2 });
  });

  it('пустые темы игнорируются в пуле вариантов', () => {
    const steps = buildSequenceHandoffSteps([L('Тема 1', 'B1', 0), L('   ', 'B2', 2)]);
    expect(steps[0].subject).toBe('Тема 1');
    expect(steps[0].variants).toBeUndefined();
  });

  it('одно письмо → один шаг, без вариантов и фоллоу-апов', () => {
    const steps = buildSequenceHandoffSteps([L('Тема', 'Тело', 0)]);
    expect(steps).toEqual([{ subject: 'Тема', body: 'Тело', wait_days: 0 }]);
  });

  it('первое письмо всегда wait_days=0 (даже если в цепочке было иначе)', () => {
    const steps = buildSequenceHandoffSteps([L('T', 'B', 5)]);
    expect(steps[0].wait_days).toBe(0);
  });
});
