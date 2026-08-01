import {
  computeRenewalsMetrics,
  CYCLE_RELIABLE_MIN_SHARE,
  type ProjectPeriodRow,
  type RenewalProjectRow,
} from '@/lib/renewals/metrics';

function renewal(over: Partial<RenewalProjectRow> = {}): RenewalProjectRow {
  return {
    id: 'p1',
    name: 'Проект',
    client: 'Клиент',
    project_type: 'Продление',
    budget: '100000',
    payment_date: '2026-07-15',
    contract_date: null,
    kpi_fact: null,
    status: 'В работе',
    manager: null,
    specialist: null,
    ...over,
  };
}

function period(over: Partial<ProjectPeriodRow> = {}): ProjectPeriodRow {
  return {
    project_id: 'p1',
    period_start: '2026-01-01',
    period_end: '2026-06-30',
    ...over,
  };
}

// Тот же приём, что в firstSales/metrics.test.ts: конец периода по МСК, а не
// по UTC. 2026-07-31T20:59:59.999Z — последний момент 31 июля в МСК.
const from = new Date('2026-07-01T00:00:00.000Z');
const to = new Date('2026-07-31T20:59:59.999Z');
const today = new Date('2026-07-20T12:00:00.000Z');

describe('computeRenewalsMetrics — тип продления', () => {
  it('распознаёт тип с пробелами и в другом регистре', () => {
    const res = computeRenewalsMetrics(
      [renewal({ project_type: '  ПРОДЛЕНИЕ  ' })],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.count).toBe(1);
  });

  it('строки других типов не считаются', () => {
    const res = computeRenewalsMetrics(
      [renewal({ project_type: 'Продажа' }), renewal({ project_type: null })],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.count).toBe(0);
    expect(res.totals.withoutDate).toBe(0);
    expect(res.totals.planned).toBe(0);
  });
});

describe('computeRenewalsMetrics — бюджет', () => {
  it('парсит число с пробелами-разделителями разрядов', () => {
    const res = computeRenewalsMetrics(
      [renewal({ budget: '120 000' })],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.revenue).toBe(120000);
    expect(res.totals.withoutBudget).toBe(0);
  });

  it('"120к" и пустая строка попадают в withoutBudget, а не в сумму', () => {
    const res = computeRenewalsMetrics(
      [
        renewal({ id: 'p1', budget: '120к' }),
        renewal({ id: 'p2', budget: '', payment_date: '2026-07-16' }),
        renewal({ id: 'p3', budget: '   ', payment_date: '2026-07-17' }),
      ],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.revenue).toBe(0);
    expect(res.totals.withoutBudget).toBe(3);
    // Мусорный бюджет не выкидывает продление из количества за период.
    expect(res.totals.count).toBe(3);
  });
});

describe('computeRenewalsMetrics — дата оплаты', () => {
  it('продление без даты попадает в withoutDate и не теряется', () => {
    const res = computeRenewalsMetrics(
      [renewal({ payment_date: null })],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.withoutDate).toBe(1);
    expect(res.totals.count).toBe(0);
    expect(res.totals.planned).toBe(0);
  });

  it('нераспарсенная дата (не YYYY-MM-DD) тоже уходит в withoutDate', () => {
    const res = computeRenewalsMetrics(
      [renewal({ payment_date: '15.07.2026' })],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.withoutDate).toBe(1);
  });

  it('будущая дата не в обороте и не в count, но в planned', () => {
    const res = computeRenewalsMetrics(
      [renewal({ payment_date: '2026-11-24', budget: '500000' })],
      [], from, to, 'month', null, today,
    );
    expect(res.totals.planned).toBe(1);
    expect(res.totals.count).toBe(0);
    expect(res.totals.revenue).toBe(0);
  });

  it('дата ровно "сегодня" считается фактом, а не планом', () => {
    const res = computeRenewalsMetrics(
      [renewal({ payment_date: '2026-07-20' })],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.planned).toBe(0);
    expect(res.totals.count).toBe(1);
  });

  it('дата вне выбранного окна не считается нигде', () => {
    const res = computeRenewalsMetrics(
      [renewal({ payment_date: '2026-06-15' })], // раньше from
      [], from, to, 'day', null, today,
    );
    expect(res.totals.count).toBe(0);
    expect(res.totals.planned).toBe(0);
    expect(res.totals.withoutDate).toBe(0);
  });

  it('группирует по месяцам через bucketKey', () => {
    const res = computeRenewalsMetrics(
      [
        renewal({ id: 'p1', payment_date: '2026-07-05', budget: '10000' }),
        renewal({ id: 'p2', payment_date: '2026-07-15', budget: '20000' }),
      ],
      [], from, to, 'month', null, today,
    );
    expect(res.series).toHaveLength(1);
    expect(res.series[0]).toEqual({ key: '2026-07-01', count: 2, revenue: 30000 });
  });
});

describe('computeRenewalsMetrics — средний чек', () => {
  it('среднее и медиана расходятся на длинном хвосте, обе верны', () => {
    const res = computeRenewalsMetrics(
      [
        renewal({ id: 'p1', budget: '10000', payment_date: '2026-07-01' }),
        renewal({ id: 'p2', budget: '20000', payment_date: '2026-07-02' }),
        renewal({ id: 'p3', budget: '30000', payment_date: '2026-07-03' }),
        renewal({ id: 'p4', budget: '600000', payment_date: '2026-07-04' }),
      ],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.avgCheck).toBe(165000);
    expect(res.totals.medianCheck).toBe(25000);
    expect(res.totals.medianCheck).not.toBe(res.totals.avgCheck);
  });
});

describe('computeRenewalsMetrics — цикл', () => {
  it('считается от period_end предыдущего периода до contract_date', () => {
    const res = computeRenewalsMetrics(
      [
        renewal({ id: 'p1', contract_date: '2026-07-10' }),
        renewal({ id: 'p2', contract_date: '2026-07-12', payment_date: '2026-07-16' }),
        renewal({ id: 'p3', contract_date: '2026-07-14', payment_date: '2026-07-17' }),
      ],
      [
        period({ project_id: 'p1', period_end: '2026-06-30' }), // 10 дней
        period({ project_id: 'p2', period_end: '2026-07-02' }), // 10 дней
        period({ project_id: 'p3', period_end: '2026-07-04' }), // 10 дней
      ],
      from, to, 'day', null, today,
    );
    expect(res.totals.cycleSampleSize).toBe(3);
    expect(res.totals.cycleCandidates).toBe(3);
    expect(res.totals.cycleReliable).toBe(true);
    expect(res.totals.cycleAvgDays).toBe(10);
    expect(res.totals.cycleMedianDays).toBe(10);
  });

  it('берёт последний период, если их несколько, а не первый попавшийся', () => {
    const res = computeRenewalsMetrics(
      [renewal({ id: 'p1', contract_date: '2026-07-10' })],
      [
        period({ project_id: 'p1', period_end: '2026-05-01' }),
        period({ project_id: 'p1', period_end: '2026-06-30' }), // ближайший к contract_date — 10 дней
      ],
      from, to, 'day', null, today,
    );
    expect(res.totals.cycleAvgDays).toBe(10);
  });

  it('нет истории периодов или нет contract_date — сделка не попадает в цикл', () => {
    const res = computeRenewalsMetrics(
      [
        renewal({ id: 'p1', contract_date: null }), // нет даты договора
        renewal({ id: 'p2', contract_date: '2026-07-10', payment_date: '2026-07-16' }), // нет истории периодов
      ],
      [],
      from, to, 'day', null, today,
    );
    expect(res.totals.cycleSampleSize).toBe(0);
    expect(res.totals.cycleCandidates).toBe(2);
    expect(res.totals.cycleReliable).toBe(false);
    expect(res.totals.cycleAvgDays).toBeNull();
    expect(res.totals.cycleMedianDays).toBeNull();
  });

  it('ровно треть (граница порога) — cycleReliable === true', () => {
    // 3 продления за период, цикл посчитался только у одного — ровно 1/3,
    // порог "не меньше трети" эту границу включает.
    expect(CYCLE_RELIABLE_MIN_SHARE).toBeCloseTo(1 / 3);
    const res = computeRenewalsMetrics(
      [
        renewal({ id: 'p1', contract_date: '2026-07-10' }),
        renewal({ id: 'p2', contract_date: null, payment_date: '2026-07-16' }),
        renewal({ id: 'p3', contract_date: null, payment_date: '2026-07-17' }),
      ],
      [period({ project_id: 'p1', period_end: '2026-06-30' })],
      from, to, 'day', null, today,
    );
    expect(res.totals.cycleSampleSize).toBe(1);
    expect(res.totals.cycleCandidates).toBe(3);
    expect(res.totals.cycleReliable).toBe(true); // 1/3 включительно — порог "не меньше трети"
    expect(res.totals.cycleAvgDays).toBe(10);
  });

  it('порог реально режет — 1 из 4 (меньше трети) даёт cycleReliable === false', () => {
    const res = computeRenewalsMetrics(
      [
        renewal({ id: 'p1', contract_date: '2026-07-10' }),
        renewal({ id: 'p2', contract_date: null, payment_date: '2026-07-15' }),
        renewal({ id: 'p3', contract_date: null, payment_date: '2026-07-16' }),
        renewal({ id: 'p4', contract_date: null, payment_date: '2026-07-17' }),
      ],
      [period({ project_id: 'p1', period_end: '2026-06-30' })],
      from, to, 'day', null, today,
    );
    expect(res.totals.cycleSampleSize).toBe(1);
    expect(res.totals.cycleCandidates).toBe(4);
    expect(res.totals.cycleReliable).toBe(false);
    expect(res.totals.cycleAvgDays).toBeNull();
  });

  it('период проекта, закончившийся ПОСЛЕ даты договора, не считается предыдущим', () => {
    const res = computeRenewalsMetrics(
      [renewal({ id: 'p1', contract_date: '2026-07-10' })],
      [period({ project_id: 'p1', period_end: '2026-07-15' })], // позже contract_date
      from, to, 'day', null, today,
    );
    expect(res.totals.cycleSampleSize).toBe(0);
    expect(res.totals.cycleReliable).toBe(false);
  });
});

describe('computeRenewalsMetrics — фильтр по KPI', () => {
  it('отсекает по числовому диапазону', () => {
    const rows = [
      renewal({ id: 'p1', kpi_fact: '50', payment_date: '2026-07-01' }),
      renewal({ id: 'p2', kpi_fact: '90', payment_date: '2026-07-02' }),
      renewal({ id: 'p3', kpi_fact: '120', payment_date: '2026-07-03' }),
    ];
    const res = computeRenewalsMetrics(rows, [], from, to, 'day', { min: 60, max: 100 }, today);
    expect(res.totals.count).toBe(1);
  });

  it('непарсящийся kpi_fact не подпадает под заданный фильтр', () => {
    const res = computeRenewalsMetrics(
      [renewal({ kpi_fact: 'н/д' })],
      [], from, to, 'day', { min: 0, max: 100 }, today,
    );
    expect(res.totals.count).toBe(0);
  });

  it('без фильтра продление не выкидывается из-за непарсящегося kpi_fact', () => {
    const res = computeRenewalsMetrics(
      [renewal({ kpi_fact: 'н/д' })],
      [], from, to, 'day', null, today,
    );
    expect(res.totals.count).toBe(1);
  });
});

describe('computeRenewalsMetrics — пустая выборка', () => {
  it('не даёт NaN ни в одном из полей', () => {
    const res = computeRenewalsMetrics([], [], from, to, 'day', null, today);
    expect(res.totals.count).toBe(0);
    expect(res.totals.revenue).toBe(0);
    expect(res.totals.avgCheck).toBeNull();
    expect(res.totals.medianCheck).toBeNull();
    expect(res.totals.planned).toBe(0);
    expect(res.totals.withoutDate).toBe(0);
    expect(res.totals.withoutBudget).toBe(0);
    expect(res.totals.cycleAvgDays).toBeNull();
    expect(res.totals.cycleMedianDays).toBeNull();
    expect(res.totals.cycleReliable).toBe(false);
    for (const bucket of res.series) {
      expect(Number.isNaN(bucket.count)).toBe(false);
      expect(Number.isNaN(bucket.revenue)).toBe(false);
    }
  });

  it('пустые корзины присутствуют в ряду', () => {
    const res = computeRenewalsMetrics([renewal()], [], from, to, 'day', null, today);
    expect(res.series).toHaveLength(31);
    expect(res.series[0]).toEqual({ key: '2026-07-01', count: 0, revenue: 0 });
  });
});
