// Справочник регионов РФ по федеральным округам.
// Используется в /client/companies-search для фильтрации по адресу.

export type Region = {
  code: string;        // двузначный код субъекта
  name: string;        // полное название
  matchTokens: string[]; // подстроки, по которым матчим address (ILIKE)
};

export type FederalDistrict = {
  name: string;
  regions: Region[];
};

export const FEDERAL_DISTRICTS: FederalDistrict[] = [
  {
    name: 'Центральный федеральный округ',
    regions: [
      { code: '31', name: 'Белгородская область', matchTokens: ['Белгородск'] },
      { code: '32', name: 'Брянская область', matchTokens: ['Брянск'] },
      { code: '33', name: 'Владимирская область', matchTokens: ['Владимирск'] },
      { code: '36', name: 'Воронежская область', matchTokens: ['Воронежск'] },
      { code: '37', name: 'Ивановская область', matchTokens: ['Ивановск'] },
      { code: '40', name: 'Калужская область', matchTokens: ['Калужск'] },
      { code: '44', name: 'Костромская область', matchTokens: ['Костромск'] },
      { code: '46', name: 'Курская область', matchTokens: ['Курск'] },
      { code: '48', name: 'Липецкая область', matchTokens: ['Липецк'] },
      { code: '50', name: 'Московская область', matchTokens: ['Московск'] },
      { code: '57', name: 'Орловская область', matchTokens: ['Орловск'] },
      { code: '62', name: 'Рязанская область', matchTokens: ['Рязанск'] },
      { code: '67', name: 'Смоленская область', matchTokens: ['Смоленск'] },
      { code: '68', name: 'Тамбовская область', matchTokens: ['Тамбовск'] },
      { code: '69', name: 'Тверская область', matchTokens: ['Тверск'] },
      { code: '71', name: 'Тульская область', matchTokens: ['Тульск'] },
      { code: '76', name: 'Ярославская область', matchTokens: ['Ярославск'] },
      { code: '77', name: 'г. Москва', matchTokens: ['г. Москва', 'г.Москва', 'Москва'] },
    ],
  },
  {
    name: 'Северо-Западный федеральный округ',
    regions: [
      { code: '10', name: 'Республика Карелия', matchTokens: ['Карелия'] },
      { code: '11', name: 'Республика Коми', matchTokens: ['Коми'] },
      { code: '29', name: 'Архангельская область', matchTokens: ['Архангельск'] },
      { code: '35', name: 'Вологодская область', matchTokens: ['Вологодск'] },
      { code: '39', name: 'Калининградская область', matchTokens: ['Калининградск'] },
      { code: '47', name: 'Ленинградская область', matchTokens: ['Ленинградск'] },
      { code: '51', name: 'Мурманская область', matchTokens: ['Мурманск'] },
      { code: '53', name: 'Новгородская область', matchTokens: ['Новгородск'] },
      { code: '60', name: 'Псковская область', matchTokens: ['Псковск'] },
      { code: '78', name: 'г. Санкт-Петербург', matchTokens: ['Санкт-Петербург', 'СПб'] },
      { code: '83', name: 'Ненецкий АО', matchTokens: ['Ненецк'] },
    ],
  },
  {
    name: 'Южный федеральный округ',
    regions: [
      { code: '01', name: 'Республика Адыгея', matchTokens: ['Адыгея'] },
      { code: '08', name: 'Республика Калмыкия', matchTokens: ['Калмыки'] },
      { code: '23', name: 'Краснодарский край', matchTokens: ['Краснодарск'] },
      { code: '30', name: 'Астраханская область', matchTokens: ['Астрахан'] },
      { code: '34', name: 'Волгоградская область', matchTokens: ['Волгоградск'] },
      { code: '61', name: 'Ростовская область', matchTokens: ['Ростовск'] },
      { code: '82', name: 'Республика Крым', matchTokens: ['Крым'] },
      { code: '92', name: 'г. Севастополь', matchTokens: ['Севастополь'] },
    ],
  },
  {
    name: 'Северо-Кавказский федеральный округ',
    regions: [
      { code: '05', name: 'Республика Дагестан', matchTokens: ['Дагестан'] },
      { code: '06', name: 'Республика Ингушетия', matchTokens: ['Ингушети'] },
      { code: '07', name: 'Кабардино-Балкарская Республика', matchTokens: ['Кабардино'] },
      { code: '09', name: 'Карачаево-Черкесская Республика', matchTokens: ['Карачаево'] },
      { code: '15', name: 'Республика Северная Осетия — Алания', matchTokens: ['Осети'] },
      { code: '20', name: 'Чеченская Республика', matchTokens: ['Чеченск'] },
      { code: '26', name: 'Ставропольский край', matchTokens: ['Ставропольск'] },
    ],
  },
  {
    name: 'Приволжский федеральный округ',
    regions: [
      { code: '02', name: 'Республика Башкортостан', matchTokens: ['Башкортостан', 'Башкири'] },
      { code: '12', name: 'Республика Марий Эл', matchTokens: ['Марий'] },
      { code: '13', name: 'Республика Мордовия', matchTokens: ['Мордови'] },
      { code: '16', name: 'Республика Татарстан', matchTokens: ['Татарстан'] },
      { code: '18', name: 'Удмуртская Республика', matchTokens: ['Удмурт'] },
      { code: '21', name: 'Чувашская Республика', matchTokens: ['Чуваш'] },
      { code: '43', name: 'Кировская область', matchTokens: ['Кировск'] },
      { code: '52', name: 'Нижегородская область', matchTokens: ['Нижегородск'] },
      { code: '56', name: 'Оренбургская область', matchTokens: ['Оренбургск'] },
      { code: '58', name: 'Пензенская область', matchTokens: ['Пензенск'] },
      { code: '59', name: 'Пермский край', matchTokens: ['Пермск'] },
      { code: '63', name: 'Самарская область', matchTokens: ['Самарск'] },
      { code: '64', name: 'Саратовская область', matchTokens: ['Саратовск'] },
      { code: '73', name: 'Ульяновская область', matchTokens: ['Ульяновск'] },
    ],
  },
  {
    name: 'Уральский федеральный округ',
    regions: [
      { code: '45', name: 'Курганская область', matchTokens: ['Курганск'] },
      { code: '66', name: 'Свердловская область', matchTokens: ['Свердловск'] },
      { code: '72', name: 'Тюменская область', matchTokens: ['Тюменск'] },
      { code: '74', name: 'Челябинская область', matchTokens: ['Челябинск'] },
      { code: '86', name: 'Ханты-Мансийский АО — Югра', matchTokens: ['Ханты-Мансийск', 'Югра'] },
      { code: '89', name: 'Ямало-Ненецкий АО', matchTokens: ['Ямало-Ненец'] },
    ],
  },
  {
    name: 'Сибирский федеральный округ',
    regions: [
      { code: '03', name: 'Республика Бурятия', matchTokens: ['Буряти'] },
      { code: '17', name: 'Республика Тыва', matchTokens: ['Тыва', 'Тува'] },
      { code: '19', name: 'Республика Хакасия', matchTokens: ['Хакаси'] },
      { code: '04', name: 'Республика Алтай', matchTokens: ['Алтай'] },
      { code: '22', name: 'Алтайский край', matchTokens: ['Алтайск'] },
      { code: '24', name: 'Красноярский край', matchTokens: ['Красноярск'] },
      { code: '38', name: 'Иркутская область', matchTokens: ['Иркутск'] },
      { code: '42', name: 'Кемеровская область — Кузбасс', matchTokens: ['Кемеровск', 'Кузбасс'] },
      { code: '54', name: 'Новосибирская область', matchTokens: ['Новосибирск'] },
      { code: '55', name: 'Омская область', matchTokens: ['Омск'] },
      { code: '70', name: 'Томская область', matchTokens: ['Томск'] },
    ],
  },
  {
    name: 'Дальневосточный федеральный округ',
    regions: [
      { code: '14', name: 'Республика Саха (Якутия)', matchTokens: ['Якути', 'Саха'] },
      { code: '25', name: 'Приморский край', matchTokens: ['Приморск'] },
      { code: '27', name: 'Хабаровский край', matchTokens: ['Хабаровск'] },
      { code: '28', name: 'Амурская область', matchTokens: ['Амурск'] },
      { code: '41', name: 'Камчатский край', matchTokens: ['Камчатск'] },
      { code: '49', name: 'Магаданская область', matchTokens: ['Магаданск'] },
      { code: '65', name: 'Сахалинская область', matchTokens: ['Сахалинск'] },
      { code: '75', name: 'Забайкальский край', matchTokens: ['Забайкальск'] },
      { code: '79', name: 'Еврейская автономная область', matchTokens: ['Еврейск'] },
      { code: '87', name: 'Чукотский АО', matchTokens: ['Чукотск'] },
    ],
  },
  {
    name: 'Новые территории',
    regions: [
      { code: '93', name: 'Донецкая Народная Республика', matchTokens: ['Донецк'] },
      { code: '94', name: 'Луганская Народная Республика', matchTokens: ['Луганск'] },
      { code: '90', name: 'Запорожская область', matchTokens: ['Запорожск'] },
      { code: '95', name: 'Херсонская область', matchTokens: ['Херсонск'] },
    ],
  },
];

export const ALL_REGION_CODES: string[] = FEDERAL_DISTRICTS.flatMap((d) =>
  d.regions.map((r) => r.code)
);

export function getRegionByCode(code: string): Region | undefined {
  for (const d of FEDERAL_DISTRICTS) {
    const r = d.regions.find((x) => x.code === code);
    if (r) return r;
  }
  return undefined;
}
