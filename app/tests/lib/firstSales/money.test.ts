/** @jest-environment node */

/**
 * Связка банковских денег со сделками первички.
 *
 * Два свойства держим тестами, потому что оба ломаются молча и в одну и ту же
 * сторону — в занижение, которое выглядит как «клиент не платил»:
 *
 *   1. Нормализация ИНН. В AMO его вводят руками («ИНН 7709492845», «7709 492
 *      845»), в выписке он приходит машинно и чистым. Разойдись эти две
 *      стороны — платёж просто не найдётся, и никакой ошибки никто не увидит.
 *   2. Что считается первичкой. Продление — не новая продажа, а неразобранный
 *      кандидат — не повод угадывать за человека.
 */

import {
  normalizeInn,
  dealInn,
  isFirstSaleMoney,
  attributablePayment,
  paymentAmount,
  emptyMoneyTotals,
  type FirstSalesPaymentRow,
} from '@/lib/firstSales/money';

function payment(over: Partial<FirstSalesPaymentRow> = {}): FirstSalesPaymentRow {
  return {
    transaction_id: 1,
    occurred_at: '2026-07-15T09:00:00.000Z',
    amount: 100_000,
    payer_inn: '7709492845',
    payer_name: 'ООО «Ромашка»',
    amo_deal_id: 1,
    deal_matches: 1,
    renewal_state: 'first',
    ...over,
  };
}

describe('normalizeInn', () => {
  it('чистит всё кроме цифр', () => {
    expect(normalizeInn('ИНН 7709492845')).toBe('7709492845');
    expect(normalizeInn('7709 492 845')).toBe('7709492845');
    expect(normalizeInn(' 771385779206 ')).toBe('771385779206');
  });

  it('10 цифр — юрлицо, 12 — ИП, остальное не ИНН', () => {
    expect(normalizeInn('7709492845')).toBe('7709492845');
    expect(normalizeInn('771385779206')).toBe('771385779206');
    expect(normalizeInn('123')).toBeNull();
    expect(normalizeInn('77094928451')).toBeNull(); // 11 цифр
    expect(normalizeInn('нет')).toBeNull();
    expect(normalizeInn(null)).toBeNull();
    expect(normalizeInn(undefined)).toBeNull();
  });
});

describe('dealInn', () => {
  const withInn = (value: unknown) => ({
    custom_fields_values: [
      { field_name: 'Источник', values: [{ value: 'Email Outreach' }] },
      { field_name: 'ИНН', values: [{ value }] },
    ],
  });

  it('берёт поле «ИНН» из raw и нормализует', () => {
    expect(dealInn(withInn('ИНН 7709492845'))).toBe('7709492845');
    expect(dealInn(withInn(9726095457))).toBe('9726095457'); // AMO иногда отдаёт числом
  });

  it('нет поля, пустое или мусор — null, а не пустая строка', () => {
    expect(dealInn({ custom_fields_values: [] })).toBeNull();
    expect(dealInn(withInn(''))).toBeNull();
    expect(dealInn(withInn('уточнить'))).toBeNull();
    // AMO отдаёт JSON null у сделки без единого заполненного поля — на этом
    // 04.08.2026 падал SQL-аналог (см. миграцию 20260804_0005).
    expect(dealInn({ custom_fields_values: null })).toBeNull();
    expect(dealInn(null)).toBeNull();
  });
});

describe('isFirstSaleMoney', () => {
  it('первый платёж ИНН и явное «не продление» — первичка', () => {
    expect(isFirstSaleMoney('first')).toBe(true);
    expect(isFirstSaleMoney('not_renewal')).toBe(true);
  });

  /** Ключевое: неразобранный кандидат — не «наверное первичка». */
  it('продление и неразобранный кандидат первичкой не считаются', () => {
    expect(isFirstSaleMoney('renewal')).toBe(false);
    expect(isFirstSaleMoney('pending')).toBe(false);
  });
});

describe('attributablePayment', () => {
  it('одна сделка на ИНН — платёж относим', () => {
    expect(attributablePayment(payment())).toBe(true);
    expect(attributablePayment(payment({ renewal_state: 'not_renewal' }))).toBe(true);
  });

  /** Две сделки воронки с одним ИНН: какая «та самая» — неизвестно, и
   *  выбирать за человека нельзя. */
  it('несколько сделок на ИНН — не относим', () => {
    expect(attributablePayment(payment({ deal_matches: 2 }))).toBe(false);
  });

  it('без сделки и у продлений — не относим', () => {
    expect(attributablePayment(payment({ amo_deal_id: null, deal_matches: 0 }))).toBe(false);
    expect(attributablePayment(payment({ renewal_state: 'renewal' }))).toBe(false);
    expect(attributablePayment(payment({ renewal_state: 'pending' }))).toBe(false);
  });
});

describe('paymentAmount', () => {
  it('numeric из PostgREST может прийти строкой — складывать её нельзя', () => {
    expect(paymentAmount(payment({ amount: '84000.50' }))).toBe(84000.5);
    expect(paymentAmount(payment({ amount: 84000 }))).toBe(84000);
  });

  it('мусор — ноль, а не NaN: NaN отравил бы всю сумму окна', () => {
    expect(paymentAmount(payment({ amount: 'нет' }))).toBe(0);
  });
});

describe('emptyMoneyTotals', () => {
  it('нули, а не undefined — карточка обязана показать «0 ₽», а не пустоту', () => {
    expect(emptyMoneyTotals()).toEqual({
      received: 0,
      payments: 0,
      ambiguous: 0,
      ambiguousPayments: 0,
      pending: 0,
      pendingPayments: 0,
      contractsWithInn: 0,
    });
  });
});
