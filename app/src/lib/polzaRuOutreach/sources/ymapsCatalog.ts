/**
 * Каталог Яндекс Карт (yandex_maps_company_catalog, ~10 млн организаций) —
 * кандидаты по рубрикам ЦА (документ «ОКВЭДы ЦА», 14.10.2026).
 *
 * ОКВЭД и выручки в каталоге нет — только рубрики, поэтому отбор по ним грубый,
 * а «наш ли это клиент» решает разбор сайта (ЦА-балл) дальше по конвейеру.
 * Почта из карточки идёт в поиск почты наравне с сайтом.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Рубрики сфер ЦА: IT, digital, HR, логистика, производство, B2B-опт. */
export const YMAPS_TARGET_CATEGORY_REGEX = [
  // IT и digital
  'программное обеспечение', 'разработка программ', 'it-компан', 'ит-компан', 'информационные технологии', 'веб-студи', 'создание сайтов',
  'интернет-маркетинг', 'рекламные агентства', 'маркетинговые услуги', 'брендинг',
  // HR
  'кадровые агентства', 'подбор персонала', 'аутстаффинг',
  // логистика
  'логистическ', 'грузоперевоз', 'грузовые перевозки', 'транспортно-экспедиц', 'экспедиторск', 'экспедирование', 'складские услуги', 'таможенн',
  // производство
  'промышленные организации', 'производственные предприятия', 'промышленное оборудование', 'станки', 'металлообработ', 'электротехническ',
  'пластмассовые изделия', 'тара и упаковка', 'упаковк',
  // B2B-опт
  'оптовая торговля', 'оптом', 'дистрибьют',
].join('|');

/**
 * Какую долю страниц каталога смотрим за запуск. По выборке 14.10.2026 рубрики ЦА
 * у ~6% карточек с сайтом (≈74 тыс. на весь каталог): 25% страниц ≈ 18 тыс.
 * кандидатов, и каждый запуск берёт свои случайные страницы.
 */
const SAMPLE_PERCENT = 5;

export interface YmapsCatalogRow {
  yandexId: string;
  name: string;
  website: string;
  email: string | null;
}

export async function loadYmapsCatalogCandidates(db: SupabaseClient, limit: number): Promise<YmapsCatalogRow[]> {
  const { data, error } = await db.rpc('polza_ru_ymaps_catalog_candidates', {
    p_category_regex: YMAPS_TARGET_CATEGORY_REGEX,
    p_sample_percent: SAMPLE_PERCENT,
    p_limit: limit,
  });
  if (error) throw new Error(`ymaps catalog candidates failed: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((r) => r.name && r.website)
    .map((r) => ({
      yandexId: String(r.yandex_id ?? ''),
      name: String(r.name),
      website: String(r.website).split(/[\s,;]+/)[0],
      email: r.email ? String(r.email) : null,
    }));
}
