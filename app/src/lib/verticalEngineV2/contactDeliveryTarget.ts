import { buildContactDeliveryPlan } from './contactDeliveryPlanner';

export interface ContactTargetState {
  target_contacts: number;
  revision: number;
  minimum_target: number;
  actual_contacted: number;
  committed_contacts: number;
  reserved_contacts: number;
  ready_contacts: number;
  deadline: string;
  daily_capacity: number;
  schedule_days: number[];
  timezone: string;
  has_period: boolean;
  can_edit: boolean;
}

export function parseContactTarget(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= 1_000_000 ? number : null;
}

/** Demand, not a promise to upload: stock, campaign pause and today's frozen
 * reservation can reduce the actual tranche independently of this forecast. */
export function contactTargetDailyPlan(state: ContactTargetState, target: number, now = new Date()): number {
  // The server's floor already reconciles period facts with this project's
  // uploads and reservations. Those pending contacts also cover the new goal;
  // only the artificial minimum of 1 for an empty plan is not a commitment.
  const outstanding = state.committed_contacts > 0 || state.reserved_contacts > 0
    ? Math.max(0, state.minimum_target - state.actual_contacted) : 0;
  const plan = buildContactDeliveryPlan({ now, timezone: state.timezone, deadline: state.deadline,
    scheduleDays: state.schedule_days, contactsObligation: target, contactsDone: state.actual_contacted,
    dailyCapacity: state.daily_capacity, availableContacts: target, outstandingContacts: outstanding });
  return plan.days[0]?.quota ?? 0;
}
