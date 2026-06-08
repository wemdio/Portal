/**
 * Per-campaign working-hours helpers shared by li-outreach (v1) and
 * li-outreach-v2.
 *
 * TG outreach defines `sleep_periods` — windows where the worker stays idle.
 * The LinkedIn flavours invert this: `working_hours` describes the window
 * during which the campaign runner is allowed to send invites and reply.
 * Stored as `text[]` so users can specify multiple windows (e.g. a lunch
 * break). An empty array means "always on" — no restriction.
 */

/**
 * Normalize a working-hours payload into `["HH:MM-HH:MM", ...]`.
 *
 * Accepts an array of strings or a single comma-separated string (the shape
 * the UI sends, mirroring TG outreach's sleep_periods field). Returns `null`
 * when the caller didn't send anything — leave the existing DB value alone.
 * Invalid entries (wrong format, garbage) are dropped silently; the runtime
 * needs strict "HH:MM-HH:MM" to compare against the clock.
 */
export function normalizeWorkingHours(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const items = Array.isArray(raw)
    ? raw.map((item) => String(item))
    : String(raw).split(',');
  const cleaned: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(trimmed)) continue;
    cleaned.push(trimmed);
  }
  return cleaned;
}

export function normalizeTimezoneOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  // Clamp to a sane range (covers every real-world UTC offset incl. Kiribati
  // +14 and Baker Island −12). Anything outside is almost certainly a typo.
  return Math.max(-12, Math.min(14, Math.trunc(n)));
}

/**
 * Returns true if the local time at `timezoneOffset` (hours from UTC) falls
 * inside at least one of the `workingHours` windows.
 *
 * Contract for callers:
 *   - Empty / missing array → ALWAYS in window (no restriction). This keeps
 *     legacy campaigns (created before the column existed, default `[]`)
 *     running 24/7 like they did before the migration.
 *   - Windows that wrap midnight (e.g. "22:00-06:00") are supported.
 *
 * Mirrors `isInSleepPeriod` in tgOutreach/campaignLoop.ts (just inverted in
 * meaning) so the two outreach tools have identical clock semantics.
 */
export function isInWorkingHours(
  workingHours: string[] | null | undefined,
  timezoneOffset: number,
  now: Date = new Date(),
): boolean {
  if (!Array.isArray(workingHours) || workingHours.length === 0) return true;

  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const localMinutes = (utcH * 60 + utcM + timezoneOffset * 60 + 1440) % 1440;

  for (const period of workingHours) {
    const match = period.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!match) continue;
    const startMin = Number(match[1]) * 60 + Number(match[2]);
    const endMin = Number(match[3]) * 60 + Number(match[4]);
    if (startMin <= endMin) {
      if (localMinutes >= startMin && localMinutes < endMin) return true;
    } else {
      // Window wraps midnight, e.g. "22:00-06:00".
      if (localMinutes >= startMin || localMinutes < endMin) return true;
    }
  }
  return false;
}
