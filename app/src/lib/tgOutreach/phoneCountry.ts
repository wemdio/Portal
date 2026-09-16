/**
 * Страна аккаунта по телефонному коду.
 *
 * Аккаунты покупают партиями, и в списке они выглядят как `s386_tdata` — по
 * такому имени нельзя понять ни страну, ни партию. А страна тут не украшение:
 * прокси обязаны совпадать с ней по гео (требование того же TgNinja), и от неё
 * же зависит, сколько писем аккаунт отдаст: у нас британские номера дали 55
 * писем против 31 у узбекских.
 *
 * Список неполный намеренно — только то, что встречается в закупках и в
 * соседних странах. Неизвестный код честно показываем как есть: «+263» лучше,
 * чем неправильная страна.
 *
 * Порядок важен: коды ищем от длинного к короткому, иначе «+7» перехватит
 * казахстанские номера у «+77», а «+1» — все североамериканские.
 */

export interface PhoneCountry {
  /** Двухбуквенный код: UZ, RU, GB. */
  code: string;
  name: string;
  flag: string;
}

const CODES: Array<[string, PhoneCountry]> = [
  ['998', { code: 'UZ', name: 'Узбекистан', flag: '🇺🇿' }],
  ['996', { code: 'KG', name: 'Киргизия', flag: '🇰🇬' }],
  ['995', { code: 'GE', name: 'Грузия', flag: '🇬🇪' }],
  ['994', { code: 'AZ', name: 'Азербайджан', flag: '🇦🇿' }],
  ['993', { code: 'TM', name: 'Туркмения', flag: '🇹🇲' }],
  ['992', { code: 'TJ', name: 'Таджикистан', flag: '🇹🇯' }],
  ['380', { code: 'UA', name: 'Украина', flag: '🇺🇦' }],
  ['375', { code: 'BY', name: 'Беларусь', flag: '🇧🇾' }],
  ['373', { code: 'MD', name: 'Молдавия', flag: '🇲🇩' }],
  ['371', { code: 'LV', name: 'Латвия', flag: '🇱🇻' }],
  ['370', { code: 'LT', name: 'Литва', flag: '🇱🇹' }],
  ['372', { code: 'EE', name: 'Эстония', flag: '🇪🇪' }],
  ['374', { code: 'AM', name: 'Армения', flag: '🇦🇲' }],
  ['359', { code: 'BG', name: 'Болгария', flag: '🇧🇬' }],
  ['357', { code: 'CY', name: 'Кипр', flag: '🇨🇾' }],
  ['355', { code: 'AL', name: 'Албания', flag: '🇦🇱' }],
  ['351', { code: 'PT', name: 'Португалия', flag: '🇵🇹' }],
  ['420', { code: 'CZ', name: 'Чехия', flag: '🇨🇿' }],
  ['421', { code: 'SK', name: 'Словакия', flag: '🇸🇰' }],
  ['48', { code: 'PL', name: 'Польша', flag: '🇵🇱' }],
  ['40', { code: 'RO', name: 'Румыния', flag: '🇷🇴' }],
  ['44', { code: 'GB', name: 'Британия', flag: '🇬🇧' }],
  ['49', { code: 'DE', name: 'Германия', flag: '🇩🇪' }],
  ['33', { code: 'FR', name: 'Франция', flag: '🇫🇷' }],
  ['39', { code: 'IT', name: 'Италия', flag: '🇮🇹' }],
  ['34', { code: 'ES', name: 'Испания', flag: '🇪🇸' }],
  ['31', { code: 'NL', name: 'Нидерланды', flag: '🇳🇱' }],
  ['90', { code: 'TR', name: 'Турция', flag: '🇹🇷' }],
  ['91', { code: 'IN', name: 'Индия', flag: '🇮🇳' }],
  ['62', { code: 'ID', name: 'Индонезия', flag: '🇮🇩' }],
  ['60', { code: 'MY', name: 'Малайзия', flag: '🇲🇾' }],
  ['63', { code: 'PH', name: 'Филиппины', flag: '🇵🇭' }],
  ['84', { code: 'VN', name: 'Вьетнам', flag: '🇻🇳' }],
  ['55', { code: 'BR', name: 'Бразилия', flag: '🇧🇷' }],
  ['52', { code: 'MX', name: 'Мексика', flag: '🇲🇽' }],
  // Казахстан и Россия делят «+7»: у казахстанских вторая цифра 6 или 7.
  ['76', { code: 'KZ', name: 'Казахстан', flag: '🇰🇿' }],
  ['77', { code: 'KZ', name: 'Казахстан', flag: '🇰🇿' }],
  ['7', { code: 'RU', name: 'Россия', flag: '🇷🇺' }],
  ['1', { code: 'US', name: 'США/Канада', flag: '🇺🇸' }],
];

/** Страна по номеру. `null` — код не из списка. */
export function countryFromPhone(phone: string | null | undefined): PhoneCountry | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  // От длинного кода к короткому: «+7» иначе перехватит «+77».
  const sorted = [...CODES].sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, country] of sorted) {
    if (digits.startsWith(prefix)) return country;
  }
  return null;
}

/** Короткая подпись для списка: «🇺🇿 Узбекистан» или «+263», если код незнаком. */
export function countryLabel(phone: string | null | undefined): string {
  const country = countryFromPhone(phone);
  if (country) return `${country.flag} ${country.name}`;
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits ? `+${digits.slice(0, 3)}` : '';
}

/** Все страны справочника, по алфавиту — для выпадающего списка на загрузке. */
export function countryOptions(): PhoneCountry[] {
  const seen = new Map<string, PhoneCountry>();
  for (const [, country] of CODES) if (!seen.has(country.code)) seen.set(country.code, country);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Страна по ISO-коду, названному оператором при загрузке. */
export function countryByCode(code: string | null | undefined): PhoneCountry | null {
  const wanted = (code ?? '').trim().toUpperCase();
  if (!wanted) return null;
  for (const [, country] of CODES) if (country.code === wanted) return country;
  return null;
}

/**
 * Что показать в списке: страну по телефону, а если его ещё нет — заявленную
 * при загрузке.
 *
 * Номер важнее: он факт, а сказанное при покупке — заявление продавца, и они
 * могут разойтись. Заявленную помечаем вопросом, чтобы разница была видна.
 */
export function accountCountryLabel(
  phone: string | null | undefined,
  countryCode: string | null | undefined,
): string {
  const byPhone = countryFromPhone(phone);
  if (byPhone) return `${byPhone.flag} ${byPhone.name}`;
  const declared = countryByCode(countryCode);
  if (declared) return `${declared.flag} ${declared.name} ?`;
  return countryLabel(phone);
}
