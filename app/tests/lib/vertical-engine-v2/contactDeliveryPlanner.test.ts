/** @jest-environment node */

import {
  buildContactDeliveryPlan,
} from '@/lib/verticalEngineV2/contactDeliveryPlanner';

describe('buildContactDeliveryPlan', () => {
  it('uses local schedule dates through the inclusive deadline and reports independent shortfalls', () => {
    const plan = buildContactDeliveryPlan({
      now: new Date('2026-09-06T21:30:00.000Z'),
      timezone: 'Europe/Moscow',
      deadline: '2026-09-11',
      scheduleDays: [1, 2, 3, 4, 5],
      contactsObligation: 23,
      contactsDone: 10,
      dailyCapacity: 2,
      availableContacts: 8,
    });

    expect(plan).toMatchObject({
      businessDate: '2026-09-07',
      deadline: '2026-09-11',
      remainingContacts: 13,
      plannedContacts: 8,
      capacityContacts: 10,
      capacityShortfall: 3,
      supplyShortfall: 5,
      totalShortfall: 5,
    });
    expect(plan.days).toEqual([
      { date: '2026-09-07', quota: 2 },
      { date: '2026-09-08', quota: 2 },
      { date: '2026-09-09', quota: 2 },
      { date: '2026-09-10', quota: 2 },
      { date: '2026-09-11', quota: 0 },
    ]);
  });
});
