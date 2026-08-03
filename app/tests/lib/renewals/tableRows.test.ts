import { buildRenewalTableRows } from '@/lib/renewals/tableRows';
import type { RenewalMarkRow, RevenueTransactionRow } from '@/lib/renewals/metrics';

function txn(over: Partial<RevenueTransactionRow> = {}): RevenueTransactionRow {
  return {
    id: 1,
    payer_inn: '7714379242',
    payer_name: 'ООО «Смартвэй»',
    amount: 159000,
    occurred_at: '2026-07-15T10:00:00.000Z',
    purpose: 'Оплата по договору №1 за июль',
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

describe('buildRenewalTableRows — какие строки попадают', () => {
  it('только is_renewal=true, соединённые с транзакцией', () => {
    const rows = buildRenewalTableRows(
      [
        mark({ transaction_id: 1, is_renewal: true }),
        mark({ transaction_id: 2, is_renewal: false, method: 'not_renewal' }),
      ],
      [txn({ id: 1 }), txn({ id: 2, payer_inn: '2' })],
      null,
    );
    expect(rows.map((r) => r.transactionId)).toEqual([1]);
  });

  it('отметка на транзакцию вне выборки не роняет и не создаёт строку', () => {
    const rows = buildRenewalTableRows([mark({ transaction_id: 999 })], [txn({ id: 1 })], null);
    expect(rows).toHaveLength(0);
  });
});

describe('buildRenewalTableRows — поля строки', () => {
  it('клиент/ИНН/сумма/назначение берутся из транзакции, а не из текста подтверждения', () => {
    const rows = buildRenewalTableRows(
      [mark({ transaction_id: 1, note: 'по комментарию: «Продление 1 - 159к»' })],
      [
        txn({
          id: 1,
          payer_name: 'ООО «Смартвэй»',
          payer_inn: '7714379242',
          amount: 159000,
          purpose: 'Оплата по договору №1 за июль',
        }),
      ],
      null,
    );
    expect(rows[0]).toMatchObject({
      client: 'ООО «Смартвэй»',
      inn: '7714379242',
      amount: 159000, // сумма ПЛАТЕЖА, не число из текста
      purpose: 'Оплата по договору №1 за июль',
    });
  });

  it('человеческая подпись метода — по method, для каждого значения своя', () => {
    const rows = buildRenewalTableRows(
      [
        mark({ transaction_id: 1, method: 'note_text' }),
        mark({ transaction_id: 2, method: 'task_text' }),
        mark({ transaction_id: 3, method: 'project_type' }),
        mark({ transaction_id: 4, method: 'manual' }),
      ],
      [
        txn({ id: 1, payer_inn: '1' }),
        txn({ id: 2, payer_inn: '2' }),
        txn({ id: 3, payer_inn: '3' }),
        txn({ id: 4, payer_inn: '4' }),
      ],
      null,
    );
    const byId = new Map(rows.map((r) => [r.transactionId, r.methodLabel]));
    expect(byId.get(1)).toMatch(/комментари/i);
    expect(byId.get(2)).toMatch(/задач/i);
    expect(byId.get(3)).toMatch(/проект/i);
    expect(byId.get(4)).toMatch(/вручную/i);
  });

  it('дата платежа — ключ дня в МСК, полученный из occurred_at', () => {
    const rows = buildRenewalTableRows(
      [mark({ transaction_id: 1 })],
      [txn({ id: 1, occurred_at: '2026-07-15T22:00:00.000Z' })], // 16-е в МСК (+3ч)
      null,
    );
    expect(rows[0]?.paymentDate).toBe('2026-07-16');
  });
});

describe('buildRenewalTableRows — ссылка на сделку AMO', () => {
  it('строит ссылку, когда есть и amoBaseUrl, и amo_deal_id', () => {
    const rows = buildRenewalTableRows(
      [mark({ transaction_id: 1, amo_deal_id: 33462035 })],
      [txn({ id: 1 })],
      'https://example.amocrm.ru',
    );
    expect(rows[0]?.amoDealUrl).toBe('https://example.amocrm.ru/leads/detail/33462035');
    expect(rows[0]?.amoDealId).toBe(33462035);
  });

  it('без amoBaseUrl ссылки нет, даже если сделка известна', () => {
    const rows = buildRenewalTableRows(
      [mark({ transaction_id: 1, amo_deal_id: 33462035 })],
      [txn({ id: 1 })],
      null,
    );
    expect(rows[0]?.amoDealUrl).toBeNull();
    expect(rows[0]?.amoDealId).toBe(33462035);
  });

  it('без amo_deal_id (например, method=project_type) ссылки нет', () => {
    const rows = buildRenewalTableRows(
      [mark({ transaction_id: 1, method: 'project_type', amo_deal_id: null })],
      [txn({ id: 1 })],
      'https://example.amocrm.ru',
    );
    expect(rows[0]?.amoDealUrl).toBeNull();
  });
});

describe('buildRenewalTableRows — период', () => {
  const window = { fromKey: '2026-07-01', toKey: '2026-07-31' };

  it('без окна отдаёт всё', () => {
    const rows = buildRenewalTableRows(
      [mark({ transaction_id: 1 }), mark({ transaction_id: 2 })],
      [
        txn({ id: 1, payer_inn: '1', occurred_at: '2025-01-01T00:00:00.000Z' }),
        txn({ id: 2, payer_inn: '2', occurred_at: '2026-07-15T00:00:00.000Z' }),
      ],
      null,
    );
    expect(rows).toHaveLength(2);
  });

  it('оставляет только продления внутри периода, обе границы включительно', () => {
    const rows = buildRenewalTableRows(
      [
        mark({ transaction_id: 1 }),
        mark({ transaction_id: 2 }),
        mark({ transaction_id: 3 }),
        mark({ transaction_id: 4 }),
      ],
      [
        txn({ id: 1, payer_inn: '1', occurred_at: '2026-06-30T00:00:00.000Z' }), // раньше окна
        txn({ id: 2, payer_inn: '2', occurred_at: '2026-07-01T00:00:00.000Z' }), // первый день
        txn({ id: 3, payer_inn: '3', occurred_at: '2026-07-31T20:00:00.000Z' }), // последний день
        txn({ id: 4, payer_inn: '4', occurred_at: '2026-08-01T00:00:00.000Z' }), // позже окна
      ],
      null,
      window,
    );
    expect(rows.map((r) => r.transactionId).sort()).toEqual([2, 3]);
  });
});

describe('buildRenewalTableRows — сортировка', () => {
  it('свежие сверху', () => {
    const rows = buildRenewalTableRows(
      [mark({ transaction_id: 1 }), mark({ transaction_id: 2 }), mark({ transaction_id: 3 })],
      [
        txn({ id: 1, payer_inn: '1', occurred_at: '2026-01-01T00:00:00.000Z' }),
        txn({ id: 2, payer_inn: '2', occurred_at: '2026-07-01T00:00:00.000Z' }),
        txn({ id: 3, payer_inn: '3', occurred_at: '2026-03-01T00:00:00.000Z' }),
      ],
      null,
    );
    expect(rows.map((r) => r.transactionId)).toEqual([2, 3, 1]);
  });
});
