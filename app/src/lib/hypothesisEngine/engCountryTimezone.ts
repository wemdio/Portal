/**
 * Пояс окна отправки, подсказанный списком стран проекта (план
 * docs/handoff/2026-10-16-eng-countries/implementation-plan.md, §1C и F3).
 * Чистый модуль, безопасен в браузере.
 *
 * Подсказка есть, только если список непуст, США в нём нет и КАЖДАЯ страна
 * живёт в одном поясе одного класса (WET, CET, EET). Все страны дают один id —
 * он; один класс — id первой по алфавиту страны. Иначе null: клиент выбирает
 * сам, а без выбора остаётся прежний дефолт (Detroit).
 *
 * Только страны с ОДНИМ поясом (Испания с Канарами и Португалия с Азорами — нет).
 * Идентификаторы — из белого списка рассыльщика (Europe/London, Europe/Berlin
 * он не принимает): те же часы, включая переходы на летнее время.
 */

import { isInstantlyValidTimezone } from '@/lib/clientLaunch/timezones';

type OffsetClass = 'WET' | 'CET' | 'EET';

const COUNTRY_ZONE: Readonly<Record<string, readonly [string, OffsetClass]>> = Object.freeze({
  // UTC+0, летом +1.
  'united kingdom': ['Europe/Isle_of_Man', 'WET'],
  'isle of man': ['Europe/Isle_of_Man', 'WET'],
  jersey: ['Europe/Isle_of_Man', 'WET'],
  guernsey: ['Europe/Isle_of_Man', 'WET'],
  ireland: ['Atlantic/Canary', 'WET'],
  'faroe islands': ['Atlantic/Canary', 'WET'],
  // UTC+1, летом +2.
  netherlands: ['Arctic/Longyearbyen', 'CET'],
  germany: ['Arctic/Longyearbyen', 'CET'],
  luxembourg: ['Arctic/Longyearbyen', 'CET'],
  italy: ['Arctic/Longyearbyen', 'CET'],
  sweden: ['Arctic/Longyearbyen', 'CET'],
  norway: ['Arctic/Longyearbyen', 'CET'],
  austria: ['Arctic/Longyearbyen', 'CET'],
  switzerland: ['Arctic/Longyearbyen', 'CET'],
  liechtenstein: ['Arctic/Longyearbyen', 'CET'],
  'san marino': ['Arctic/Longyearbyen', 'CET'],
  'vatican city': ['Arctic/Longyearbyen', 'CET'],
  malta: ['Arctic/Longyearbyen', 'CET'],
  belgium: ['Africa/Ceuta', 'CET'],
  denmark: ['Africa/Ceuta', 'CET'],
  france: ['Africa/Ceuta', 'CET'],
  monaco: ['Africa/Ceuta', 'CET'],
  andorra: ['Africa/Ceuta', 'CET'],
  gibraltar: ['Africa/Ceuta', 'CET'],
  czechia: ['Europe/Belgrade', 'CET'],
  slovakia: ['Europe/Belgrade', 'CET'],
  hungary: ['Europe/Belgrade', 'CET'],
  slovenia: ['Europe/Belgrade', 'CET'],
  serbia: ['Europe/Belgrade', 'CET'],
  montenegro: ['Europe/Belgrade', 'CET'],
  kosovo: ['Europe/Belgrade', 'CET'],
  poland: ['Europe/Sarajevo', 'CET'],
  croatia: ['Europe/Sarajevo', 'CET'],
  'bosnia and herzegovina': ['Europe/Sarajevo', 'CET'],
  'north macedonia': ['Europe/Sarajevo', 'CET'],
  albania: ['Europe/Sarajevo', 'CET'],
  // UTC+2, летом +3.
  finland: ['Europe/Helsinki', 'EET'],
  estonia: ['Europe/Helsinki', 'EET'],
  latvia: ['Europe/Helsinki', 'EET'],
  lithuania: ['Europe/Helsinki', 'EET'],
  bulgaria: ['Europe/Helsinki', 'EET'],
  ukraine: ['Europe/Helsinki', 'EET'],
  greece: ['Europe/Bucharest', 'EET'],
  romania: ['Europe/Bucharest', 'EET'],
  moldova: ['Europe/Bucharest', 'EET'],
  cyprus: ['Asia/Nicosia', 'EET'],
});

export function suggestEngTimezoneForCountries(countries: readonly string[]): string | null {
  if (countries.length === 0 || countries.includes('united states')) return null;
  const sorted = [...new Set(countries)].sort();
  const zones = sorted.map((c) => COUNTRY_ZONE[c]);
  if (zones.some((z) => z === undefined)) return null;
  const classes = new Set(zones.map((z) => z![1]));
  if (classes.size !== 1) return null;
  const id = zones[0]![0];
  return isInstantlyValidTimezone(id) ? id : null;
}
