'use client';

import {
  INSTANTLY_TIMEZONE_OPTIONS,
  normalizeInstantlyTimezone,
} from '@/lib/clientLaunch/timezones';
import type { ClientLaunchScheduleOverride } from '@/lib/clientLaunch/types';

/**
 * Weekday picker order. Instantly's day map is keyed 0=Sun..6=Sat, but we
 * present Пн–Вс (Mon-first) because that's how Russian users read a week.
 */
export const SCHEDULE_WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Вс' },
];

/**
 * Shared sending-window editor: from/to time, timezone, weekdays.
 *
 * Used by:
 *   - /client/launch (Step «Расписание» when creating a campaign)
 *   - /client/campaigns/[id] (edit mode — change schedule of a live campaign)
 *
 * Was originally inline in launch/page.tsx; extracted so the campaign-edit
 * flow reuses the exact same widget instead of forking a second copy.
 */
export function ScheduleEditor({
  schedule,
  onChange,
  hydrated,
}: {
  schedule: ClientLaunchScheduleOverride;
  onChange: (next: ClientLaunchScheduleOverride) => void;
  /** When true, render the human-readable summary line below the picker. */
  hydrated: boolean;
}) {
  const toggleDay = (day: number) => {
    const next = schedule.days.includes(day)
      ? schedule.days.filter((d) => d !== day)
      : [...schedule.days, day].sort((a, b) => a - b);
    onChange({ ...schedule, days: next });
  };

  const tzNormalized = normalizeInstantlyTimezone(schedule.timezone);
  const tzLabel =
    INSTANTLY_TIMEZONE_OPTIONS.find((o) => o.value === tzNormalized)?.label ?? tzNormalized;

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div>
          <label className="ds-eyebrow block mb-1.5">время начала</label>
          <input
            type="time"
            value={schedule.from}
            onChange={(e) => onChange({ ...schedule, from: e.target.value })}
            className="ds-input ds-mono w-full text-sm"
          />
        </div>
        <div>
          <label className="ds-eyebrow block mb-1.5">время окончания</label>
          <input
            type="time"
            value={schedule.to}
            onChange={(e) => onChange({ ...schedule, to: e.target.value })}
            className="ds-input ds-mono w-full text-sm"
          />
        </div>
        <div>
          <label className="ds-eyebrow block mb-1.5">часовой пояс</label>
          <select
            value={tzNormalized}
            onChange={(e) => onChange({ ...schedule, timezone: e.target.value })}
            className="ds-input w-full text-sm"
          >
            {INSTANTLY_TIMEZONE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="ds-eyebrow block mb-2">дни недели</label>
        <div className="flex flex-wrap gap-1.5">
          {SCHEDULE_WEEKDAYS.map((d) => {
            const checked = schedule.days.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                className={`ds-nav-item px-3 py-1.5 text-xs ${checked ? 'active' : ''}`}
                aria-pressed={checked}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>
      {hydrated && (
        <p
          className="ds-mono mt-3 text-[11px]"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {schedule.days.length === 0
            ? 'выберите хотя бы один день — иначе кампания не будет отправляться'
            : `${schedule.from}–${schedule.to} (${tzLabel}) в выбранные дни`}
        </p>
      )}
    </div>
  );
}
