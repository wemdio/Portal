/** @jest-environment node */

import {
  buildContactDeliveryPlan,
} from '@/lib/verticalEngineV2/contactDeliveryPlanner';
import { calculateDeliveryRate, distributeDeliveryRate } from '@/lib/verticalEngineV2/contactDeliveryRate';
import { contactTargetDailyPlan, parseContactTarget, type ContactTargetState } from '@/lib/verticalEngineV2/contactDeliveryTarget';
import { AccountStatus, CampaignStatus, type Account, type Campaign } from '@/lib/instantly/types';

describe('buildContactDeliveryPlan', () => {
  it('previews a shared edited target without multiplying it by hypothesis count or changing delivered facts', () => {
    const state: ContactTargetState = { target_contacts: 2000, revision: 0, minimum_target: 38,
      actual_contacted: 0, committed_contacts: 38, reserved_contacts: 0, ready_contacts: 462,
      deadline: '2026-12-20', daily_capacity: 216, schedule_days: [1,2,3,4,5], timezone: 'Europe/Kirov',
      has_period: false, can_edit: true };
    const before = structuredClone(state);
    const now = new Date('2026-10-07T14:00:00Z');
    expect(contactTargetDailyPlan(state, 2000, now)).toBe(38);
    expect(contactTargetDailyPlan(state, 10000, now)).toBe(189);
    expect(contactTargetDailyPlan(state, 20000, now)).toBe(216);
    expect(contactTargetDailyPlan(state, 1000, now)).toBe(19);
    expect(contactTargetDailyPlan(state, 38, now)).toBe(0);
    expect(contactTargetDailyPlan(state, 39, now)).toBe(1);
    expect(contactTargetDailyPlan({ ...state, minimum_target: 40, reserved_contacts: 2 }, 40, now)).toBe(0);
    expect(contactTargetDailyPlan({ ...state, has_period: true, actual_contacted: 1000,
      committed_contacts: 50, minimum_target: 1030 }, 1030, now)).toBe(0);
    expect(contactTargetDailyPlan({ ...state, committed_contacts: 0, minimum_target: 1 }, 1, now)).toBe(1);
    expect(contactTargetDailyPlan({ ...state, actual_contacted: 1000 }, 1000, now)).toBe(0);
    expect(state).toEqual(before);
    for (const value of ['', '1e3', '2.5', '-1', '0', '1000001']) expect(parseContactTarget(value)).toBeNull();
    expect(parseContactTarget(' 10000 ')).toBe(10000);
  });
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
    expect(calculateDeliveryRate(input)).toMatchObject({ mailbox_count: 6, usable_mailboxes: 4,
      busy_mailboxes: 1, unavailable_mailboxes: 2, slow_ramp_mailboxes: 1, email_capacity: 132, max_new_contacts: 44, effective_capacity: 44 });
    expect(calculateDeliveryRate({...input, policy: {mode: 'manual', manual_limit: 10}}).effective_capacity).toBe(10);
    expect(calculateDeliveryRate({...input, policy: {mode: 'manual', manual_limit: 1000}}).effective_capacity).toBe(44);
    // Sharing a mailbox is allowed. The provider enforces its global account
    // limit; foreign campaign count must not multiply or zero that capacity.
    expect(calculateDeliveryRate({...input, otherCampaigns: [...input.otherCampaigns, ...input.otherCampaigns]}).email_capacity).toBe(132);
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

  it('continues after the planning deadline at the chosen pace, with a bounded forecast and the same target', () => {
    const input = { now: new Date('2026-10-02T21:30:00Z'), timezone: 'Europe/Moscow', deadline: '2026-09-30',
      scheduleDays: [1,2,3,4,5], contactsObligation: 800, contactsDone: 0, dailyCapacity: 360,
      availableContacts: 724, outstandingContacts: 50 };
    const plan = buildContactDeliveryPlan(input);
    expect(plan.deadline).toBe('2026-09-30');
    expect(plan.days).toEqual([{ date: '2026-10-05', quota: 360 }, { date: '2026-10-06', quota: 360 },
      { date: '2026-10-07', quota: 4 }]);
    expect(buildContactDeliveryPlan({ ...input, dailyCapacity: 100 }).days[0].quota).toBe(100);
    expect(buildContactDeliveryPlan({ ...input, contactsDone: 800 }).days).toEqual([]);
    expect(buildContactDeliveryPlan({ ...input, dailyCapacity: 0 }).days.every(day => day.quota === 0)).toBe(true);
    expect(buildContactDeliveryPlan({ ...input, dailyCapacity: 1, contactsObligation: 2147483647 }).days).toHaveLength(366);
    expect(buildContactDeliveryPlan({ ...input, outstandingContacts: 800 }).days[0].quota).toBe(0);
  });
});
