/**
 * Данные полного списка поясов окна отправки ENG-кабинета (план
 * docs/handoff/2026-10-16-eng-countries/implementation-plan.md, §1C). Только
 * данные: сборка списка, фильтр по белому списку рассыльщика и разбор — в
 * `_launchWindow.ts`.
 *
 * Значения — идентификаторы из `INSTANTLY_VALID_TIMEZONES`
 * (`lib/clientLaunch/timezones.ts`), порядок строк — порядок выпадашки, группы
 * идут подряд (кабинет рисует их `<optgroup>`). Подписи называют города, а не
 * идентификаторы: в белом списке рассыльщика многие зоны — «соседи» нужного
 * города с теми же часами (Europe/London он не принимает, Europe/Isle_of_Man —
 * да), и клиенту `Arctic/Longyearbyen` ничего не скажет.
 *
 * Смещения в скобках сверены с Intl (tzdata 2025b) на 15 января и 15 июля
 * 2026–2027. Восемь прежних пунктов (`ENG_SENDING_WINDOW_TIMEZONES`) идут
 * здесь со своими значениями, но подписи у части длиннее (больше городов);
 * старое поле `timezones` отдаёт прежние подписи байт в байт.
 */

/** Строка таблицы: value уезжает рассыльщику, label видит клиент, group — заголовок группы. */
export interface EngTimezoneTableEntry {
  readonly value: string;
  readonly label: string;
  readonly group: string;
}

const US_CA = 'United States & Canada';
const GL = 'Greenland';
const LA = 'Mexico, Central & South America';
const EU = 'Europe';
const AF = 'Africa';
const ME = 'Middle East';
const AS = 'Asia';
const AP = 'Australia & Pacific';
const UT = 'UTC';

function row(value: string, label: string, group: string): EngTimezoneTableEntry {
  return Object.freeze({ value, label, group });
}

export const ENG_TIMEZONE_TABLE: readonly EngTimezoneTableEntry[] = Object.freeze([
  row('America/Detroit', 'Eastern time — New York, Toronto', US_CA),
  row('America/Indiana/Marengo', 'Eastern time — Indianapolis (same hours as New York)', US_CA),
  row('America/Chicago', 'Central time — Chicago, Dallas, Winnipeg', US_CA),
  row('America/Boise', 'Mountain time — Denver, Salt Lake City, Calgary, Edmonton', US_CA),
  row('America/Creston', 'Arizona — Phoenix (no daylight saving)', US_CA),
  row(
    'America/Dawson',
    'Pacific — Los Angeles, Seattle, Vancouver (fixed UTC-7: in winter, emails go out 1 hour earlier local time)',
    US_CA,
  ),
  row('America/Anchorage', 'Alaska time — Anchorage', US_CA),
  row('Etc/GMT+10', 'Hawaii — Honolulu (no daylight saving)', US_CA),
  row('America/Regina', 'Saskatchewan — Regina (UTC-6)', US_CA),
  row('America/Glace_Bay', 'Atlantic time — Halifax, Bermuda (UTC-4, UTC-3 in summer)', US_CA),
  row('America/St_Johns', "Newfoundland — St. John's (UTC-3:30, UTC-2:30 in summer)", US_CA),

  row('America/Godthab', 'Greenland — Nuuk (UTC-2, UTC-1 in summer)', GL),
  row('America/Scoresbysund', 'East Greenland — Ittoqqortoormiit (UTC-2, UTC-1 in summer)', GL),

  row('America/Chihuahua', 'Chihuahua (UTC-6)', LA),
  row('America/Bahia_Banderas', 'Mexico City, Guadalajara, Monterrey (UTC-6)', LA),
  row('America/Belize', 'Central America — Guatemala, San José, San Salvador (UTC-6)', LA),
  row('America/Bogota', 'Bogotá, Lima, Quito, Panama (UTC-5)', LA),
  row('America/Caracas', 'Caracas (UTC-4)', LA),
  row('America/Anguilla', 'Caribbean — San Juan, Santo Domingo, La Paz (UTC-4)', LA),
  row('America/Campo_Grande', 'Campo Grande, Cuiabá (UTC-4)', LA),
  row('America/Santiago', 'Santiago (UTC-4, UTC-3 in summer)', LA),
  row('America/Asuncion', 'Asunción (UTC-3)', LA),
  row('America/Sao_Paulo', 'São Paulo, Rio de Janeiro, Brasília (UTC-3)', LA),
  row('America/Argentina/La_Rioja', 'Buenos Aires, Córdoba (UTC-3)', LA),
  row('America/Araguaina', 'Fortaleza, Cayenne, Paramaribo (UTC-3)', LA),
  row('America/Montevideo', 'Montevideo (UTC-3)', LA),
  row('America/Bahia', 'Salvador, Bahia (UTC-3)', LA),
  row('America/Noronha', 'Fernando de Noronha (UTC-2)', LA),

  row('Europe/Isle_of_Man', 'London, Edinburgh, Belfast (UTC+0, UTC+1 in summer)', EU),
  row('Atlantic/Canary', 'Dublin, Lisbon, Canary Islands (UTC+0, UTC+1 in summer)', EU),
  row('America/Danmarkshavn', 'Reykjavik (UTC+0)', EU),
  row('Arctic/Longyearbyen', 'Amsterdam, Berlin, Luxembourg, Rome, Stockholm, Vienna (UTC+1, UTC+2 in summer)', EU),
  row('Africa/Ceuta', 'Brussels, Copenhagen, Madrid, Paris (UTC+1, UTC+2 in summer)', EU),
  row('Europe/Belgrade', 'Belgrade, Bratislava, Budapest, Ljubljana, Prague (UTC+1, UTC+2 in summer)', EU),
  row('Europe/Sarajevo', 'Sarajevo, Skopje, Warsaw, Zagreb (UTC+1, UTC+2 in summer)', EU),
  row('Europe/Kaliningrad', 'Kaliningrad (UTC+2)', EU),
  row('Europe/Bucharest', 'Athens, Bucharest, Chisinau (UTC+2, UTC+3 in summer)', EU),
  row('Europe/Helsinki', 'Helsinki, Kyiv, Riga, Sofia, Tallinn, Vilnius (UTC+2, UTC+3 in summer)', EU),
  row('Asia/Nicosia', 'Nicosia, Cyprus (UTC+2, UTC+3 in summer)', EU),
  row('Europe/Istanbul', 'Istanbul (UTC+3)', EU),
  row('Europe/Kirov', 'Moscow, St. Petersburg, Minsk (UTC+3)', EU),
  row('Europe/Astrakhan', 'Samara, Astrakhan, Ulyanovsk (UTC+4)', EU),

  row('Atlantic/Cape_Verde', 'Cape Verde (UTC-1)', AF),
  row('Africa/Casablanca', 'Casablanca, Rabat (UTC+1, UTC+0 during Ramadan)', AF),
  row('Africa/Algiers', 'Lagos, Algiers, Kinshasa, Tunis (UTC+1)', AF),
  row('Africa/Windhoek', 'Windhoek (UTC+2)', AF),
  row('Africa/Blantyre', 'Johannesburg, Harare, Maputo (UTC+2)', AF),
  row('Africa/Tripoli', 'Tripoli (UTC+2)', AF),
  row('Africa/Cairo', 'Cairo (UTC+2, UTC+3 in summer)', AF),
  row('Africa/Addis_Ababa', 'Nairobi, Addis Ababa, Kampala (UTC+3)', AF),
  row('Indian/Mahe', 'Mauritius, Seychelles, Réunion (UTC+4)', AF),

  row('Asia/Beirut', 'Beirut (UTC+2, UTC+3 in summer)', ME),
  row('Asia/Jerusalem', 'Jerusalem, Tel Aviv (UTC+2, UTC+3 in summer)', ME),
  row('Asia/Damascus', 'Damascus (UTC+3)', ME),
  row('Asia/Amman', 'Amman (UTC+3)', ME),
  row('Asia/Baghdad', 'Baghdad (UTC+3)', ME),
  row('Asia/Aden', 'Riyadh, Kuwait, Doha, Bahrain (UTC+3)', ME),
  row('Asia/Tehran', 'Tehran (UTC+3:30)', ME),
  row('Asia/Dubai', 'Dubai, Abu Dhabi, Muscat (UTC+4)', ME),

  row('Asia/Baku', 'Baku (UTC+4)', AS),
  row('Asia/Tbilisi', 'Tbilisi (UTC+4)', AS),
  row('Asia/Yerevan', 'Yerevan (UTC+4)', AS),
  row('Asia/Kabul', 'Kabul (UTC+4:30)', AS),
  row('Antarctica/Mawson', 'Tashkent, Ashgabat, Dushanbe (UTC+5)', AS),
  row('Asia/Yekaterinburg', 'Yekaterinburg (UTC+5)', AS),
  row('Asia/Karachi', 'Karachi, Islamabad (UTC+5)', AS),
  row('Antarctica/Vostok', 'Astana, Almaty (UTC+5)', AS),
  row('Asia/Kolkata', 'Mumbai, New Delhi, Bengaluru, Kolkata (UTC+5:30)', AS),
  row('Asia/Colombo', 'Colombo (UTC+5:30)', AS),
  row('Asia/Kathmandu', 'Kathmandu (UTC+5:45)', AS),
  row('Asia/Dhaka', 'Dhaka, Bishkek, Omsk (UTC+6)', AS),
  row('Asia/Rangoon', 'Yangon (UTC+6:30)', AS),
  row('Antarctica/Davis', 'Bangkok, Hanoi, Jakarta (UTC+7)', AS),
  row('Asia/Novokuznetsk', 'Novosibirsk, Novokuznetsk (UTC+7)', AS),
  row('Asia/Krasnoyarsk', 'Krasnoyarsk (UTC+7)', AS),
  row('Asia/Hong_Kong', 'Beijing, Shanghai, Hong Kong (UTC+8)', AS),
  row('Asia/Brunei', 'Singapore, Kuala Lumpur, Manila (UTC+8)', AS),
  row('Asia/Taipei', 'Taipei (UTC+8)', AS),
  row('Asia/Choibalsan', 'Ulaanbaatar (UTC+8)', AS),
  row('Asia/Irkutsk', 'Irkutsk (UTC+8)', AS),
  row('Asia/Dili', 'Tokyo, Osaka (UTC+9)', AS),
  row('Asia/Pyongyang', 'Seoul, Pyongyang (UTC+9)', AS),
  row('Asia/Chita', 'Yakutsk, Chita (UTC+9)', AS),
  row('Asia/Sakhalin', 'Magadan, Sakhalin (UTC+11)', AS),
  row('Asia/Anadyr', 'Anadyr (UTC+12)', AS),
  row('Asia/Kamchatka', 'Petropavlovsk-Kamchatsky (UTC+12)', AS),

  row('Etc/GMT+12', 'International Date Line West (UTC-12)', AP),
  row('Etc/GMT+11', 'American Samoa, Midway (UTC-11)', AP),
  row('Australia/Perth', 'Perth (UTC+8)', AP),
  row('Australia/Darwin', 'Darwin (UTC+9:30)', AP),
  row('Australia/Adelaide', 'Adelaide (UTC+9:30, UTC+10:30 in summer)', AP),
  row('Australia/Brisbane', 'Brisbane (UTC+10)', AP),
  row('Antarctica/DumontDUrville', 'Guam, Port Moresby, Vladivostok (UTC+10)', AP),
  row('Australia/Melbourne', 'Sydney, Melbourne, Canberra (UTC+10, UTC+11 in summer)', AP),
  row('Australia/Currie', 'Hobart (UTC+10, UTC+11 in summer)', AP),
  row('Antarctica/Macquarie', 'Macquarie Island (UTC+10, UTC+11 in summer)', AP),
  row('Pacific/Auckland', 'Auckland, Wellington (UTC+12, UTC+13 in summer)', AP),
  row('Pacific/Fiji', 'Fiji (UTC+12)', AP),
  row('Etc/GMT-12', 'Marshall Islands, Tuvalu (UTC+12)', AP),
  row('Etc/GMT-13', "Tonga — Nuku'alofa (UTC+13)", AP),
  row('Pacific/Apia', 'Samoa — Apia (UTC+13)', AP),

  row('Africa/Abidjan', 'UTC (no daylight saving)', UT),
]);

/**
 * Имена, которыми рассыльщик может вернуть НАШ пояс в `campaign_schedule`
 * (каноническое имя IANA вместо принятой им ссылки), → идентификатор белого
 * списка. Нужна только для показа окна, прочитанного у кампании
 * (`readEngCampaignSendingWindow`): иначе кабинет счёл бы окно «непоказуемым».
 * Проверка ввода клиента от неё НЕ зависит.
 *
 * Сгенерировано офлайн (16.10.2026) из трёх источников: ссылки tzdata.zi
 * (2026c, backzone), канонические имена ICU (Intl, tzdata 2025b) и основные
 * имена ссылок IANA после слияний 2022+ (`iana`). Каждая пара сверена с Intl:
 * одинаковое смещение на 1-е и 15-е число каждого месяца 2026–2027; ключи — не
 * из белого списка, значения — из него.
 */
export const ENG_TIMEZONE_ECHO_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'Africa/Maputo': 'Africa/Blantyre', // iana
  'Africa/Nairobi': 'Africa/Addis_Ababa', // iana
  'America/Nuuk': 'America/Godthab', // tzdata
  'America/Phoenix': 'America/Creston', // iana
  'America/Puerto_Rico': 'America/Anguilla', // iana
  'Asia/Calcutta': 'Asia/Kolkata', // intl
  'Asia/Katmandu': 'Asia/Kathmandu', // intl
  'Asia/Kuching': 'Asia/Brunei', // iana
  'Asia/Riyadh': 'Asia/Aden', // iana
  'Asia/Ulaanbaatar': 'Asia/Choibalsan', // tzdata, intl
  'Asia/Yangon': 'Asia/Rangoon', // tzdata
  'Australia/Hobart': 'Australia/Currie', // tzdata, intl
  'Europe/Berlin': 'Arctic/Longyearbyen', // iana
  'Europe/London': 'Europe/Isle_of_Man', // iana
  'Europe/Oslo': 'Arctic/Longyearbyen', // tzdata
  'Pacific/Port_Moresby': 'Antarctica/DumontDUrville', // iana
});
