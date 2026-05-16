/**
 * Регионы Яндекса — коды lr для XMLStock API.
 * Порт regions.py из standalone-инструмента.
 *
 * Иерархия: страны → федеральные округа → области → города.
 * Пресеты — быстрые наборы для типовых задач.
 */

export interface YDRegion {
  alias: string;
  name: string;
  code: number;
  group: 'Страны' | 'Федеральные округа' | 'Области' | 'Города';
}

const COUNTRIES: Array<[string, string, number]> = [
  ['ru', 'Россия', 225],
  ['by', 'Беларусь', 149],
  ['kz', 'Казахстан', 159],
  ['uz', 'Узбекистан', 171],
  ['ua', 'Украина', 187],
  ['az', 'Азербайджан', 167],
  ['am', 'Армения', 168],
  ['ge', 'Грузия', 169],
];

const DISTRICTS: Array<[string, string, number]> = [
  ['cfo', 'Центральный ФО', 3],
  ['szfo', 'Северо-Западный ФО', 10174],
  ['ufo', 'Южный ФО', 26],
  ['skfo', 'Северо-Кавказский ФО', 102444],
  ['pfo', 'Приволжский ФО', 73],
  ['urfo', 'Уральский ФО', 40],
  ['sfo', 'Сибирский ФО', 59],
  ['dfo', 'Дальневосточный ФО', 71],
];

const CITIES: Array<[string, string, number]> = [
  ['msk', 'Москва', 213],
  ['spb', 'Санкт-Петербург', 2],
  ['ekb', 'Екатеринбург', 54],
  ['nsk', 'Новосибирск', 65],
  ['kzn', 'Казань', 43],
  ['krr', 'Краснодар', 35],
  ['chel', 'Челябинск', 56],
  ['sam', 'Самара', 51],
  ['ufa', 'Уфа', 172],
  ['rnd', 'Ростов-на-Дону', 39],
  ['prm', 'Пермь', 50],
  ['vol', 'Волгоград', 38],
  ['vrn', 'Воронеж', 193],
  ['nnv', 'Нижний Новгород', 47],
  ['tyum', 'Тюмень', 55],
  ['krs', 'Красноярск', 62],
  ['omsk', 'Омск', 66],
  ['irk', 'Иркутск', 63],
  ['hbr', 'Хабаровск', 76],
  ['vld', 'Владивосток', 75],
  ['sar', 'Саратов', 194],
  ['kems', 'Кемерово', 81],
  ['ryz', 'Рязань', 10],
  ['pnz', 'Пенза', 49],
  ['lip', 'Липецк', 9],
  ['astr', 'Астрахань', 37],
  ['nab', 'Набережные Челны', 236],
  ['mhk', 'Махачкала', 28],
  ['sochi', 'Сочи', 970],
  ['kld', 'Калининград', 22],
  ['ark', 'Архангельск', 20],
  ['mur', 'Мурманск', 23],
  ['bel', 'Белгород', 4],
  ['tula', 'Тула', 15],
  ['kur', 'Курск', 8],
  ['bry', 'Брянск', 191],
  ['iver', 'Тверь', 14],
  ['vlad', 'Владимир', 192],
  ['yar', 'Ярославль', 16],
  ['ivan', 'Иваново', 5],
  ['klu', 'Калуга', 6],
  ['cheb', 'Чебоксары', 45],
  ['udm', 'Ижевск', 44],
  ['kirov', 'Киров', 46],
  ['uln', 'Ульяновск', 195],
  ['orb', 'Оренбург', 48],
  ['chita', 'Чита', 68],
  ['bur', 'Улан-Удэ', 198],
  ['ykt', 'Якутск', 74],
];

function build(group: YDRegion['group'], rows: Array<[string, string, number]>): YDRegion[] {
  return rows.map(([alias, name, code]) => ({ alias, name, code, group }));
}

export const YD_REGIONS: YDRegion[] = [
  ...build('Страны', COUNTRIES),
  ...build('Федеральные округа', DISTRICTS),
  ...build('Города', CITIES),
];

const BY_ALIAS = new Map(YD_REGIONS.map((r) => [r.alias, r]));

/** Пресеты — быстрые наборы регионов. */
export const YD_PRESETS: Record<string, { label: string; aliases: string[] }> = {
  msk: { label: 'Только Москва', aliases: ['msk'] },
  top5: { label: 'Топ-5 городов', aliases: ['msk', 'spb', 'ekb', 'nsk', 'kzn'] },
  top10: {
    label: 'Топ-10 городов',
    aliases: ['msk', 'spb', 'ekb', 'nsk', 'kzn', 'krr', 'chel', 'sam', 'ufa', 'rnd'],
  },
  millionniki: {
    label: 'Города-миллионники (13)',
    aliases: ['msk', 'spb', 'ekb', 'nsk', 'kzn', 'krr', 'chel', 'sam', 'ufa', 'rnd', 'prm', 'vol', 'vrn'],
  },
  max: {
    label: 'Максимальный охват (РФ + 18 городов)',
    aliases: ['ru', 'msk', 'spb', 'ekb', 'nsk', 'kzn', 'krr', 'chel', 'sam', 'ufa', 'rnd', 'prm', 'vol', 'vrn', 'tyum', 'krs', 'irk', 'hbr', 'vld'],
  },
  russia: { label: 'Россия в целом', aliases: ['ru'] },
};

/**
 * Принимает список алиасов и/или имён пресетов, возвращает уникальные
 * регионы. Неизвестные алиасы тихо отбрасываются.
 */
export function resolveRegions(aliasesOrPresets: string[]): YDRegion[] {
  const expanded: string[] = [];
  for (const raw of aliasesOrPresets) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (YD_PRESETS[a]) expanded.push(...YD_PRESETS[a].aliases);
    else expanded.push(a);
  }
  const out: YDRegion[] = [];
  const seen = new Set<string>();
  for (const a of expanded) {
    if (seen.has(a)) continue;
    const region = BY_ALIAS.get(a);
    if (region) {
      out.push(region);
      seen.add(a);
    }
  }
  return out;
}

export function findRegion(alias: string): YDRegion | undefined {
  return BY_ALIAS.get(alias.trim().toLowerCase());
}
