/**
 * Популярные регионы HH.ru — отрисовываем как удобный picker в архивном
 * парсере, чтобы специалистам не нужно было копаться в api.hh.ru/areas.
 *
 * Источник кодов: https://api.hh.ru/areas (срез на 2026).
 * Список не исчерпывающий — это топ-50 RU-городов + соседние страны.
 * Если нужен экзотический регион, специалист всё ещё может вбить код руками
 * (вариант «Другой код» в селекторе).
 */
export interface HHRegion {
  id: string;
  name: string;
  /** Для группировки в дропдауне. */
  group: 'Россия' | 'Города России' | 'СНГ' | 'Прочее';
  /** Альтернативные варианты написания для поиска (без учёта регистра). */
  aliases?: string[];
}

export const HH_REGIONS: HHRegion[] = [
  // — Россия целиком —
  { id: '113', name: 'Вся Россия', group: 'Россия', aliases: ['рф', 'россия', 'all', 'all-russia'] },

  // — Топ-50 городов России —
  { id: '1', name: 'Москва', group: 'Города России', aliases: ['msk', 'moscow'] },
  { id: '2', name: 'Санкт-Петербург', group: 'Города России', aliases: ['спб', 'питер', 'spb', 'piter'] },
  { id: '3', name: 'Екатеринбург', group: 'Города России', aliases: ['екб', 'ekb'] },
  { id: '4', name: 'Новосибирск', group: 'Города России', aliases: ['нск', 'nsk'] },
  { id: '88', name: 'Казань', group: 'Города России' },
  { id: '66', name: 'Нижний Новгород', group: 'Города России', aliases: ['нн', 'nn'] },
  { id: '104', name: 'Челябинск', group: 'Города России' },
  { id: '78', name: 'Самара', group: 'Города России' },
  { id: '68', name: 'Омск', group: 'Города России' },
  { id: '76', name: 'Ростов-на-Дону', group: 'Города России', aliases: ['ростов'] },
  { id: '99', name: 'Уфа', group: 'Города России' },
  { id: '54', name: 'Красноярск', group: 'Города России' },
  { id: '26', name: 'Воронеж', group: 'Города России' },
  { id: '72', name: 'Пермь', group: 'Города России' },
  { id: '24', name: 'Волгоград', group: 'Города России' },
  { id: '53', name: 'Краснодар', group: 'Города России' },
  { id: '79', name: 'Саратов', group: 'Города России' },
  { id: '95', name: 'Тюмень', group: 'Города России' },
  { id: '94', name: 'Тольятти', group: 'Города России' },
  { id: '43', name: 'Ижевск', group: 'Города России' },
  { id: '14', name: 'Барнаул', group: 'Города России' },
  { id: '47', name: 'Иркутск', group: 'Города России' },
  { id: '98', name: 'Ульяновск', group: 'Города России' },
  { id: '101', name: 'Хабаровск', group: 'Города России' },
  { id: '112', name: 'Ярославль', group: 'Города России' },
  { id: '22', name: 'Владивосток', group: 'Города России' },
  { id: '61', name: 'Махачкала', group: 'Города России' },
  { id: '93', name: 'Томск', group: 'Города России' },
  { id: '70', name: 'Оренбург', group: 'Города России' },
  { id: '50', name: 'Кемерово', group: 'Города России' },
  { id: '67', name: 'Новокузнецк', group: 'Города России' },
  { id: '77', name: 'Рязань', group: 'Города России' },
  { id: '11', name: 'Астрахань', group: 'Города России' },
  { id: '65', name: 'Набережные Челны', group: 'Города России' },
  { id: '71', name: 'Пенза', group: 'Города России' },
  { id: '59', name: 'Липецк', group: 'Города России' },
  { id: '96', name: 'Тула', group: 'Города России' },
  { id: '52', name: 'Киров', group: 'Города России' },
  { id: '105', name: 'Чебоксары', group: 'Города России' },
  { id: '49', name: 'Калининград', group: 'Города России' },
  { id: '55', name: 'Курск', group: 'Города России' },
  { id: '87', name: 'Ставрополь', group: 'Города России' },
  { id: '92', name: 'Тверь', group: 'Города России' },
  { id: '60', name: 'Магнитогорск', group: 'Города России' },
  { id: '46', name: 'Иваново', group: 'Города России' },
  { id: '20', name: 'Брянск', group: 'Города России' },
  { id: '1438', name: 'Сочи', group: 'Города России' },
  { id: '1146', name: 'Балашиха', group: 'Города России' },
  { id: '90', name: 'Сургут', group: 'Города России' },
  { id: '12', name: 'Архангельск', group: 'Города России' },
  { id: '74', name: 'Псков', group: 'Города России' },

  // — СНГ —
  { id: '40', name: 'Казахстан', group: 'СНГ', aliases: ['kz'] },
  { id: '5', name: 'Украина', group: 'СНГ', aliases: ['ua'] },
  { id: '16', name: 'Беларусь', group: 'СНГ', aliases: ['by', 'белоруссия'] },
  { id: '28', name: 'Грузия', group: 'СНГ', aliases: ['ge'] },
  { id: '48', name: 'Кыргызстан', group: 'СНГ', aliases: ['kg', 'киргизия'] },
  { id: '97', name: 'Узбекистан', group: 'СНГ', aliases: ['uz'] },
  { id: '9', name: 'Армения', group: 'СНГ', aliases: ['am'] },
  { id: '10', name: 'Азербайджан', group: 'СНГ', aliases: ['az'] },
];

/**
 * Поиск регионов по подстроке (учитывает и aliases). Возвращает <= limit
 * результатов, отсортированных по релевантности (точное совпадение → префикс
 * → подстрока).
 */
export function searchRegions(query: string, limit = 12): HHRegion[] {
  const q = query.trim().toLowerCase();
  if (!q) return HH_REGIONS.slice(0, limit);

  type Scored = { region: HHRegion; score: number };
  const scored: Scored[] = [];

  for (const region of HH_REGIONS) {
    const nameLower = region.name.toLowerCase();
    const aliases = region.aliases ?? [];
    const matchesAlias = aliases.some((a) => a.toLowerCase().includes(q));

    let score: number | null = null;
    if (nameLower === q || aliases.some((a) => a.toLowerCase() === q)) score = 0;
    else if (nameLower.startsWith(q)) score = 1;
    else if (aliases.some((a) => a.toLowerCase().startsWith(q))) score = 2;
    else if (nameLower.includes(q)) score = 3;
    else if (matchesAlias) score = 4;
    else if (region.id === q) score = 0;

    if (score !== null) scored.push({ region, score });
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.region);
}

export function findRegionById(id: string): HHRegion | undefined {
  return HH_REGIONS.find((r) => r.id === id);
}
