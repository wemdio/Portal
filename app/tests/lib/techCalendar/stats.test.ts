/** @jest-environment node */

/**
 * Плитки и суммы календаря технички.
 *
 * Главное, что тут пинуется: рубли и доллары не смешиваются ни в итоге месяца,
 * ни в разбивке по типам, а отменённые сервисы не попадают ни в деньги, ни в
 * счётчик активных — иначе экран показывал бы расход, которого не будет.
 */

import {
  activeCount,
  decisionsDueWithin,
  monthTotals,
  pendingCount,
  totalsByType,
  upcoming,
} from '@/lib/techCalendar/stats';
import type { TechSubscription } from '@/lib/techCalendar/types';

function sub(over: Partial<TechSubscription>): TechSubscription {
  return {
    id: 'id-1',
    service_name: 'Сервис',
    service_type: 'proxy',
    amount: 100,
    currency: 'RUB',
    billing_cycle: 'monthly',
    next_billing_date: '2026-08-20',
    status: 'active',
    decision_by: null,
    decision_at: null,
    decision_notes: null,
    notes: null,
    created_by: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('monthTotals', () => {
  it('складывает рубли и доллары раздельно', () => {
    const subs = [
      sub({ id: 'a', amount: 15000, currency: 'RUB' }),
      sub({ id: 'b', amount: 250, currency: 'USD' }),
      sub({ id: 'c', amount: 3000, currency: 'RUB' }),
    ];
    expect(monthTotals(subs, 2026, 7)).toEqual({ RUB: 18000, USD: 250 });
  });

  it('не берёт чужие месяцы', () => {
    const subs = [
      sub({ id: 'a', amount: 100, next_billing_date: '2026-08-31' }),
      sub({ id: 'b', amount: 500, next_billing_date: '2026-09-01' }),
    ];
    expect(monthTotals(subs, 2026, 7)).toEqual({ RUB: 100, USD: 0 });
  });

  it('не считает отменённые', () => {
    const subs = [
      sub({ id: 'a', amount: 100 }),
      sub({ id: 'b', amount: 900, status: 'cancel' }),
    ];
    expect(monthTotals(subs, 2026, 7)).toEqual({ RUB: 100, USD: 0 });
  });
});

describe('totalsByType', () => {
  it('разносит суммы по типам и валютам', () => {
    const subs = [
      sub({ id: 'a', service_type: 'proxy', amount: 5000, currency: 'RUB' }),
      sub({ id: 'b', service_type: 'proxy', amount: 40, currency: 'USD' }),
      sub({ id: 'c', service_type: 'server', amount: 12000, currency: 'RUB' }),
    ];
    const result = totalsByType(subs, 2026, 7);
    expect(result.proxy).toEqual({ RUB: 5000, USD: 40 });
    expect(result.server).toEqual({ RUB: 12000, USD: 0 });
    expect(result.api).toEqual({ RUB: 0, USD: 0 });
  });
});

describe('счётчики', () => {
  const subs = [
    sub({ id: 'a', status: 'active' }),
    sub({ id: 'b', status: 'pending_review' }),
    sub({ id: 'c', status: 'keep' }),
    sub({ id: 'd', status: 'cancel' }),
  ];

  it('считает активными всё, кроме отменённых', () => {
    expect(activeCount(subs)).toBe(3);
  });

  it('считает ожидающие решения', () => {
    expect(pendingCount(subs)).toBe(1);
  });
});

describe('decisionsDueWithin', () => {
  const today = '2026-08-13';

  it('берёт сервисы в пределах недели без решения', () => {
    const subs = [
      sub({ id: 'a', next_billing_date: '2026-08-14', status: 'pending_review' }),
      sub({ id: 'b', next_billing_date: '2026-08-20', status: 'pending_review' }),
      sub({ id: 'c', next_billing_date: '2026-08-21', status: 'active' }),
    ];
    expect(decisionsDueWithin(subs, today, 7)).toBe(2);
  });

  it('не считает уже решённые и отменённые', () => {
    const subs = [
      sub({ id: 'a', next_billing_date: '2026-08-15', status: 'keep' }),
      sub({ id: 'b', next_billing_date: '2026-08-15', status: 'cancel' }),
      sub({ id: 'c', next_billing_date: '2026-08-15', status: 'pending_review' }),
    ];
    expect(decisionsDueWithin(subs, today, 7)).toBe(1);
  });

  it('считает просроченные — решение по ним всё ещё нужно', () => {
    const subs = [sub({ id: 'a', next_billing_date: '2026-08-11', status: 'pending_review' })];
    expect(decisionsDueWithin(subs, today, 7)).toBe(1);
  });
});

describe('upcoming', () => {
  const today = '2026-08-13';

  it('сортирует по дате и берёт неделю вперёд и три дня назад', () => {
    const subs = [
      sub({ id: 'far', next_billing_date: '2026-08-25' }),
      sub({ id: 'soon', next_billing_date: '2026-08-16' }),
      sub({ id: 'late', next_billing_date: '2026-08-11' }),
      sub({ id: 'old', next_billing_date: '2026-08-01' }),
    ];
    expect(upcoming(subs, today).map((s) => s.id)).toEqual(['late', 'soon']);
  });

  it('не показывает отменённые', () => {
    const subs = [sub({ id: 'a', next_billing_date: '2026-08-14', status: 'cancel' })];
    expect(upcoming(subs, today)).toEqual([]);
  });
});
