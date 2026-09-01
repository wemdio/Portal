import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import UpcomingList from '@/components/tech-calendar/UpcomingList';
import type { TechSubscription } from '@/lib/techCalendar/types';

function subscription(
  status: TechSubscription['status'],
  nextBillingDate = '2026-09-03',
): TechSubscription {
  return {
    id: `sub-${status}`,
    service_name: 'Прокси',
    service_type: 'proxy',
    amount: 1_000,
    currency: 'RUB',
    billing_cycle: 'monthly',
    next_billing_date: nextBillingDate,
    status,
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
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  };
}

describe('UpcomingList technician payment actions', () => {
  it('requires «Оставить» before offering paid renewal', async () => {
    const user = userEvent.setup();
    const onDecide = jest.fn();

    render(
      <UpcomingList
        subscriptions={[subscription('pending_review')]}
        today="2026-09-01"
        onRenew={jest.fn()}
        onDecide={onDecide}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Оплачено — продлить' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Оставить' }));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }), 'keep');
  });

  it('does not offer paid renewal before the accepted service reaches its billing date', () => {
    render(
      <UpcomingList
        subscriptions={[subscription('keep')]}
        today="2026-09-01"
        onRenew={jest.fn()}
        onDecide={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Оставить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Оплачено — продлить' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отменить' })).toBeInTheDocument();
  });

  it('offers paid renewal for a due accepted service and hides destructive decisions', async () => {
    const user = userEvent.setup();
    const onRenew = jest.fn();

    render(
      <UpcomingList
        subscriptions={[subscription('keep', '2026-09-01')]}
        today="2026-09-01"
        onRenew={onRenew}
        onDecide={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Оставить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отменить' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Оплачено — продлить' }));
    expect(onRenew).toHaveBeenCalledWith(expect.objectContaining({ status: 'keep' }));
  });
});
