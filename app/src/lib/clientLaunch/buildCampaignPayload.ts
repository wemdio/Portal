import type { CampaignCreatePayload, CampaignScheduleDays } from '@/lib/instantly/types';
import type { ClientCampaignPreset, ClientLaunchSequence } from './types';

export interface BuildCampaignPayloadInput {
  preset: ClientCampaignPreset;
  sequence: ClientLaunchSequence;
}

/**
 * Translates a stored client preset + a sequence the client just authored
 * into the payload shape Instantly's POST /campaigns expects.
 */
export function buildCampaignPayloadFromPreset(
  input: BuildCampaignPayloadInput,
): CampaignCreatePayload {
  const { preset, sequence } = input;

  const days: CampaignScheduleDays = {};
  for (const d of preset.schedule_days) {
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
          timing: { from: preset.schedule_from, to: preset.schedule_to },
          days,
          timezone: preset.schedule_timezone,
        },
      ],
    },
    sequences: [
      {
        steps: sequence.steps.map((s) => ({
          type: 'email',
          subject: s.subject,
          body: s.body,
          wait_days: s.wait_days,
        })),
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
