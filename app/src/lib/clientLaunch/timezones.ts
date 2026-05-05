/**
 * Timezone whitelist & legacy mapping for Instantly's `campaign_schedule`.
 *
 * Instantly's API v2 enforces a fixed list of ~92 IANA-style timezone ids on
 * `campaign_schedule.schedules[].timezone`. Submitting anything outside that
 * list is rejected with HTTP 400:
 *
 *   "body/campaign_schedule/schedules/0/timezone must be equal to one of the allowed values"
 *
 * Source of truth (May 2026):
 *   https://developer.instantly.ai/api-reference/schemas/campaign
 *
 * The admin preset UI used to expose several values that are NOT in that
 * whitelist (Europe/Moscow, Europe/Samara, Asia/Omsk, Asia/Novosibirsk,
 * Asia/Yakutsk, Asia/Vladivostok, Asia/Magadan, UTC). Existing presets in the
 * database may still hold those legacy ids.
 *
 * Two layers of defense:
 *   1. `INSTANTLY_TIMEZONE_OPTIONS` — narrow Russia-relevant whitelist for the
 *      preset dropdown so admins can ONLY pick valid ids going forward.
 *   2. `normalizeInstantlyTimezone()` — runtime mapper, applied right before
 *      the payload is sent to Instantly, so legacy db rows still work.
 */

/**
 * Full Instantly timezone whitelist (May 2026). Order preserved as in the
 * upstream docs for traceability. If Instantly extends/changes the list,
 * sync this constant.
 */
const INSTANTLY_VALID_TIMEZONES: readonly string[] = [
  'Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10',
  'America/Anchorage', 'America/Dawson', 'America/Creston', 'America/Chihuahua',
  'America/Boise', 'America/Belize', 'America/Chicago', 'America/Bahia_Banderas',
  'America/Regina', 'America/Bogota', 'America/Detroit', 'America/Indiana/Marengo',
  'America/Caracas', 'America/Asuncion', 'America/Glace_Bay', 'America/Campo_Grande',
  'America/Anguilla', 'America/Santiago', 'America/St_Johns', 'America/Sao_Paulo',
  'America/Argentina/La_Rioja', 'America/Araguaina', 'America/Godthab',
  'America/Montevideo', 'America/Bahia', 'America/Noronha', 'America/Scoresbysund',
  'Atlantic/Cape_Verde', 'Africa/Casablanca', 'America/Danmarkshavn',
  'Europe/Isle_of_Man', 'Atlantic/Canary', 'Africa/Abidjan',
  'Arctic/Longyearbyen', 'Europe/Belgrade', 'Africa/Ceuta', 'Europe/Sarajevo',
  'Africa/Algiers', 'Africa/Windhoek', 'Asia/Nicosia', 'Asia/Beirut',
  'Africa/Cairo', 'Asia/Damascus', 'Europe/Bucharest', 'Africa/Blantyre',
  'Europe/Helsinki', 'Europe/Istanbul', 'Asia/Jerusalem', 'Africa/Tripoli',
  'Asia/Amman', 'Asia/Baghdad', 'Europe/Kaliningrad',
  'Asia/Aden', 'Africa/Addis_Ababa', 'Europe/Kirov', 'Europe/Astrakhan',
  'Asia/Tehran', 'Asia/Dubai', 'Asia/Baku', 'Indian/Mahe', 'Asia/Tbilisi',
  'Asia/Yerevan', 'Asia/Kabul', 'Antarctica/Mawson', 'Asia/Yekaterinburg',
  'Asia/Karachi', 'Asia/Kolkata', 'Asia/Colombo', 'Asia/Kathmandu',
  'Antarctica/Vostok', 'Asia/Dhaka', 'Asia/Rangoon', 'Antarctica/Davis',
  'Asia/Novokuznetsk', 'Asia/Hong_Kong', 'Asia/Krasnoyarsk', 'Asia/Brunei',
  'Australia/Perth', 'Asia/Taipei', 'Asia/Choibalsan', 'Asia/Irkutsk',
  'Asia/Dili', 'Asia/Pyongyang', 'Australia/Adelaide', 'Australia/Darwin',
  'Australia/Brisbane', 'Australia/Melbourne', 'Antarctica/DumontDUrville',
  'Australia/Currie', 'Asia/Chita', 'Antarctica/Macquarie', 'Asia/Sakhalin',
  'Pacific/Auckland', 'Etc/GMT-12', 'Pacific/Fiji', 'Asia/Anadyr',
  'Asia/Kamchatka', 'Etc/GMT-13', 'Pacific/Apia',
] as const;

const VALID_SET = new Set<string>(INSTANTLY_VALID_TIMEZONES);

/**
 * Legacy IANA ids that admins picked in the old preset UI but Instantly
 * doesn't accept. Mapping picks the closest equivalent inside the whitelist
 * — same UTC offset where possible, geographically nearest otherwise.
 *
 *   Europe/Moscow      UTC+3  → Europe/Kirov        UTC+3   (exact match)
 *   Europe/Samara      UTC+4  → Europe/Astrakhan    UTC+4   (exact match)
 *   Asia/Omsk          UTC+6  → Asia/Novokuznetsk   UTC+7   (closest, +1h drift)
 *   Asia/Novosibirsk   UTC+7  → Asia/Novokuznetsk   UTC+7   (exact match)
 *   Asia/Yakutsk       UTC+9  → Asia/Chita          UTC+9   (exact match)
 *   Asia/Vladivostok   UTC+10 → Asia/Sakhalin       UTC+11  (no UTC+10 in whitelist)
 *   Asia/Magadan       UTC+11 → Asia/Sakhalin       UTC+11  (exact match)
 *   UTC                UTC+0  → Africa/Abidjan      UTC+0   (always UTC, no DST)
 */
const LEGACY_TZ_MAP: Readonly<Record<string, string>> = Object.freeze({
  'Europe/Moscow': 'Europe/Kirov',
  'Europe/Samara': 'Europe/Astrakhan',
  'Asia/Omsk': 'Asia/Novokuznetsk',
  'Asia/Novosibirsk': 'Asia/Novokuznetsk',
  'Asia/Yakutsk': 'Asia/Chita',
  'Asia/Vladivostok': 'Asia/Sakhalin',
  'Asia/Magadan': 'Asia/Sakhalin',
  'UTC': 'Africa/Abidjan',
});

export function isInstantlyValidTimezone(tz: string): boolean {
  return VALID_SET.has(tz);
}

/**
 * Normalize a timezone id to one Instantly will accept.
 *
 * - whitelisted id → returned unchanged
 * - known legacy id → mapped to closest whitelisted equivalent
 * - unknown id → returned unchanged so Instantly's own 400 surfaces a clear
 *   diagnostic rather than us silently picking a wrong zone.
 */
export function normalizeInstantlyTimezone(tz: string): string {
  if (VALID_SET.has(tz)) return tz;
  return LEGACY_TZ_MAP[tz] ?? tz;
}

/**
 * Russia-relevant timezone options for the admin preset dropdown.
 * Every value is verified against the Instantly whitelist by tests.
 */
export const INSTANTLY_TIMEZONE_OPTIONS: readonly { value: string; label: string }[] =
  Object.freeze([
    { value: 'Europe/Kaliningrad', label: 'Калининград (UTC+2)' },
    { value: 'Europe/Kirov', label: 'Москва, СПб (UTC+3)' },
    { value: 'Europe/Astrakhan', label: 'Самара, Астрахань (UTC+4)' },
    { value: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+5)' },
    { value: 'Asia/Novokuznetsk', label: 'Омск, Новосибирск (UTC+7)' },
    { value: 'Asia/Krasnoyarsk', label: 'Красноярск (UTC+7)' },
    { value: 'Asia/Irkutsk', label: 'Иркутск (UTC+8)' },
    { value: 'Asia/Chita', label: 'Чита, Якутск (UTC+9)' },
    { value: 'Asia/Sakhalin', label: 'Магадан, Владивосток (UTC+11)' },
    { value: 'Asia/Kamchatka', label: 'Камчатка (UTC+12)' },
    { value: 'Africa/Abidjan', label: 'UTC+0 (без перехода)' },
  ]);
