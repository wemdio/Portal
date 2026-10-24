import type { VeCollectTask, VeSourcePlan } from './prompts/sourcePlan';
import { VE_PAYMENT_DIRECTORY_REVISION } from './paymentCompanyDirectory';
import type { VeRetailSourceProfile } from './legacyRetailAudience';

/** Narrow business models whose parent industry is not a useful source slice. */
export type VeNicheSourceProfile = 'payments' | 'esoteric_platform' | 'adult_platform'
  | 'crossborder_ecommerce' | 'crossborder_buyers';

type Hypothesis = { title: string; description?: string | null };
const normalized = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/[-‐–—]/g, ' ').replace(/\s+/g, ' ').trim();
const foreign = /трансгранич|cross\s*border|crossborder|международ|зарубеж|из за рубеж|из европ|из сша|из китай|из турц/;
const platform = /платформ|агрегатор|маркетплейс|platform|marketplace/;
const esoteric = /астрол|астро\s|эзотер|таро|нумеролог|гороскоп|astrolog|esoter|tarot|horoscop/;
const adult = /веб\s*модел|вебкам|webcam|adult|взрослого контента|контент[а-я]* для взрослых|порно|porn/;
const payments = /платеж|payment|эквайр|acquir|процессинг|processing/;
const paymentProvider = /агрегатор|посредни[кч]|провайдер|процессинг|процессор|gateway|\bpsp\b|эквайринг|платежн[а-я]* систем/;
const supportingBusiness = /подбор|рекрут|\bhr\b|\bcrm\b|разработ|создани|продвижен|маркетинг|консалтинг|аутсорс|дизайн|обуч|учеб|образован|школ|академ|курс/;

function detectOne(hypothesis: Hypothesis): VeNicheSourceProfile | null {
  const title = normalized(hypothesis.title);
  // Match the named audience first. A payment offer in a shop's description
  // must not turn the shop into a payment provider; platform clients are not
  // interchangeable with their suppliers, studios or local practitioners.
  // Descriptions also contain the client's offer and growth ambitions. They
  // cannot establish a business model absent from the audience's own title.
  if (supportingBusiness.test(title) || /^(?:клиенты|пользователи|поставщики|подрядчики|партнеры)\s/.test(title)) return null;
  if (/(?:байер|buyer|выкуп.*товар|сервис.*доставк.*товар)/.test(title) && foreign.test(title)) return 'crossborder_buyers';
  if (/(?:коммерци|commerce|ecommerce|интернет\s*магазин|онлайн\s*торговл)/.test(title) && foreign.test(title)) return 'crossborder_ecommerce';
  if (esoteric.test(title) && platform.test(title) && !/(?:центр|магазин|школ|кабинет)/.test(title)) return 'esoteric_platform';
  if (adult.test(title) && platform.test(title) && !/(?:студи|studio|модел[ьи]\s*$)/.test(title)) return 'adult_platform';
  if ((payments.test(title) && paymentProvider.test(title)) || /\bpsps?\b/.test(title)) return 'payments';
  return null;
}

/** A mixed selection keeps its normal plan; only one unambiguous audience is specialized. */
export function detectVeNicheSourceProfile(hypotheses: Hypothesis[]): VeNicheSourceProfile | null {
  if (!hypotheses.length) return null;
  const first = detectOne(hypotheses[0]);
  return first && hypotheses.every((hypothesis) => detectOne(hypothesis) === first) ? first : null;
}

/** Rubrics remain candidate sources, never a replacement for the relevance gate. */
export function veNicheRubricAllowed(profile: VeNicheSourceProfile, label: string): boolean {
  const value = normalized(label);
  if (profile === 'payments') {
    if (supportingBusiness.test(value) || /терминал|банкомат|денежн[а-я]* перевод|пункт[а-я]* перевод|страхов|ломбард/.test(value)) return false;
    return /платежн[а-я]*\s+(?:систем|агрегатор|провайдер|небанковск)|банковск[а-я]*\s+платежн[а-я]*\s+агент|процессинг|эквайринг|payment\s+(?:gateway|provider|service)|\bpsp\b/.test(value);
  }
  if (profile === 'esoteric_platform') {
    return esoteric.test(value) && platform.test(value) && !/(?:центр|магазин|школ|кабинет)/.test(value);
  }
  if (profile === 'adult_platform') {
    return adult.test(value) && platform.test(value) && !/(?:студи|studio|магазин|салон|клуб|эскорт)/.test(value);
  }
  if (profile === 'crossborder_buyers') {
    // Auto parts are ordinary cross-border purchases; buying whole cars is a different audience.
    if (/авто(?!\s*запчаст)|машин|оборудован|ломбард|металл|скупк/.test(value)) return false;
    return /байер|buyer/.test(value) || (foreign.test(value) && /выкуп|покуп(?:к|ок)|доставк.*(?:товар|авто\s*запчаст)/.test(value));
  }
  return !supportingBusiness.test(value) && !/логистик|перевозк/.test(value)
    && /интернет\s*магазин|онлайн\s*магазин|электронн[а-я]* коммерц|e\s*commerce|ecommerce/.test(value);
}

const NAME_TERMS: Record<VeNicheSourceProfile, readonly string[]> = {
  payments: ['платеж', 'платёж', 'финтех', 'fintech', 'pay', 'пэй', 'пеймент', 'эквайр', 'процессинг', 'processing', 'gateway', 'psp'],
  esoteric_platform: ['астро', 'astro', 'эзотер', 'esoter', 'таро', 'taro', 'нумерол', 'numerol', 'гороскоп', 'horosc'],
  adult_platform: ['вебкам', 'webcam', 'adult', 'стрим', 'stream', 'fans', 'camgirl', 'порно', 'porn'],
  crossborder_ecommerce: ['экспорт', 'export', 'импорт', 'import', 'cross', 'кросс', 'global', 'глобал', 'international', 'международ', 'world', 'миров'],
  crossborder_buyers: ['байер', 'buyer', 'выкуп', 'покупк', 'shopping', 'шоппинг', 'достав', 'delivery', 'parcel', 'forward', 'форвард', 'crossborder'],
};

/** Fixed bounded inputs for indexed name lookup; never model-provided SQL. */
export function veNicheDirectoryNameTerms(profile: VeNicheSourceProfile): string[] {
  return [...NAME_TERMS[profile]];
}

const PROFILE_NAMES: Record<VeNicheSourceProfile, string> = {
  payments: 'платёжных провайдеров и посредников',
  esoteric_platform: 'платформ эзотерики и астрологии',
  adult_platform: 'платформ веб-моделей и взрослого контента',
  crossborder_ecommerce: 'трансграничной электронной коммерции',
  crossborder_buyers: 'сервисов выкупа и доставки зарубежных покупок',
};
const MAP_QUERIES: Record<VeNicheSourceProfile, readonly string[]> = {
  payments: ['платёжные системы', 'платёжные агрегаторы', 'процессинговые компании', 'банковские платёжные агенты'],
  esoteric_platform: ['онлайн-платформы астрологии', 'платформы эзотерических консультаций', 'платформы таро'],
  adult_platform: ['платформы веб-моделей', 'платформы взрослого контента', 'adult streaming platforms'],
  crossborder_ecommerce: ['интернет-магазин'],
  crossborder_buyers: ['байерские сервисы', 'выкуп товаров из-за рубежа', 'доставка покупок из-за рубежа'],
};
const HH_QUERIES: Record<VeNicheSourceProfile, string> = {
  payments: '"платежный агрегатор" OR "платёжный агрегатор" OR процессинг OR эквайринг OR "payment gateway" OR "payment service provider"',
  esoteric_platform: '"астрологическая платформа" OR "онлайн астрология" OR "сервис гороскопов" OR "платформа таро" OR "платформа эзотерики"',
  adult_platform: '"adult platform" OR "webcam platform" OR "adult streaming" OR "платформа вебкам" OR "платформа веб-моделей"',
  crossborder_ecommerce: '"трансграничная торговля" OR "трансграничная коммерция" OR "cross-border ecommerce" OR "международный интернет-магазин"',
  crossborder_buyers: '"выкуп товаров из-за рубежа" OR "доставка покупок из Европы" OR "байерский сервис" OR "доставка зарубежных покупок"',
};

/** Rewrite only existing tasks. Counts, geography, size and spend caps stay with the caller. */
export function normalizeVeNicheSourceTask(task: VeCollectTask, profile: VeNicheSourceProfile): VeCollectTask {
  const audience = PROFILE_NAMES[profile];
  if (task.source === 'companies_directory' && task.directory_filters) {
    const narrowed = task.directory_filters.okvedCodes?.map((code) =>
      (profile === 'crossborder_ecommerce' || profile === 'crossborder_buyers') && ['47', '47.1', '47.9'].includes(code)
        ? '47.91' : code);
    const filters = { ...task.directory_filters,
      ...(narrowed ? { okvedCodes: [...new Set(narrowed)] } : {}), nameTerms: veNicheDirectoryNameTerms(profile),
    };
    if (profile === 'payments') filters.identityCatalog = VE_PAYMENT_DIRECTORY_REVISION;
    else delete filters.identityCatalog;
    return { ...task, directory_filters: filters,
    rationale: `Ищем компании ${audience} по профильным названиям${profile === 'payments' ? ' и опубликованным реквизитам' : ''} в реестре; сохраняем ограничения географии и размера.` };
  }
  if ((task.source === 'yandex_maps' || task.source === 'google_maps') && task.maps_query?.queries.length) {
    const queries = [...new Set([...task.maps_query.queries.filter((query) => veNicheRubricAllowed(profile, query)), ...MAP_QUERIES[profile]])]
      .slice(0, task.maps_query.queries.length);
    return { ...task, maps_query: { ...task.maps_query, queries },
      rationale: `Ищем компании ${audience} только в подходящих рубриках готового каталога, без подмены соседними видами бизнеса.` };
  }
  if (task.source === 'hh_live' && task.hh_query) return { ...task, hh_query: { ...task.hh_query, text: HH_QUERIES[profile] },
    rationale: `Ищем работодателей ${audience} по упоминаниям этой деятельности в вакансиях, а не по общей должности.` };
  return task;
}

// These profiles are selected from a reviewed audience contract, never from
// incidental title words. In particular, the existing niche detector above
// must not start rewriting manual or already-running retail hypotheses.
const RETAIL_CODES: Record<VeRetailSourceProfile, readonly string[]> = {
  // Mortars, parquet, ceramic tiles, paints. Other flooring manufacturers may
  // also be found through the catalog; machinery and heating are not substitutes.
  material_manufacturers: ['23.64', '16.22', '23.31', '20.30'],
  // 32.13 is imitation jewellery; 47.7 also contains pharmacies and clothing.
  jewelry_manufacturers_or_chains: ['32.12', '47.77'],
};
const RETAIL_QUERIES: Record<VeRetailSourceProfile, readonly string[]> = {
  material_manufacturers: ['строительные смеси', 'напольные покрытия', 'керамическая плитка', 'лакокрасочные материалы'],
  jewelry_manufacturers_or_chains: ['ювелирные изделия', 'ювелирный магазин'],
};
// Catalog mapping v2 recognizes the retail shop alias. Keep this pure module
// independent of the runtime catalog/LLM adapter; the marker is code-owned.
const RETAIL_CATALOG_REVISION = 2;

/** Candidate rubrics only: a shop still needs manufacturer/chain evidence at
 * the relevance gate. A repair shop, pawnshop or equipment vendor is not a
 * fallback for an unavailable target rubric. */
export function veRetailRubricAllowed(profile: VeRetailSourceProfile, label: string): boolean {
  const value = normalized(label);
  if (profile === 'jewelry_manufacturers_or_chains') {
    return /ювелир/.test(value) && !/ремонт|мастерск|ломбард|скупк|бижутер|оборудован|обуч|курс/.test(value);
  }
  if (/ремонт|монтаж|оборудован|отоплен|котел|котлы|радиатор|услуг|укладк/.test(value)) return false;
  return /строительн[а-я]*\s+смес|напольн[а-я]*\s+покрыт|(?:керамическ[а-я]*|тротуарн[а-я]*)\s+плитк|лакокрасочн/.test(value)
    || ['паркет', 'паркетная доска', 'ламинат', 'линолеум', 'краски и лаки'].includes(value);
}

function retailSourceGroup(task: VeCollectTask): string | null {
  if (task.source === 'companies_directory' && task.directory_filters) {
    const filters = Object.entries(task.directory_filters)
      .filter(([key, value]) => !['okvedCodes', 'nameTerms', 'identityCatalog'].includes(key) && value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `directory:${JSON.stringify(filters)}`;
  }
  if (task.source === 'yandex_maps' && task.maps_query?.queries.length) return `maps:${normalized(task.maps_query.geo ?? 'Россия')}`;
  return null;
}

function retailBranchTerms(terms: readonly string[], branch: number, branches: number): string[] {
  const count = Math.min(branches, terms.length);
  return terms.filter((_, index) => index % count === branch % count);
}

/** Pure correction of existing free sources. Preserve task positions, source
 * kinds, geography and size filters. Partition same-scope branches so an old
 * broad replan does not replay the first branch under another name. No tasks,
 * paid tools, queries per catalog task or collection limits are added. */
export function normalizeVeRetailSourcePlan(plan: VeSourcePlan, profile: VeRetailSourceProfile): VeSourcePlan {
  const evidence = profile === 'material_manufacturers' ? 'собственное производство' : 'производство или розничная сеть';
  const groups = new Map<string, number[]>();
  plan.tasks.forEach((task, index) => {
    const key = retailSourceGroup(task);
    if (key) groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const mapQueries = new Map<number, string[]>();
  for (const indexes of groups.values()) {
    if (plan.tasks[indexes[0]].source !== 'yandex_maps') continue;
    const terms = RETAIL_QUERIES[profile];
    const capacities = indexes.map((index) => plan.tasks[index].maps_query!.queries.length);
    // A bounded rewrite must still cover every alternative. Keep the original
    // queries if they cannot hold the canonical set; the rubric guard remains
    // in force. Extra branches must not become duplicate scans or empty tasks.
    if (capacities.reduce((sum, count) => sum + count, 0) < terms.length || indexes.length > terms.length) continue;
    let offset = 0;
    indexes.forEach((index, branch) => {
      const remaining = terms.length - offset;
      const laterCapacity = capacities.slice(branch + 1).reduce((sum, count) => sum + count, 0);
      const count = Math.min(capacities[branch], Math.max(Math.ceil(remaining / (indexes.length - branch)), remaining - laterCapacity));
      mapQueries.set(index, terms.slice(offset, offset + count));
      offset += count;
    });
  }
  return { ...plan, tasks: plan.tasks.map((task, index) => {
    const key = retailSourceGroup(task);
    if (!key) return task;
    const group = groups.get(key)!;
    const branch = group.indexOf(index);
    if (task.source === 'companies_directory' && task.directory_filters) {
      // Do not turn surplus branches into duplicate reads of the same code.
      // An unfamiliar plan keeps its original slices instead of cycling them.
      if (group.length > RETAIL_CODES[profile].length) return task;
      const filters = { ...task.directory_filters, okvedCodes: retailBranchTerms(RETAIL_CODES[profile], branch, group.length) };
      delete filters.nameTerms;
      delete filters.identityCatalog;
      return { ...task, directory_filters: filters,
        rationale: `Профильные виды деятельности выбранной аудитории; ${evidence} проверяется по данным компании.` };
    }
    if (task.source === 'yandex_maps' && task.maps_query) {
      const queries = mapQueries.get(index);
      const maps_query = { ...task.maps_query, catalog_revision: RETAIL_CATALOG_REVISION };
      // Even an unchanged canonical query now has a corrected mapping/guard.
      // Give it a distinct source key instead of reusing the old poor-yield hold.
      if (!queries) return { ...task, maps_query };
      return { ...task, maps_query: { ...maps_query, queries },
        rationale: `Профильные рубрики готового каталога; ${evidence} проверяется отдельно.` };
    }
    return task;
  }) };
}
