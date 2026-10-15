/**
 * Каталог Яндекс Карт (yandex_maps_company_catalog, ~10 млн организаций) —
 * кандидаты по рубрикам ЦА (документ «ОКВЭДы ЦА», 14.10.2026).
 *
 * Читаем каталог порциями по ключу yandex_id (уникальный индекс): одна порция —
 * одна короткая база-функция, без одного большого запроса. Идём по каталогу,
 * пока не наберём лимит кандидатов или не выйдет время (MAX_READ_MS).
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

/** Размер одной порции каталога (строк, до фильтра). */
const PAGE_SIZE = 50_000;
/** Сколько читаем каталога за запуск по времени: дальше — стоп, готовое сохраняется. */
const MAX_READ_MS = 2 * 60 * 60 * 1000;

export interface YmapsCatalogRow {
  yandexId: string;
  name: string;
  website: string;
  email: string | null;
}

interface PageResult {
  rows: Array<Record<string, unknown>>;
  last_id: string | null;
  done: boolean;
}

/**
 * Кандидаты из каталога: порции идут по возрастанию yandex_id, пока не наберётся
 * limit строк, не кончится каталог или не выйдет время чтения.
 */
export async function loadYmapsCatalogCandidates(db: SupabaseClient, limit: number): Promise<YmapsCatalogRow[]> {
  const started = Date.now();
  const out: YmapsCatalogRow[] = [];
  let after = '';
  for (;;) {
    const { data, error } = await db.rpc('polza_ru_ymaps_catalog_page', {
      p_after: after,
      p_page: PAGE_SIZE,
      p_category_regex: YMAPS_TARGET_CATEGORY_REGEX,
    });
    if (error) throw new Error(`ymaps catalog page failed: ${error.message}`);
    const page = data as PageResult;
    for (const r of page.rows ?? []) {
      if (!r.name || !r.website) continue;
      out.push({
        yandexId: String(r.yandex_id ?? ''),
        name: String(r.name),
        website: String(r.website).split(/[\s,;]+/)[0],
        email: r.email ? String(r.email) : null,
      });
    }
    if (page.done || !page.last_id) break;
    if (out.length >= limit) break;
    if (Date.now() - started > MAX_READ_MS) break;
    after = page.last_id;
  }
  return out.slice(0, limit);
}
