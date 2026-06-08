/**
 * Working-hours normalizers for the LinkedIn Outreach 2.0 (`li2_*`) tables.
 *
 * TG outreach defines `sleep_periods` — windows where the worker stays idle.
 * The LinkedIn flavour inverts this: per-campaign `working_hours` describe the
 * window during which the OpenOutreach runtime is allowed to send invites and
 * reply. Stored on `li2_campaigns` as `text[]` so users can specify multiple
 * windows (e.g. a lunch break).
 */

/**
 * Normalize a working-hours payload into `["HH:MM-HH:MM", ...]`.
 *
 * Accepts an array of strings or a single comma-separated string (the shape
 * the UI sends, mirroring TG outreach's sleep_periods field). Returns `null`
 * when the caller didn't send anything — let the DB default kick in. Invalid
 * entries (wrong format, garbage) are dropped silently; the runtime needs
 * strict "HH:MM-HH:MM" to compare against the clock.
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
