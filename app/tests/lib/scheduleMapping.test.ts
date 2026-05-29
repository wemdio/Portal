/**
 * @jest-environment node
 *
 * Tests for the schedule mapping helpers used by:
 *   - buildCampaignPayload (create + preset-sync)
 *   - PATCH /api/client/campaigns/[id] (edit live campaign schedule)
 *   - /client/campaigns/[id] edit UI (load current schedule)
 *
 * The flat override shape ({ from, to, days: number[], timezone }) and
 * Instantly's nested campaign_schedule must round-trip cleanly, and
 * validation must catch the three real failure modes (bad time format,
 * to≤from, zero days).
 */

import {
  buildCampaignSchedule,
  campaignScheduleToOverride,
  validateScheduleOverride,
  SCHEDULE_DEFAULTS,
} from '@/lib/clientLaunch/scheduleMapping';
import type { CampaignSchedule } from '@/lib/instantly/types';

describe('buildCampaignSchedule', () => {
  it('maps override → Instantly campaign_schedule with day map', () => {
    const out = buildCampaignSchedule({
      from: '10:00',
      to: '19:00',
      days: [1, 3, 5],
      timezone: 'Europe/Moscow',
    });
    expect(out.schedules).toHaveLength(1);
    const entry = out.schedules[0];
    expect(entry.timing).toEqual({ from: '10:00', to: '19:00' });
    expect(entry.days).toEqual({ 1: true, 3: true, 5: true });
    expect(entry.timezone).toBeTruthy();
    expect(entry.name).toBe('Schedule');
  });

  it('filters out-of-range day numbers', () => {
    const out = buildCampaignSchedule({
      from: '09:00',
      to: '18:00',
      days: [-1, 0, 2, 6, 7, 99],
      timezone: 'Europe/Moscow',
    });
    expect(out.schedules[0].days).toEqual({ 0: true, 2: true, 6: true });
  });

  it('normalizes the timezone', () => {
    // Legacy/odd timezone strings get normalized to a valid IANA id —
    // exact target depends on normalizeInstantlyTimezone, but it must be
    // a non-empty string and not throw.
    const out = buildCampaignSchedule({
      from: '09:00',
      to: '18:00',
      days: [1],
      timezone: 'Europe/Moscow',
    });
    expect(typeof out.schedules[0].timezone).toBe('string');
    expect(out.schedules[0].timezone.length).toBeGreaterThan(0);
  });
});

describe('campaignScheduleToOverride', () => {
  it('maps Instantly campaign_schedule → flat override', () => {
    const schedule: CampaignSchedule = {
      schedules: [
        {
          name: 'Schedule',
          timing: { from: '08:30', to: '17:30' },
          days: { 1: true, 2: true, 4: true },
          timezone: 'Europe/Moscow',
        },
      ],
    };
    const out = campaignScheduleToOverride(schedule);
    expect(out.from).toBe('08:30');
    expect(out.to).toBe('17:30');
    expect(out.days).toEqual([1, 2, 4]);
    expect(out.timezone).toBeTruthy();
  });

  it('null/undefined schedule → defaults (editor never renders blank)', () => {
    const fromNull = campaignScheduleToOverride(null);
    const fromUndef = campaignScheduleToOverride(undefined);
    for (const out of [fromNull, fromUndef]) {
      expect(out.from).toBe(SCHEDULE_DEFAULTS.from);
      expect(out.to).toBe(SCHEDULE_DEFAULTS.to);
      expect(out.days).toEqual([...SCHEDULE_DEFAULTS.days]);
      expect(out.timezone).toBe(SCHEDULE_DEFAULTS.timezone);
    }
  });

  it('empty schedules array → defaults', () => {
    const out = campaignScheduleToOverride({ schedules: [] });
    expect(out.days).toEqual([...SCHEDULE_DEFAULTS.days]);
  });

  it('schedule with zero selected days → falls back to default weekdays', () => {
    // A campaign that somehow has no days selected would «never send».
    // Loading it into the editor should show the default weekday set
    // rather than an empty selection.
    const out = campaignScheduleToOverride({
      schedules: [
        { name: 'Schedule', timing: { from: '09:00', to: '18:00' }, days: {}, timezone: 'Europe/Moscow' },
      ],
    });
    expect(out.days).toEqual([...SCHEDULE_DEFAULTS.days]);
  });

  it('missing timing/timezone → per-field defaults', () => {
    const out = campaignScheduleToOverride({
      schedules: [
        // @ts-expect-error — intentionally malformed to test defensive defaults
        { name: 'Schedule', days: { 1: true } },
      ],
    });
    expect(out.from).toBe(SCHEDULE_DEFAULTS.from);
    expect(out.to).toBe(SCHEDULE_DEFAULTS.to);
    expect(out.days).toEqual([1]);
  });
});

describe('round-trip override ↔ campaign_schedule', () => {
  it('override → schedule → override is stable', () => {
    const original = {
      from: '11:15',
      to: '20:45',
      days: [0, 2, 4, 6],
      timezone: 'Europe/Moscow',
    };
    const schedule = buildCampaignSchedule(original);
    const back = campaignScheduleToOverride(schedule);
    expect(back.from).toBe(original.from);
    expect(back.to).toBe(original.to);
    expect(back.days).toEqual(original.days);
  });
});

describe('validateScheduleOverride', () => {
  const base = { from: '09:00', to: '18:00', days: [1, 2, 3], timezone: 'Europe/Moscow' };

  it('accepts a valid schedule', () => {
    expect(validateScheduleOverride(base)).toEqual({ ok: true });
  });

  it('rejects malformed from time', () => {
    const r = validateScheduleOverride({ ...base, from: '9am' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ЧЧ:ММ/);
  });

  it('rejects malformed to time', () => {
    const r = validateScheduleOverride({ ...base, to: '25:00' });
    expect(r.ok).toBe(false);
  });

  it('rejects to <= from', () => {
    const equal = validateScheduleOverride({ ...base, from: '18:00', to: '18:00' });
    expect(equal.ok).toBe(false);
    const reversed = validateScheduleOverride({ ...base, from: '19:00', to: '09:00' });
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.error).toMatch(/позже/);
  });

  it('rejects empty day selection', () => {
    const r = validateScheduleOverride({ ...base, days: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/день/);
  });
});
