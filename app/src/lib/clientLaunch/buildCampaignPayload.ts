import type {
  CampaignCreatePayload,
  CampaignScheduleDays,
  SequenceStep,
  SequenceVariant,
} from '@/lib/instantly/types';
import type {
  ClientCampaignPreset,
  ClientLaunchBehaviorOverride,
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
  /**
   * Optional per-launch behavior override. Defaults are pre-filled from the
   * preset in the client UI, but the client can adjust these for one campaign.
   */
  behaviorOverride?: ClientLaunchBehaviorOverride;
}

/**
 * Translates a stored client preset + a sequence the client just authored
 * into the payload shape Instantly's POST /campaigns expects.
 */
export function buildCampaignPayloadFromPreset(
  input: BuildCampaignPayloadInput,
): CampaignCreatePayload {
  const { preset, sequence, scheduleOverride, behaviorOverride } = input;

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
        steps: sequence.steps.map<SequenceStep>((s, i, arr) => {
          // Instantly API v2 требует на каждом шаге `delay` (+ `delay_unit`),
          // а не `wait_days` — иначе POST /campaigns падает с 400
          // "steps/0 must have required property 'delay'". По докам Instantly
          // `delay` — это сколько дней ждать перед СЛЕДУЮЩИМ письмом. В нашем
          // UI этот промежуток хранится как `wait_days` следующего шага
          // («Письмо N — через X дн»). У последнего шага следующего письма
          // нет → ставим 1 (как в админском флоу instantly/campaigns/new).
          const delay = i < arr.length - 1 ? arr[i + 1].wait_days : 1;

          // Instantly v2 держит контент письма в `variants[]` (тоже
          // обязательное поле), а не в subject/body самого шага. subject/body
          // шага — это Вариант A; s.variants — дополнительные B/C. Instantly
          // случайно выбирает один вариант на каждого лида.
          const variants: SequenceVariant[] = [
            { subject: s.subject, body: s.body },
            ...(s.variants ?? []).map<SequenceVariant>((v) => ({
              subject: v.subject ?? '',
              body: v.body,
            })),
          ];

          return {
            type: 'email',
            delay,
            delay_unit: 'days',
            variants,
          };
        }),
      },
    ],
    email_list: [...preset.email_account_ids],
    daily_limit: preset.daily_limit,
    daily_max_leads: preset.daily_max_leads,
    email_gap: preset.email_gap_minutes,
    open_tracking: behaviorOverride?.open_tracking ?? preset.open_tracking,
    link_tracking: preset.link_tracking,
    stop_on_reply: behaviorOverride?.stop_on_reply ?? preset.stop_on_reply,
    // Клиентские письма всегда уходят plain-text: никакого HTML, переносы
    // строк сохраняются ровно как их набрал клиент. Поэтому text_only
    // форсим в true независимо от пресета — в клиентском портале HTML
    // запрещён, письмо уходит как написано.
    text_only: true,
  };
}
