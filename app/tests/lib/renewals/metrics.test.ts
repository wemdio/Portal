import {
  computeRenewalsMetrics,
  type RenewalMarkRow,
  type RevenueTransactionRow,
} from '@/lib/renewals/metrics';

function txn(over: Partial<RevenueTransactionRow> = {}): RevenueTransactionRow {
  return {
    id: 1,
    payer_inn: '7714379242',
    payer_name: 'ООО «Смартвэй»',
    amount: 100000,
    occurred_at: '2026-07-15T10:00:00.000Z',
    purpose: 'Оплата услуг по договору №1',
    ...over,
  };
}

function mark(over: Partial<RenewalMarkRow> = {}): RenewalMarkRow {
  return {
    transaction_id: 1,
    is_renewal: true,
    method: 'task_text',
    amo_deal_id: null,
    note: null,
    ...over,
  };
}

// Тот же приём, что в firstSales/metrics.test.ts: конец периода по МСК, а не
// по UTC. 2026-07-31T20:59:59.999Z — последний момент 31 июля в МСК.
const from = new Date('2026-07-01T00:00:00.000Z');
const to = new Date('2026-07-31T20:59:59.999Z');

describe('computeRenewalsMetrics — дата платежа, а не дата подтверждения', () => {
  it('продление считается по occurred_at транзакции — единственной дате, которую вообще видит функция', () => {
    // RenewalMarkRow намеренно не несёт даты подтверждения (matched_at) —
    // считать метрику "по дате подтверждения" здесь физически не из чего.
    // Платёж внутри периода — считается.
    const res = computeRenewalsMetrics(
      [mark({ transaction_id: 1 })],
      [txn({ id: 1, occurred_at: '2026-07-20T00:00:00.000Z' })],
      from, to, 'day',
    );
    expect(res.totals.count).toBe(1);
    expect(res.totals.revenue).toBe(100000);
  });

  it('платёж вне периода не считается, даже если это единственная транзакция в выборке', () => {
    const res = computeRenewalsMetrics(
      [mark({ transaction_id: 1 })],
      [txn({ id: 1, occurred_at: '2026-06-15T00:00:00.000Z' })], // раньше from
      from, to, 'day',
    );
    expect(res.totals.count).toBe(0);
    expect(res.totals.revenue).toBe(0);
  });

  it('обе границы периода включительно', () => {
    const res = computeRenewalsMetrics(
      [mark({ transaction_id: 1 }), mark({ transaction_id: 2 })],
      [
        txn({ id: 1, occurred_at: '2026-07-01T00:00:00.000Z' }),
        txn({ id: 2, occurred_at: '2026-07-31T20:00:00.000Z' }),
      ],
      from, to, 'day',
    );
    expect(res.totals.count).toBe(2);
  });
});

describe('computeRenewalsMetrics — is_renewal=false не попадает в метрики', () => {
  it('человек нажал «транш» / «другая услуга» — is_renewal=false исключается из count/revenue', () => {
    const res = computeRenewalsMetrics(
      [mark({ transaction_id: 1, is_renewal: false, method: 'not_renewal' })],
      [txn({ id: 1 })],
      from, to, 'day',
    );
    expect(res.totals.count).toBe(0);
    expect(res.totals.revenue).toBe(0);
  });

  it('not_renewal — решённый кандидат, поэтому и в «не разобрано» не попадает', () => {
    const res = computeRenewalsMetrics(
      [
        mark({ transaction_id: 1, is_renewal: false, method: 'not_renewal' }), // первый платёж ИНН — не кандидат вовсе
        mark({ transaction_id: 2, is_renewal: false, method: 'not_renewal' }), // второй — кандидат, но РЕШЁН как не продление
      ],
      [
        txn({ id: 1, payer_inn: '111', occurred_at: '2026-07-01T00:00:00.000Z' }),
        txn({ id: 2, payer_inn: '111', occurred_at: '2026-07-15T00:00:00.000Z' }),
      ],
      from, to, 'day',
    );
    expect(res.totals.unresolved).toBe(0);
    expect(res.totals.count).toBe(0);
  });
});

describe('computeRenewalsMetrics — «не разобрано»', () => {
  it('кандидат (повторный приход с ИНН) без отметки — в «не разобрано», а не в продления', () => {
    const res = computeRenewalsMetrics(
      [], // ни одной строки в renewal_marks
      [
        txn({ id: 1, payer_inn: '222', occurred_at: '2026-07-01T00:00:00.000Z' }), // первый платёж ИНН
        txn({ id: 2, payer_inn: '222', occurred_at: '2026-07-15T00:00:00.000Z' }), // повторный — кандидат
      ],
      from, to, 'day',
    );
    expect(res.totals.count).toBe(0);
    expect(res.totals.unresolved).toBe(1);
  });

  it('первый платёж ИНН никогда не в «не разобрано», даже без единой отметки', () => {
    const res = computeRenewalsMetrics(
      [],
      [txn({ id: 1, payer_inn: '333', occurred_at: '2026-07-01T00:00:00.000Z' })],
      from, to, 'day',
    );
    expect(res.totals.unresolved).toBe(0);
  });

  it('«не разобрано» ограничено тем же периодом, что и остальные плитки', () => {
    const res = computeRenewalsMetrics(
      [],
      [
        txn({ id: 1, payer_inn: '444', occurred_at: '2026-01-01T00:00:00.000Z' }), // первый платёж ИНН
        txn({ id: 2, payer_inn: '444', occurred_at: '2026-02-01T00:00:00.000Z' }), // кандидат, но вне [from, to]
      ],
      from, to, 'day',
    );
    expect(res.totals.unresolved).toBe(0);
  });

  it('несколько ИНН считаются независимо', () => {
    const res = computeRenewalsMetrics(
      [],
      [
        txn({ id: 1, payer_inn: 'A', occurred_at: '2026-07-01T00:00:00.000Z' }),
        txn({ id: 2, payer_inn: 'A', occurred_at: '2026-07-05T00:00:00.000Z' }), // кандидат A
        txn({ id: 3, payer_inn: 'B', occurred_at: '2026-07-02T00:00:00.000Z' }),
        txn({ id: 4, payer_inn: 'B', occurred_at: '2026-07-06T00:00:00.000Z' }), // кандидат B
        txn({ id: 5, payer_inn: 'B', occurred_at: '2026-07-10T00:00:00.000Z' }), // тоже кандидат B
      ],
      from, to, 'day',
    );
    expect(res.totals.unresolved).toBe(3);
  });
});

describe('computeRenewalsMetrics — средний чек', () => {
  it('среднее и медиана расходятся на длинном хвосте, обе верны', () => {
    const res = computeRenewalsMetrics(
      [
        mark({ transaction_id: 1 }),
        mark({ transaction_id: 2 }),
        mark({ transaction_id: 3 }),
        mark({ transaction_id: 4 }),
      ],
      [
        txn({ id: 1, payer_inn: '1', amount: 10000, occurred_at: '2026-07-01T00:00:00.000Z' }),
        txn({ id: 2, payer_inn: '2', amount: 20000, occurred_at: '2026-07-02T00:00:00.000Z' }),
        txn({ id: 3, payer_inn: '3', amount: 30000, occurred_at: '2026-07-03T00:00:00.000Z' }),
        txn({ id: 4, payer_inn: '4', amount: 600000, occurred_at: '2026-07-04T00:00:00.000Z' }),
      ],
      from, to, 'day',
    );
    expect(res.totals.avgCheck).toBe(165000);
    expect(res.totals.medianCheck).toBe(25000);
    expect(res.totals.medianCheck).not.toBe(res.totals.avgCheck);
  });
});

describe('computeRenewalsMetrics — группировка', () => {
  it('группирует по месяцам через bucketKey', () => {
    const res = computeRenewalsMetrics(
      [mark({ transaction_id: 1 }), mark({ transaction_id: 2 })],
      [
        txn({ id: 1, payer_inn: '1', amount: 10000, occurred_at: '2026-07-05T00:00:00.000Z' }),
        txn({ id: 2, payer_inn: '2', amount: 20000, occurred_at: '2026-07-15T00:00:00.000Z' }),
      ],
      from, to, 'month',
    );
    expect(res.series).toHaveLength(1);
    expect(res.series[0]).toEqual({ key: '2026-07-01', count: 2, revenue: 30000 });
  });

  it('пустые корзины присутствуют в ряду', () => {
    const res = computeRenewalsMetrics([mark()], [txn()], from, to, 'day');
    expect(res.series).toHaveLength(31);
  });
});

describe('computeRenewalsMetrics — цикл: якорь это предыдущее подтверждённое продление, а не любой предыдущий платёж', () => {
  // Сквозной сценарий из плана (ООО «СМАРТВЭЙ»): между двумя подтверждёнными
  // продлениями лежит платёж-транш/другая услуга, который НЕ подтверждён.
  // Наивный расчёт "от предыдущего платежа вообще" взял бы этот транш за
  // границу периода и занизил бы цикл. Здесь якорь — предыдущее
  // ПОДТВЕРЖДЁННОЕ продление (а для самого первого продления — первый платёж
  // ИНН, он же "первичка").
  const inn = '7714379242';
  const firstPayment = txn({ id: 1, payer_inn: inn, amount: 84000, occurred_at: '2026-06-01T00:00:00.000Z' });
  const renewal1 = txn({ id: 2, payer_inn: inn, amount: 179000, occurred_at: '2026-07-01T00:00:00.000Z' }); // +30 дней от первички
  const otherService = txn({ id: 3, payer_inn: inn, amount: 20000, occurred_at: '2026-07-11T00:00:00.000Z' }); // +10 дней от renewal1, НЕ подтверждён
  const renewal2 = txn({ id: 4, payer_inn: inn, amount: 159000, occurred_at: '2026-09-09T00:00:00.000Z' }); // +70 дней от renewal1, +60 от otherService

  const wideFrom = new Date('2026-06-01T00:00:00.000Z');
  const wideTo = new Date('2026-09-30T20:59:59.999Z');

  it('цикл второго продления считается от первого продления (70 дней), а не от транша между ними (60 дней)', () => {
    const res = computeRenewalsMetrics(
      [
        mark({ transaction_id: 2, method: 'task_text' }), // renewal1 — подтверждено
        // otherService (id=3) сознательно БЕЗ строки в renewal_marks — кандидат,
        // ждёт решения человека, не должен участвовать в расчёте цикла.
        mark({ transaction_id: 4, method: 'note_text' }), // renewal2 — подтверждено
      ],
      [firstPayment, renewal1, otherService, renewal2],
      wideFrom, wideTo, 'day',
    );

    expect(res.totals.count).toBe(2); // renewal1 + renewal2, транш не в count
    expect(res.totals.unresolved).toBe(1); // только транш ждёт решения
    expect(res.totals.cycleSampleSize).toBe(2);
    // 30 дней (первичка → renewal1) и 70 дней (renewal1 → renewal2) — НЕ 60
    // (было бы, если бы якорем взяли транш).
    expect(res.totals.cycleAvgDays).toBe(50);
    expect(res.totals.cycleMedianDays).toBe(50);
  });

  it('первое продление считается от первого платежа ИНН (первички)', () => {
    const res = computeRenewalsMetrics(
      [mark({ transaction_id: 2, method: 'task_text' })],
      [firstPayment, renewal1],
      wideFrom, wideTo, 'day',
    );
    expect(res.totals.cycleSampleSize).toBe(1);
    expect(res.totals.cycleAvgDays).toBe(30);
  });
});

describe('computeRenewalsMetrics — цикл: единственный платёж ИНН не даёт цикла', () => {
  it('если у ИНН вообще нет платежа раньше — цикл не считается (не 0, а исключается из выборки)', () => {
    // Транзакция помечена вручную (единственный реалистичный способ получить
    // is_renewal=true без предшествующего платежа того же ИНН вообще).
    const res = computeRenewalsMetrics(
      [mark({ transaction_id: 1, method: 'manual' })],
      [txn({ id: 1, payer_inn: '999', occurred_at: '2026-07-10T00:00:00.000Z' })],
      from, to, 'day',
    );
    expect(res.totals.count).toBe(1); // это всё ещё продление
    expect(res.totals.cycleSampleSize).toBe(0); // но цикл посчитать не из чего
    expect(res.totals.cycleCandidates).toBe(1);
    expect(res.totals.cycleAvgDays).toBeNull();
    expect(res.totals.cycleMedianDays).toBeNull();
  });
});

describe('computeRenewalsMetrics — защитные случаи', () => {
  it('отметка на транзакцию вне выборки не роняет расчёт', () => {
    const res = computeRenewalsMetrics(
      [mark({ transaction_id: 999 })], // такой транзакции нет в transactions
      [txn({ id: 1 })],
      from, to, 'day',
    );
    expect(res.totals.count).toBe(0);
  });
});

describe('computeRenewalsMetrics — пустая выборка', () => {
  it('не даёт NaN ни в одном из полей', () => {
    const res = computeRenewalsMetrics([], [], from, to, 'day');
    expect(res.totals.count).toBe(0);
    expect(res.totals.revenue).toBe(0);
    expect(res.totals.avgCheck).toBeNull();
    expect(res.totals.medianCheck).toBeNull();
    expect(res.totals.cycleAvgDays).toBeNull();
    expect(res.totals.cycleMedianDays).toBeNull();
    expect(res.totals.cycleSampleSize).toBe(0);
    expect(res.totals.cycleCandidates).toBe(0);
    expect(res.totals.unresolved).toBe(0);
    for (const bucket of res.series) {
      expect(Number.isNaN(bucket.count)).toBe(false);
      expect(Number.isNaN(bucket.revenue)).toBe(false);
    }
  });
});
