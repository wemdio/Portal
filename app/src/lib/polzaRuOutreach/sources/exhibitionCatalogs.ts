/**
 * Выставки, чьи каталоги участников синк забирает сам (sources/exhibitorsSync.ts).
 *
 * Две площадки (проверено 07.10.2026):
 *  - mvk — сайты выставок ООО «МВК» (mvk.ru): страница «Список участников» на
 *    Kentico, листание через ASP.NET-постбэк, карточка экспонента — JSON
 *    (сайт, почта, страна). Своего catalog.<сайт>.ru у МВК нет.
 *  - expodat — платформа Expodat (expodat.com, она же catalog.mitexpo.ru и
 *    др.): Евроэкспо (MITEX, «Мир Климата», UtiliCon), БИОТ, Скрепка Экспо,
 *    Fruit Trade МВК. Список — HTML с ?limit=&start=, сайт — в карточке компании.
 *
 * Только B2B: промышленность, стройка, еда (сырьё, оборудование, производители),
 * логистика, безопасность, электроника. Потребительские (красота, стоматология,
 * мода, вино) не берём. Синк берёт выставку в окне T−120…T+14 дней — список
 * можно держать на полгода вперёд; дальние выставки сами включатся в срок.
 *
 * Список ведётся руками: новый выпуск (2027) — новая строка с новым slug.
 * Даты — с mvk.ru/ru-RU/exhibitions.aspx и expodat.com/expositions.html.
 */

export type CatalogPlatform = 'mvk' | 'expodat';

export interface ExhibitionCatalog {
  /** Уникален на выпуск выставки: ключ загрузки — `${platform}:${slug}`. */
  slug: string;
  platform: CatalogPlatform;
  title: string;
  /** YYYY-MM-DD */
  eventStart: string;
  eventEnd: string;
  city: string;
  /** Отрасль — уходит в details строки, для разбора и писем. */
  topic: string;
  officialUrl: string;
  /** mvk: адрес страницы «Список участников»; expodat: корень площадки (https://expodat.com). */
  catalogUrl: string;
  /** expodat: id экспозиции в /expositions/exposition/<id>. */
  expositionId?: number;
}

const MVK_LIST = '/ru-RU/about/exhibitor-list.aspx';
const EXPODAT = 'https://expodat.com';

function mvk(slug: string, title: string, eventStart: string, eventEnd: string, city: string, topic: string, site: string, listPath = MVK_LIST): ExhibitionCatalog {
  return { slug, platform: 'mvk', title, eventStart, eventEnd, city, topic, officialUrl: site, catalogUrl: `${site}${listPath}` };
}

function expodat(slug: string, expositionId: number, title: string, eventStart: string, eventEnd: string, city: string, topic: string, site: string): ExhibitionCatalog {
  return { slug, platform: 'expodat', title, eventStart, eventEnd, city, topic, officialUrl: site, catalogUrl: EXPODAT, expositionId };
}

export const EXHIBITION_CATALOGS: ExhibitionCatalog[] = [
  // ── МВК, осень 2026 ──────────────────────────────────────────────────────
  mvk('mebel-ural-2026', 'Мебель&Деревообработка Урал 2026', '2026-10-13', '2026-10-15', 'Екатеринбург', 'мебельное производство и деревообработка', 'https://www.mebelexpo-ural.ru'),
  mvk('expocoating-2026', 'ExpoCoating Moscow 2026', '2026-10-19', '2026-10-21', 'Москва', 'обработка поверхности и покрытия', 'https://www.expocoating-moscow.ru'),
  mvk('testing-control-2026', 'Testing & Control 2026', '2026-10-19', '2026-10-21', 'Москва', 'испытательное и измерительное оборудование', 'https://www.testing-control.ru'),
  mvk('pcvexpo-2026', 'PCVExpo 2026', '2026-10-19', '2026-10-21', 'Москва', 'насосы, компрессоры, арматура', 'https://www.pcvexpo.ru'),
  mvk('heatpower-2026', 'HEAT&POWER 2026', '2026-10-19', '2026-10-21', 'Москва', 'автономная энергетика', 'https://www.heatpower-expo.ru'),
  mvk('ndt-russia-2026', 'NDT Russia 2026', '2026-10-19', '2026-10-21', 'Москва', 'неразрушающий контроль', 'https://www.ndt-russia.ru'),
  mvk('fasttec-2026', 'FastTec 2026', '2026-10-19', '2026-10-21', 'Москва', 'крепёж', 'https://www.fasttec.ru'),
  mvk('agroprom-ural-2026', 'Agroprom Ural 2026', '2026-10-27', '2026-10-29', 'Екатеринбург', 'сельхозтехника и оборудование', 'https://agroprom-ural.ru'),
  mvk('interfood-ural-2026', 'InterFood Ural 2026', '2026-10-27', '2026-10-29', 'Екатеринбург', 'производители продуктов питания', 'https://www.interfood-ural.ru'),
  mvk('foodtech-ural-2026', 'FoodTech Ural 2026', '2026-10-27', '2026-10-29', 'Екатеринбург', 'оборудование и упаковка для пищепрома', 'https://www.foodtech-ural.ru'),
  mvk('translogistica-ural-2026', 'Translogistica Ural 2026', '2026-10-27', '2026-10-29', 'Екатеринбург', 'логистика и складское оборудование', 'https://www.translogistica-ural.ru'),
  mvk('parking-russia-2026', 'Parking Russia 2026', '2026-11-10', '2026-11-12', 'Москва', 'оборудование для парковок', 'https://parking-expo.ru'),
  mvk('cleanexpo-moscow-2026', 'CleanExpo Moscow 2026', '2026-11-17', '2026-11-19', 'Москва', 'профессиональная уборка и клининг', 'https://www.cleanexpo-moscow.ru'),
  mvk('elektronika-rossii-2026', 'Электроника России 2026', '2026-11-24', '2026-11-26', 'Москва', 'электроника и компоненты', 'https://rus-elektronika.ru'),
  mvk('sfitex-2026', 'Sfitex 2026', '2026-11-24', '2026-11-26', 'Санкт-Петербург', 'безопасность и противопожарная защита', 'https://www.sfitex.ru'),
  // ── МВК, весна 2027: включатся сами за 120 дней, когда выйдет список 2027 ─
  mvk('cabex-2027', 'Cabex 2027', '2027-03-02', '2027-03-04', 'Москва', 'кабельно-проводниковая продукция', 'https://www.cabex.ru'),
  mvk('yugbuild-2027', 'YugBuild 2027', '2027-03-02', '2027-03-05', 'Краснодар', 'стройматериалы и инженерное оборудование', 'https://www.yugbuild.com'),
  mvk('vacuumcryotech-2027', 'VacuumCryoTech 2027', '2027-03-30', '2027-04-01', 'Москва', 'вакуумные и криогенные технологии', 'https://www.vacuumtechexpo.com'),
  mvk('wasma-2027', 'Wasma 2027', '2027-03-30', '2027-04-01', 'Москва', 'экологические технологии', 'https://www.wasma.ru'),
  mvk('umids-2027', 'UMIDS 2027', '2027-04-06', '2027-04-09', 'Краснодар', 'мебельное производство и деревообработка', 'https://www.umids.ru'),
  mvk('interstroyexpo-2027', 'ИнтерСтройЭкспо 2027', '2027-04-13', '2027-04-15', 'Санкт-Петербург', 'строительство', 'https://www.interstroyexpo.com'),
  mvk('build-ural-2027', 'Build Ural 2027', '2027-04-20', '2027-04-22', 'Екатеринбург', 'стройматериалы и инженерное оборудование', 'https://www.build-ural.ru'),
  mvk('global-ingredients-2027', 'Global Ingredients Show 2027', '2027-04-21', '2027-04-23', 'Москва', 'пищевые ингредиенты и сырьё', 'https://new.ingred.ru'),
  mvk('foodtech-krasnodar-2027', 'FoodTech Krasnodar 2027', '2027-04-21', '2027-04-23', 'Краснодар', 'оборудование и упаковка для пищепрома', 'https://www.foodtech-krasnodar.ru'),
  mvk('interfood-krasnodar-2027', 'InterFood Krasnodar 2027', '2027-04-21', '2027-04-23', 'Краснодар', 'производители продуктов питания', 'https://www.inter-food.su'),
  mvk('cleanexpo-krasnodar-2027', 'CleanExpo Краснодар 2027', '2027-04-21', '2027-04-23', 'Краснодар', 'профессиональная уборка и клининг', 'https://cleanexpo-region.ru', '/ru-RU/about/exhibitor-list-krd.aspx'),
  mvk('ndt-spb-2027', 'Дефектоскопия / NDT Санкт-Петербург 2027', '2027-04-27', '2027-04-28', 'Санкт-Петербург', 'неразрушающий контроль', 'https://www.ndt-defectoscopy.ru'),
  mvk('chemtech-ural-2027', 'ХимТех Урал 2027', '2027-05-19', '2027-05-20', 'Екатеринбург', 'химическая промышленность', 'https://www.chemtech-ural.ru'),
  // ── Expodat ──────────────────────────────────────────────────────────────
  expodat('nmf-expo-2026', 7488, 'НМФ ЭКСПО 2026', '2026-10-06', '2026-10-09', '', 'металлообработка', 'https://nmf-expo.ru'),
  expodat('ccweek-2026', 7644, 'CCWeek 2026', '2026-10-26', '2026-10-29', 'Москва', 'контакт-центры и клиентский сервис', 'https://ccguru-events.com'),
  expodat('mitex-2026', 7054, 'MITEX 2026', '2026-11-10', '2026-11-13', 'Москва', 'инструмент и оборудование', 'https://mitexpo.ru'),
  expodat('utilicon-2026', 7048, 'UtiliCon 2026', '2026-11-10', '2026-11-13', 'Москва', 'ЖКХ и городская инфраструктура', 'https://utilicon.ru'),
  expodat('mir-klimata-osen-2026', 7051, 'Мир Климата 2026 (осень)', '2026-11-10', '2026-11-13', 'Москва', 'климатическое оборудование', 'https://www.climatexpo.ru'),
  expodat('pulpfor-2026', 7440, 'PulpFor 2026', '2026-11-10', '2026-11-12', 'Москва', 'целлюлозно-бумажная промышленность', 'https://pulpfor.ru'),
  expodat('global-fresh-market-2026', 7452, 'Global Fresh Market 2026', '2026-11-11', '2026-11-13', 'Москва', 'свежие продукты, B2B-поставки', 'https://gfmexpo.com'),
  expodat('biot-2026', 7159, 'БИОТ-2026', '2026-11-17', '2026-11-20', 'Москва', 'охрана труда и средства защиты', 'https://biot-expo.ru'),
  expodat('skrepka-expo-2027', 7605, 'Скрепка Экспо 2027', '2027-02-16', '2027-02-18', 'Москва', 'канцтовары и офисные товары, B2B', 'https://skrepkaexpo.ru'),
  expodat('fruit-trade-2027', 7695, 'Fruit Trade 2027', '2027-02-16', '2027-02-17', 'Краснодар', 'плодово-ягодный бизнес', 'https://fruittrade-expo.com'),
];
