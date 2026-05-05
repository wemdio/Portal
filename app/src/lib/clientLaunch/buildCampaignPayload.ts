import type {
  CampaignCreatePayload,
  CampaignScheduleDays,
  SequenceStep,
  SequenceVariant,
} from '@/lib/instantly/types';
import type {
  ClientCampaignPreset,
  ClientLaunchScheduleOverride,
  ClientLaunchSequence,
} from './types';
import { normalizeInstantlyTimezone } from './timezones';

export interface BuildCampaignPayloadInput {
  preset: ClientCampaignPreset;
  sequence: ClientLaunchSequence;
  /**
   * Optional per-launch schedule override. When present, replaces the preset's
   * schedule_from/to/days/timezone in the resulting campaign payload.
   */
  scheduleOverride?: ClientLaunchScheduleOverride;
}

/**
 * Translates a stored client preset + a sequence the client just authored
 * into the payload shape Instantly's POST /campaigns expects.
 */
export function buildCampaignPayloadFromPreset(
  input: BuildCampaignPayloadInput,
): CampaignCreatePayload {
  const { preset, sequence, scheduleOverride } = input;

  const fromValue = scheduleOverride?.from ?? preset.schedule_from;
  const toValue = scheduleOverride?.to ?? preset.schedule_to;
  const dayValues = scheduleOverride?.days ?? preset.schedule_days;
  const tzValue = scheduleOverride?.timezone ?? preset.schedule_timezone;

  const days: CampaignScheduleDays = {};
  for (const d of dayValues) {
    if (d >= 0 && d <= 6) {
      (days as Record<number, boolean>)[d] = true;
    }
  }

  return {
    name: sequence.name.trim(),
    campaign_schedule: {
      schedules: [
        {
          name: 'Schedule',
          timing: { from: fromValue, to: toValue },
          days,
          timezone: normalizeInstantlyTimezone(tzValue),
        },
      ],
    },
    sequences: [
      {
        steps: sequence.steps.map<SequenceStep>((s) => {
          const step: SequenceStep = {
            type: 'email',
            subject: s.subject,
            body: s.body,
            wait_days: s.wait_days,
          };
          if (s.variants && s.variants.length > 0) {
            step.variants = s.variants.map<SequenceVariant>((v) => ({
              subject: v.subject ?? '',
              body: v.body,
            }));
          }
          return step;
        }),
      },
    ],
    email_list: [...preset.email_account_ids],
    daily_limit: preset.daily_limit,
    daily_max_leads: preset.daily_max_leads,
    email_gap: preset.email_gap_minutes,
    open_tracking: preset.open_tracking,
    link_tracking: preset.link_tracking,
    stop_on_reply: preset.stop_on_reply,
    text_only: preset.text_only,
  };
}
