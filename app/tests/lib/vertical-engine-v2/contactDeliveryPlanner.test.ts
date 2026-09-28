/** @jest-environment node */

import {
  buildContactDeliveryPlan,
} from '@/lib/verticalEngineV2/contactDeliveryPlanner';
import { calculateDeliveryRate, distributeDeliveryRate } from '@/lib/verticalEngineV2/contactDeliveryRate';
import { AccountStatus, CampaignStatus, type Account, type Campaign } from '@/lib/instantly/types';

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

  it('limits new contacts by real mailboxes, follow-ups and an optional manual ceiling', () => {
    const input = {
      mailboxIds: ['a@example.test', 'b@example.test', 'busy@example.test', 'off@example.test', 'missing@example.test', 'ramp@example.test'],
      accounts: ['a', 'b', 'busy', 'off', 'ramp'].map(name => ({ email: `${name}@example.test`,
        daily_limit: 50, status: name === 'off' ? 0 : AccountStatus.Active,
        enable_slow_ramp: name === 'ramp', sending_gap: name === 'b' ? 10 : 1,
      })) as Account[],
      otherCampaigns: [{ id: 'external', status: CampaignStatus.Active, email_list: ['busy@example.test'] }] as Campaign[],
      sequenceSteps: 3, policy: { mode: 'auto' as const, manual_limit: null }, windowMinutes: 300, gapMinutes: 1,
    };
    expect(calculateDeliveryRate(input)).toMatchObject({ mailbox_count: 6, usable_mailboxes: 3,
      busy_mailboxes: 1, unavailable_mailboxes: 2, slow_ramp_mailboxes: 1, email_capacity: 82, max_new_contacts: 27, effective_capacity: 27 });
    expect(calculateDeliveryRate({...input, policy: {mode: 'manual', manual_limit: 10}}).effective_capacity).toBe(10);
    expect(calculateDeliveryRate({...input, policy: {mode: 'manual', manual_limit: 1000}}).effective_capacity).toBe(27);
    expect(() => calculateDeliveryRate({...input, policy: {mode: 'manual', manual_limit: 0}})).toThrow();
    expect(() => calculateDeliveryRate({...input, otherCampaigns: [{id: 'unknown', status: CampaignStatus.Active} as Campaign]})).toThrow();
    expect(() => calculateDeliveryRate({...input, otherCampaigns: [{id: 'unknown', email_list: ['a@example.test']} as Campaign]})).toThrow('статус');
    expect(distributeDeliveryRate(7, ['b', 'a', 'c'])).toEqual({a: 3, b: 2, c: 2});
    expect(() => distributeDeliveryRate(2, ['a', 'b', 'c'])).toThrow();
    const plan = buildContactDeliveryPlan({ now: new Date('2026-09-28T06:00:00Z'), timezone: 'Europe/Moscow',
      deadline: '2026-09-30', scheduleDays: [1,2,3,4,5], contactsObligation: 4000, contactsDone: 0,
      dailyCapacity: 27, availableContacts: 774 });
    expect(plan.capacityContacts).toBe(81);
    expect(plan.capacityShortfall).toBe(3919);
    expect(plan.days[0].quota).toBe(27);
  });
});
