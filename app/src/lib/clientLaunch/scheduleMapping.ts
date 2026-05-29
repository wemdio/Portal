import type { CampaignSchedule, CampaignScheduleDays } from '@/lib/instantly/types';
import type { ClientLaunchScheduleOverride } from './types';
import { normalizeInstantlyTimezone } from './timezones';

/**
 * Bidirectional mapping between the flat schedule shape the UI works with
 * (`ClientLaunchScheduleOverride` = { from, to, days: number[], timezone })
 * and Instantly's nested `campaign_schedule` ({ schedules: [{ timing,
 * days: {0:true,...}, timezone }] }).
 *
 * Centralised here because three places need it:
 *   - buildCampaignPayload (create + preset-sync)
 *   - PATCH /api/client/campaigns/[id] (edit live campaign schedule)
 *   - /client/campaigns/[id] edit UI (load current schedule into editor)
 *
 * Previously the override→Instantly direction was copy-pasted in two
 * spots in buildCampaignPayload; now both call buildCampaignSchedule.
 */

export const SCHEDULE_DEFAULTS = {
  from: '09:00',
  to: '18:00',
  days: [1, 2, 3, 4, 5] as const,
  timezone: 'Europe/Moscow',
} as const;

/** Build Instantly's `campaign_schedule` from the flat override shape. */
export function buildCampaignSchedule(override: {
  from: string;
  to: string;
  days: number[];
  timezone: string;
}): CampaignSchedule {
  const days: CampaignScheduleDays = {};
  for (const d of override.days) {
    if (d >= 0 && d <= 6) {
      (days as Record<number, boolean>)[d] = true;
    }
  }
  return {
    schedules: [
      {
        name: 'Schedule',
        timing: { from: override.from, to: override.to },
        days,
        timezone: normalizeInstantlyTimezone(override.timezone),
      },
    ],
  };
}

/**
 * Map Instantly's `campaign_schedule` back to the flat override shape the
 * ScheduleEditor consumes. Reads only the first schedule entry (our
 * campaigns always have exactly one). Missing/garbage input → sensible
 * defaults so the editor never renders blank.
 */
export function campaignScheduleToOverride(
  schedule: CampaignSchedule | null | undefined,
): ClientLaunchScheduleOverride {
  const entry = schedule?.schedules?.[0];
  if (!entry) {
    return {
      from: SCHEDULE_DEFAULTS.from,
      to: SCHEDULE_DEFAULTS.to,
      days: [...SCHEDULE_DEFAULTS.days],
      timezone: SCHEDULE_DEFAULTS.timezone,
    };
  }
  const days: number[] = [];
  const dayMap = (entry.days ?? {}) as Record<number, boolean>;
  for (let d = 0; d <= 6; d += 1) {
    if (dayMap[d]) days.push(d);
  }
  return {
    from: entry.timing?.from || SCHEDULE_DEFAULTS.from,
    to: entry.timing?.to || SCHEDULE_DEFAULTS.to,
    // Empty day set would mean «never sends» — fall back to weekdays so
    // the editor shows a usable default rather than zero selected days.
    days: days.length > 0 ? days : [...SCHEDULE_DEFAULTS.days],
    timezone: normalizeInstantlyTimezone(entry.timezone || SCHEDULE_DEFAULTS.timezone),
  };
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validate a schedule override the way the client launch flow does:
 *   - from/to are HH:MM
 *   - to is strictly after from
 *   - at least one weekday selected
 * Returns { ok: true } or { ok: false, error }.
 */
export function validateScheduleOverride(
  s: ClientLaunchScheduleOverride,
): { ok: true } | { ok: false; error: string } {
  if (!HHMM_RE.test(s.from) || !HHMM_RE.test(s.to)) {
    return { ok: false, error: 'Расписание: некорректное время (используйте формат ЧЧ:ММ)' };
  }
  if (s.from >= s.to) {
    return { ok: false, error: 'Расписание: время окончания должно быть позже времени начала' };
  }
  if (!Array.isArray(s.days) || s.days.length === 0) {
    return { ok: false, error: 'Расписание: выберите хотя бы один день недели' };
  }
  return { ok: true };
}
