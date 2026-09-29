import type { Account, Campaign } from '@/lib/instantly/types';
import { AccountStatus, CampaignStatus } from '@/lib/instantly/types';

/** Campaign ceiling is independent of the new-contact quota. Instantly still
 * enforces each mailbox's shared daily limit across all of its campaigns. */
export const VE_CAMPAIGN_SENDING_SETTINGS = {
  daily_limit: 1000,
  open_tracking: false,
  link_tracking: false,
} as const;

export class DeliveryRateError extends Error {}

export type DeliveryRatePolicy = { mode: 'auto' | 'manual'; manual_limit: number | null };
export type DeliveryRateSnapshot = {
  /** busy_mailboxes is informational: these mailboxes are shared, not unavailable. */
  mailbox_count: number; usable_mailboxes: number; busy_mailboxes: number; unavailable_mailboxes: number;
  slow_ramp_mailboxes: number; email_capacity: number; sequence_steps: number; max_new_contacts: number;
  effective_capacity: number; checked_at: string;
};
export type DeliveryRateRow = DeliveryRatePolicy & {
  project_id: string; preset_id: string; template_ids: string[]; revision: number;
  status: 'ready' | 'pending' | 'updating' | 'blocked'; snapshot: DeliveryRateSnapshot;
  effective_capacity: number | null; checked_at: string | null; error: string | null;
};
const emailKey = (value: string) => value.trim().toLowerCase();
export function isSendingCampaign(campaign: Campaign): boolean {
  if (!Object.values(CampaignStatus).includes(campaign.status)) throw new DeliveryRateError('Не удалось определить статус одной из кампаний Instantly. Повторите расчёт.');
  return campaign.status === CampaignStatus.Active || campaign.status === CampaignStatus.RunningSubsequences;
}

/** Upper bound from mailbox limits, allowing every sequence step. Instantly shares each account's limit across campaigns. */
export function calculateDeliveryRate(input: {
  mailboxIds: string[]; accounts: Account[]; otherCampaigns: Campaign[];
  /** Complete union of accounts selected by tags in other sending campaigns. */
  otherCampaignTagMailboxIds?: string[];
  sequenceSteps: number; policy: DeliveryRatePolicy; windowMinutes: number; gapMinutes: number; now?: Date;
}): DeliveryRateSnapshot {
  if (!Number.isSafeInteger(input.sequenceSteps) || input.sequenceSteps < 1 || input.sequenceSteps > 100) throw new DeliveryRateError('Не удалось определить длину цепочки писем.');
  if (input.policy.mode !== 'auto' && input.policy.mode !== 'manual') throw new DeliveryRateError('Неизвестный режим темпа.');
  if (input.policy.mode === 'manual' && (!Number.isSafeInteger(input.policy.manual_limit) || input.policy.manual_limit! <= 0 || input.policy.manual_limit! > 100_000)) throw new DeliveryRateError('Укажите лимит от 1 до 100 000 новых контактов в день.');
  if (!Number.isFinite(input.windowMinutes) || input.windowMinutes <= 0 || !Number.isFinite(input.gapMinutes) || input.gapMinutes < 0) throw new DeliveryRateError('Проверьте время отправки и интервал в профиле клиента.');
  const mailboxes = [...new Set(input.mailboxIds.map(emailKey).filter(Boolean))];
  if (!mailboxes.length) throw new DeliveryRateError('В профиле не выбраны отправители.');
  const byEmail = new Map(input.accounts.map(account => [emailKey(account.email), account]));
  if (byEmail.size !== input.accounts.length) throw new DeliveryRateError('Instantly вернул повторяющиеся почты. Повторите расчёт.');
  const busy = new Set((input.otherCampaignTagMailboxIds ?? []).map(emailKey));
  for (const campaign of input.otherCampaigns.filter(isSendingCampaign)) {
    if (!Array.isArray(campaign.email_list) || (campaign.email_tag_list?.length && !input.otherCampaignTagMailboxIds)) throw new DeliveryRateError('Не удалось точно определить отправителей другой активной кампании.');
    campaign.email_list.forEach(email => busy.add(emailKey(email)));
  }
  let emailCapacity = 0, usable = 0, occupied = 0, unavailable = 0, ramp = 0;
  for (const email of mailboxes) {
    if (busy.has(email)) occupied++;
    const account = byEmail.get(email);
    if (!account || account.status !== AccountStatus.Active || account.setup_pending ||
      !Number.isSafeInteger(account.daily_limit) || account.daily_limit! <= 0) { unavailable++; continue; }
    const gap = Math.max(input.gapMinutes, typeof account.sending_gap === 'number' ? account.sending_gap : 0);
    if (!Number.isFinite(gap) || gap < 0) { unavailable++; continue; }
    const windowCapacity = gap > 0 ? Math.floor(input.windowMinutes / gap) : account.daily_limit!;
    // API does not expose the current slow-ramp allowance. Its documented
    // initial allowance is 2; never infer ramp progress from mailbox age.
    const capacity = Math.min(account.daily_limit!, windowCapacity, account.enable_slow_ramp ? 2 : account.daily_limit!);
    if (capacity <= 0) { unavailable++; continue; }
    if (account.enable_slow_ramp) ramp++;
    emailCapacity += capacity; usable++;
  }
  if (!Number.isSafeInteger(emailCapacity)) throw new DeliveryRateError('Слишком большой лимит почт.');
  const maxNew = Math.floor(emailCapacity / input.sequenceSteps);
  return { mailbox_count: mailboxes.length, usable_mailboxes: usable, busy_mailboxes: occupied,
    unavailable_mailboxes: unavailable, slow_ramp_mailboxes: ramp, email_capacity: emailCapacity,
    sequence_steps: input.sequenceSteps, max_new_contacts: maxNew,
    effective_capacity: input.policy.mode === 'manual' ? Math.min(maxNew, input.policy.manual_limit!) : maxNew,
    checked_at: (input.now ?? new Date()).toISOString() };
}

/** Keep summed new-contact limits within the project delivery budget. Zero is not sent to Instantly. */
export function distributeDeliveryRate(total: number, ids: string[]): Record<string, number> {
  const sorted = [...new Set(ids)].sort();
  if (!Number.isSafeInteger(total) || total < sorted.length) throw new DeliveryRateError('Доступный лимит меньше числа кампаний. Проверьте дневной лимит и доступность отправителей.');
  return Object.fromEntries(sorted.map((id, index) => [id, Math.floor(total / sorted.length) + (index < total % sorted.length ? 1 : 0)]));
}
