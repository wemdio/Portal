import type {
  CampaignCreatePayload,
  CampaignScheduleDays,
  CampaignUpdatePayload,
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

/**
 * Preset field keys that map to Instantly campaign fields when admin edits
 * the preset. Used to decide which keys trigger a sync to running campaigns.
 *
 * Excluded on purpose:
 *  - `text_only` — forced to true at campaign create; preset value is ignored.
 *  - `instantly_account_id` — picks the Instantly workspace at create time;
 *    can't migrate a live campaign between workspaces.
 */
export const PRESET_KEYS_THAT_SYNC_TO_CAMPAIGN = [
  'email_account_ids',
  'daily_limit',
  'daily_max_leads',
  'email_gap_minutes',
  'open_tracking',
  'link_tracking',
  'stop_on_reply',
  'schedule_from',
  'schedule_to',
  'schedule_days',
  'schedule_timezone',
] as const;

export type PresetKeyThatSyncsToCampaign = (typeof PRESET_KEYS_THAT_SYNC_TO_CAMPAIGN)[number];

/**
 * Converts client-authored plain-text email body into the minimal HTML that
 * Instantly's API expects.
 *
 * Why this is required even with `text_only: true`:
 *
 * Instantly's POST /api/v2/campaigns spec says the `body` field is "HTML body
 * of the email" — meaning Instantly's editor parses it as HTML on input. If we
 * send raw text with `\n`, the HTML parser collapses every newline to a single
 * space (standard HTML whitespace handling), and the campaign editor displays
 * one solid block. At send time `text_only: true` strips HTML to plain text,
 * but by then the newlines are already gone — what client sees in the editor
 * is exactly what the recipient gets.
 *
 * Fix: HTML-escape the special chars (so things like "5 < 10" don't break the
 * markup), then convert each `\n` to `<br>`. Instantly's editor renders this
 * correctly with line breaks; `text_only: true` converts `<br>` back to `\n`
 * at send time; recipient sees the same paragraphing the client typed.
 *
 * Note: Instantly's `{{firstName}}`-style variables use `{` / `}` which are
 * NOT HTML special chars, so escaping leaves them untouched.
 */
export function toInstantlyHtmlBody(plainText: string): string {
  return plainText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>\n');
}

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
          //
          // body конвертим plain-text → минимальный HTML (см. doc-comment
          // у toInstantlyHtmlBody). Без этого Instantly схлопывает все
          // переносы строк, и письмо уходит сплошным абзацем.
          const variants: SequenceVariant[] = [
            { subject: s.subject, body: toInstantlyHtmlBody(s.body) },
            ...(s.variants ?? []).map<SequenceVariant>((v) => ({
              subject: v.subject ?? '',
              body: toInstantlyHtmlBody(v.body),
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
    // Клиентские письма всегда уходят plain-text (без видимой клиенту
    // разметки) — поэтому text_only форсим в true независимо от пресета.
    // ВАЖНО: Instantly API на входе ждёт body именно как HTML (даже при
    // text_only=true) — иначе схлопывает все \n. См. toInstantlyHtmlBody
    // выше: мы конвертируем plain-text → минимальный HTML с <br>,
    // а text_only=true распаковывает обратно в текст при отправке.
    text_only: true,
  };
}

export interface BuildCampaignPresetUpdatePayloadInput {
  /** The preset row AFTER the admin's edits were applied. */
  preset: ClientCampaignPreset;
  /**
   * Set of preset field keys the admin actually changed in this PUT. Only
   * fields in this set get included in the resulting payload — so we never
   * overwrite Instantly state the admin didn't touch (e.g. per-launch
   * schedule overrides set by the client at launch time).
   */
  changedPresetKeys: ReadonlySet<string>;
}

/**
 * Builds a partial CampaignUpdatePayload containing ONLY the preset-managed
 * fields the admin actually changed. Used to sync preset edits to already-
 * running Instantly campaigns via PATCH /campaigns/:id.
 *
 * Never touched here:
 *  - `sequences` — per-campaign content edited via the client UI, must not
 *    be reset by a preset edit.
 *  - `name` — per-launch, not stored on the preset.
 *  - `text_only` — forced to true at create; preset value is ignored.
 *  - workspace / `instantly_account_id` — campaigns can't migrate workspaces.
 *
 * Schedule note: if ANY of from/to/days/timezone changed, we rebuild the
 * whole `campaign_schedule` from the current preset. Partial schedule
 * update would leave the campaign with inconsistent timing. Side effect:
 * pushing the schedule will overwrite any per-launch schedule override
 * the client set — this is the intended behavior when admin edits schedule
 * in the preset (admin's edit wins, by design).
 */
export function buildCampaignPresetUpdatePayload(
  input: BuildCampaignPresetUpdatePayloadInput,
): CampaignUpdatePayload {
  const { preset, changedPresetKeys } = input;
  const payload: CampaignUpdatePayload = {};

  if (changedPresetKeys.has('email_account_ids')) {
    payload.email_list = [...preset.email_account_ids];
  }
  if (changedPresetKeys.has('daily_limit')) {
    payload.daily_limit = preset.daily_limit;
  }
  if (changedPresetKeys.has('daily_max_leads')) {
    payload.daily_max_leads = preset.daily_max_leads;
  }
  if (changedPresetKeys.has('email_gap_minutes')) {
    payload.email_gap = preset.email_gap_minutes;
  }
  if (changedPresetKeys.has('open_tracking')) {
    payload.open_tracking = preset.open_tracking;
  }
  if (changedPresetKeys.has('link_tracking')) {
    payload.link_tracking = preset.link_tracking;
  }
  if (changedPresetKeys.has('stop_on_reply')) {
    payload.stop_on_reply = preset.stop_on_reply;
  }

  const scheduleTouched =
    changedPresetKeys.has('schedule_from') ||
    changedPresetKeys.has('schedule_to') ||
    changedPresetKeys.has('schedule_days') ||
    changedPresetKeys.has('schedule_timezone');

  if (scheduleTouched) {
    const days: CampaignScheduleDays = {};
    for (const d of preset.schedule_days) {
      if (d >= 0 && d <= 6) {
        (days as Record<number, boolean>)[d] = true;
      }
    }
    payload.campaign_schedule = {
      schedules: [
        {
          name: 'Schedule',
          timing: { from: preset.schedule_from, to: preset.schedule_to },
          days,
          timezone: normalizeInstantlyTimezone(preset.schedule_timezone),
        },
      ],
    };
  }

  return payload;
}
