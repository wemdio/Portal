/**
 * Сумма месяца календаря технички.
 *
 * Правило: продлённый цикл живёт в месяце, когда фактически ушли деньги
 * (`paid_at`), будущее списание — в месяце даты. Баг, против которого написан
 * тест: после продления строка уезжала на следующий цикл, и оплаченный платёж
 * выпадал из суммы текущего месяца, а следующий месяц наоборот разбухал.
 */
import { monthTotals, totalsByType } from '@/lib/techCalendar/stats';
import type { TechRenewalEvent, TechSubscription } from '@/lib/techCalendar/types';

function sub(over: Partial<TechSubscription> = {}): TechSubscription {
  return {
    id: 'sub-1',
    service_name: 'TimeWeb',
    service_type: 'server',
    amount: 7_775,
    currency: 'RUB',
    billing_cycle: 'monthly',
    next_billing_date: '2026-09-17',
    status: 'active',
    decision_by: null,
    decision_at: null,
    decision_notes: null,
    notes: null,
    source: 'manual',
    external_key: null,
    quantity: 1,
    provider_status: null,
    synced_at: null,
    is_hidden: false,
    hidden_at: null,
    created_by: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function event(over: Partial<TechRenewalEvent> = {}): TechRenewalEvent {
  return {
    id: 'event-1',
    subscription_id: 'sub-1',
    billing_date: '2026-09-03',
    service_name: 'TimeWeb',
    service_type: 'server',
    billing_cycle: 'monthly',
    amount: 7_775,
    currency: 'RUB',
    paid_at: '2026-09-03T10:00:00.000Z',
    ...over,
  };
}

describe('monthTotals', () => {
  it('складывает предстоящие списания месяца и продления, оплаченные в нём', () => {
    const totals = monthTotals(
      [sub(), sub({ id: 'sub-2', next_billing_date: '2026-10-05', amount: 100 })],
      [event(), event({ id: 'event-2', amount: 322, currency: 'USD' })],
      2026,
      8,
    );
    expect(totals).toEqual({ RUB: 15_550, USD: 322 });
  });

  it('продление с датой списания в прошлом месяце попадает в месяц оплаты, а не списания', () => {
    const late = event({ billing_date: '2026-08-31', paid_at: '2026-09-02T10:00:00.000Z' });
    expect(monthTotals([], [late], 2026, 7)).toEqual({ RUB: 0, USD: 0 });
    expect(monthTotals([], [late], 2026, 8)).toEqual({ RUB: 7_775, USD: 0 });
  });

  it('относит оплату к месяцу по Москве: 31 августа 22:30 UTC — уже 1 сентября', () => {
    const lateNight = event({ paid_at: '2026-08-31T22:30:00.000Z' });
    expect(monthTotals([], [lateNight], 2026, 8)).toEqual({ RUB: 7_775, USD: 0 });
  });

  it('не считает отменённые и скрытые строки', () => {
    const totals = monthTotals(
      [
        sub({ id: 'sub-cancel', status: 'cancel' }),
        sub({ id: 'sub-hidden', is_hidden: true }),
      ],
      [],
      2026,
      8,
    );
    expect(totals).toEqual({ RUB: 0, USD: 0 });
  });
});

describe('totalsByType', () => {
  it('разносит продления по типу сервиса вместе со строками', () => {
    const totals = totalsByType(
      [sub()],
      [event({ service_type: 'api', amount: 50, currency: 'USD' })],
      2026,
      8,
    );
    expect(totals.server).toEqual({ RUB: 7_775, USD: 0 });
    expect(totals.api).toEqual({ RUB: 0, USD: 50 });
    expect(totals.proxy).toEqual({ RUB: 0, USD: 0 });
  });
});
