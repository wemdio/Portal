/** @jest-environment node */

/**
 * Выбор рубрик готового каталога Яндекс Карт (аудит 22.09.2026). Названия
 * рубрик и их размер — из yandex_maps_catalog_rubrics на проде; запросы —
 * дословно из планов разобранных баз.
 */

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getVeModel: jest.fn((kind: string) => `test-${kind}-model`),
  veNativeJsonSchema: jest.requireActual('@/lib/verticalEngineV2/llm').veNativeJsonSchema,
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { callLLMWithSchema } from '@/lib/verticalEngineV2/llm';
import { veSourceStrategyKey } from '@/lib/verticalEngineV2/adaptiveCollection';
import { isVeRubricVariant, resolveVeYandexCatalogFilters, veRuMapsUseCatalog } from '@/lib/verticalEngineV2/yandexCatalog';
import type { VeCollectTask } from '@/lib/verticalEngineV2/prompts/sourcePlan';
import { detectVeNicheSourceProfile, normalizeVeNicheSourceTask, normalizeVeRetailSourcePlan,
  veNicheDirectoryNameTerms, veNicheRubricAllowed, veRetailRubricAllowed } from '@/lib/verticalEngineV2/nicheSourcePolicy';
import { applyVeCollectionGeographyToPlan, readVeCollectionGeography, veCollectionGeographyFromBrief,
  veCollectionGeographyPlaces } from '@/lib/verticalEngineV2/collectionGeography';
import { buildSourcePlanMessages } from '@/lib/verticalEngineV2/prompts/sourcePlan';
import { buildSourcePlanMessagesEn, buildCatalogRepairMessagesEn } from '@/lib/verticalEngineV2/prompts/sourcePlan.en';
import { VeHhQuerySchema } from '@/lib/verticalEngineV2/schemas';
import { normalizeVeRestaurantSourcePlan } from '@/lib/verticalEngineV2/restaurantSourcePolicy';

/** Справочник и счёт «есть ли организации рубрики в стране», как у настоящей
 * функции каталога: рубрики сравниваются без учёта регистра. */
function catalog(rubrics: Array<[string, number]>, inRussia: Record<string, number>,
  scope: { countries?: string[]; cities?: string[] } = { countries: ['Россия'] },
  places = [{ country: 'Россия', region: 'Москва и Московская область', city: 'Москва' }]) {
  const counted: string[] = [];
  const db = {
    from: (table: string) => {
      const rows = table === 'yandex_maps_catalog_rubrics' ? rubrics.map(([rubric, companies]) => ({ rubric, companies }))
        : places;
      let start = 0, end = 999;
      const query = { select: () => query, order: () => query,
        range: (from: number, to: number) => { start = from; end = to; return query; },
        abortSignal: async () => ({ data: rows.slice(start, end + 1), error: null }) };
      return query;
    },
    rpc: (name: string, params: { p_categories: string[]; p_countries: string[] | null; p_cap: number }) => {
      if (name !== 'yandex_maps_catalog_count') throw new Error(`unexpected rpc ${name}`);
      expect(params).toMatchObject({ p_countries: scope.countries ?? null, p_cities: scope.cities ?? null, p_cap: 1 });
      counted.push(params.p_categories[0]);
      const total = params.p_categories.reduce((sum, label) => sum + (inRussia[label.toLowerCase()] ?? 0), 0);
      return { abortSignal: async () => ({ data: Math.min(total, params.p_cap), error: null }) };
    },
  } as unknown as SupabaseClient;
  return { db, counted };
}

/** Ответ модели по названиям рубрик из её же подсказки. */
function modelPicks(labels: string[]) {
  jest.mocked(callLLMWithSchema).mockImplementationOnce(async (messages, schema) => {
    const input = JSON.parse(String(messages.at(-1)?.content)) as { categories: Array<{ id: number; label: string }> };
    const ids = labels.map((label) => input.categories.find((item) => item.label === label)?.id)
      .filter((id): id is number => id !== undefined);
    return { data: schema.parse({ category_ids: ids, place_ids: [] }), tokensUsed: 0, costUsd: 0,
      promptTokens: 0, completionTokens: 0, rawResponse: '' };
  });
}

const shortlist = () => (JSON.parse(String(jest.mocked(callLLMWithSchema).mock.calls.at(-1)?.[0].at(-1)?.content)) as {
  categories: Array<{ label: string }> }).categories.map((item) => item.label);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(callLLMWithSchema).mockRejectedValue(new Error('модель в этом сценарии не нужна'));
});

describe('готовый каталог Яндекс Карт: выбор рубрик', () => {
  it('сохраняет географию брифа отдельно от legacy и сужает источники без новых задач или лимитов', () => {
    const geography = veCollectionGeographyFromBrief({ client_brief: { icp: { geo: '  Москва и МО  ' } } });
    expect(geography).toEqual({ version: 1, required: 'Москва и МО' });
    for (const geo of ['Москва\nМО', '  Москва\r\n\r\nМО  ']) {
      const multiline = veCollectionGeographyFromBrief({ client_brief: { icp: { geo } } });
      expect(multiline).toEqual({ version: 1, required: 'Москва, МО' });
      expect(veCollectionGeographyPlaces(multiline.required!)?.map((place) => place.regionCode)).toEqual(['77', '50']);
    }
    expect(veCollectionGeographyPlaces('г.Москва, Московская обл.')?.map((place) => place.regionCode)).toEqual(['77', '50']);
    expect(veCollectionGeographyPlaces('СПб и ЛО')?.map((place) => place.regionCode)).toEqual(['78', '47']);
    expect(veCollectionGeographyPlaces('Грузия')?.map((place) => place.hhArea)).toEqual(['28']);
    for (const geo of [undefined, null, '', ' — ', '---', '---\n---', 'не указано', 'без ограничений', 'весь мир'])
      expect(veCollectionGeographyFromBrief({ client_brief: { icp: { geo } } })).toEqual({ version: 1, required: null });
    expect(() => veCollectionGeographyFromBrief({ client_brief: { icp: { geo: ['Москва'] } } })).toThrow('Invalid client brief geography');
    expect(readVeCollectionGeography(undefined)).toBeNull();
    expect(() => readVeCollectionGeography({ version: 1 })).toThrow('Invalid collection geography');
    expect(() => readVeCollectionGeography({ version: 2, required: null })).toThrow('Invalid collection geography');
    const tasks: VeCollectTask[] = [
      { source: 'companies_directory', rationale: 'Производители', directory_filters: { okvedCodes: ['10'], employeesFrom: 3 } },
      { source: 'hh_live', rationale: 'Найм', hh_query: { text: 'пищевая промышленность', area: '113' } },
      { source: 'yandex_maps', rationale: 'Каталог', maps_query: { queries: ['производство продуктов'], geo: 'Россия' } },
    ];
    const original = structuredClone(tasks);
    const plan = { tasks };
    expect(applyVeCollectionGeographyToPlan(plan)).toBe(plan);
    expect(applyVeCollectionGeographyToPlan(plan, { version: 1, required: null })).toBe(plan);
    const scoped = applyVeCollectionGeographyToPlan(plan, geography);
    expect(scoped.tasks).toHaveLength(tasks.length);
    expect(scoped.tasks[0].directory_filters).toEqual({ ...tasks[0].directory_filters, regionCodes: ['77', '50'] });
    expect(scoped.tasks[1].hh_query).toEqual({ ...tasks[1].hh_query, area: ['1', '2019'] });
    expect(scoped.tasks[2].maps_query).toEqual({ ...tasks[2].maps_query, geo: 'Москва, Московская область', collection_geography: geography });
    expect(VeHhQuerySchema.parse(scoped.tasks[1].hh_query).area).toEqual(['1', '2019']);
    expect(VeHhQuerySchema.safeParse({ text: 'Найм', area: [] }).success).toBe(false);
    const restaurants = { market: 'ru', hypotheses: [{ origin: 'generated', broad: false,
      title: 'Ресторанные сети', description: 'Ресторанные сети.' }] };
    for (const area of ['113', ['113']]) expect(normalizeVeRestaurantSourcePlan({ tasks: [{ ...tasks[1],
      hh_query: { text: 'ресторан', area } }] }, restaurants).changed).toBe(true);
    for (const area of ['1', ['1', '2019']]) expect(normalizeVeRestaurantSourcePlan({ tasks: [{ ...tasks[1],
      hh_query: { text: 'ресторан', area } }] }, restaurants).changed).toBe(false);
    expect(applyVeCollectionGeographyToPlan(scoped, geography)).toEqual(scoped);
    expect(tasks).toEqual(original);
    const kazan = applyVeCollectionGeographyToPlan(plan, { version: 1, required: 'Казань' });
    expect(kazan.tasks[0].directory_filters).toEqual(tasks[0].directory_filters); // Казань не весь Татарстан.
    expect(kazan.tasks[1].hh_query?.area).toBe('88');
    const oblast = applyVeCollectionGeographyToPlan(plan, { version: 1, required: 'Новосибирская область' });
    expect(oblast.tasks[0].directory_filters?.regionCodes).toEqual(['54']);
    expect(oblast.tasks[1].hh_query?.area).toBe('1202');
    const restricted = 'РФ кроме Москвы';
    expect(veCollectionGeographyPlaces(restricted)).toBeNull();
    expect(applyVeCollectionGeographyToPlan(plan, { version: 1, required: restricted }).tasks[2].maps_query?.geo).toBe(restricted);
    for (const builder of [buildSourcePlanMessages, buildSourcePlanMessagesEn, buildCatalogRepairMessagesEn]) {
      const messages = builder({ verticalName: 'Производители', hypotheses: [{ title: 'Снеки' }], collectionGeography: geography });
      expect(String(messages[0].content)).toContain(JSON.stringify(geography.required));
      expect(String(messages[0].content)).toContain('MANDATORY COLLECTION GEOGRAPHY');
    }
  });

  it('география каталога сохраняет всю Москву и область, не расширяет город и не покупает сопоставление', async () => {
    const geography = { version: 1 as const, required: 'Москва и МО' };
    const { db } = catalog([['Кафе', 100]], { кафе: 5 }, { cities: ['Москва и Московская область', 'Москва'] });
    await expect(resolveVeYandexCatalogFilters({ db, query: {
      queries: ['кафе'], geo: 'Москва, Московская область', collection_geography: geography,
    } })).resolves.toEqual({ categories: ['Кафе'], cities: ['Москва и Московская область', 'Москва'] });
    const onlyCity = catalog([['Кафе', 100]], { кафе: 5 }, { cities: ['Москва'] });
    await expect(resolveVeYandexCatalogFilters({ db: onlyCity.db, query: { queries: ['кафе'], geo: 'Москва',
      collection_geography: { version: 1, required: 'Москва' } } })).resolves.toEqual({ categories: ['Кафе'], cities: ['Москва'] });
    const foreign = catalog([['Кафе', 100]], { кафе: 5 }, { countries: ['France', 'Germany'] }, [
      { country: 'France', region: 'Île-de-France', city: 'Paris' }, { country: 'Germany', region: 'Berlin', city: 'Berlin' },
    ]);
    await expect(resolveVeYandexCatalogFilters({ db: foreign.db, query: { queries: ['кафе'], geo: 'France, Germany',
      collection_geography: { version: 1, required: 'France, Germany' } } })).resolves.toEqual({ categories: ['Кафе'], countries: ['France', 'Germany'] });
    for (const required of ['РФ кроме Москвы', 'Москва и неизвестный город', 'СНГ'])
      await expect(resolveVeYandexCatalogFilters({ db, query: { queries: ['кафе'], geo: required,
        collection_geography: { version: 1, required } } })).rejects.toThrow('расширение географии запрещено');
    expect(callLLMWithSchema).not.toHaveBeenCalled();
  });

  it('модель сопоставляет только рубрику и не может урезать обязательную географию', async () => {
    const { db } = catalog([['Кафе', 100]], { кафе: 5 }, { cities: ['Москва и Московская область', 'Москва'] });
    modelPicks(['Кафе']);
    await expect(resolveVeYandexCatalogFilters({ db, query: { queries: ['семейное кафе'], geo: 'Россия',
      collection_geography: { version: 1, required: 'Москва и МО' } } })).resolves.toEqual({ categories: ['Кафе'], cities: ['Москва и Московская область', 'Москва'] });
    expect(callLLMWithSchema).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(String(jest.mocked(callLLMWithSchema).mock.calls[0][0].at(-1)?.content));
    expect(prompt.places).toEqual([]);
    expect(prompt.fixed_geography).toEqual({ cities: ['Москва и Московская область', 'Москва'] });
  });

  it('«агентство недвижимости» в России берёт рубрику с организациями, а не пустую в единственном числе', async () => {
    // База 3cfcfbbd: дословное совпадение давало рубрику без единой организации
    // в России, то есть 0 строк и ложное «Источники выбранного плана исчерпаны».
    const { db, counted } = catalog([
      ['Агентства недвижимости', 40_367], ['агентство недвижимости', 34], ['Агентство недвижимости', 101],
      ['Недвижимость', 148_830], ['Коммерческая недвижимость', 15_853], ['Девелопмент недвижимости', 1_584],
    ], { 'агентства недвижимости': 33_644, недвижимость: 120_000, 'коммерческая недвижимость': 12_000 });
    await expect(resolveVeYandexCatalogFilters({ db, query: { queries: ['агентство недвижимости'], geo: 'Россия' } }))
      .resolves.toEqual({ categories: ['Агентства недвижимости'], countries: ['Россия'] });
    // Формы запроса выбраны без модели, пустые в стране отброшены по счёту;
    // регистр каталог не различает, поэтому одна форма проверяется один раз.
    expect(callLLMWithSchema).not.toHaveBeenCalled();
    expect(counted.map((label) => label.toLowerCase()).sort()).toEqual(['агентства недвижимости', 'агентство недвижимости']);
  });

  it('если в стране нет организаций ни в одной подходящей рубрике — ошибка с причиной, а не пустой фильтр', async () => {
    const { db } = catalog([['агентство недвижимости', 34], ['Агентство недвижимости', 101]], {});
    modelPicks(['агентство недвижимости', 'Агентство недвижимости']);
    await expect(resolveVeYandexCatalogFilters({ db, query: { queries: ['агентство недвижимости'], geo: 'Россия' } }))
      .rejects.toThrow('в готовом каталоге нет организаций по рубрикам «агентство недвижимости», «Агентство недвижимости» в географии «Россия»');
  });

  it('слитная рубрика «Медлаборатории» находится по запросу «медицинская лаборатория»', async () => {
    expect(isVeRubricVariant('Медлаборатории', 'медицинская лаборатория')).toBe(true);
    expect(isVeRubricVariant('Турагентства', 'туристическое агентство')).toBe(true);
    expect(isVeRubricVariant('Медцентры', 'медицинский центр')).toBe(true);
    // Не формы одного слова: общее начало ещё не делает рубрику той же.
    expect(isVeRubricVariant('Клининг', 'клиника')).toBe(false);
    expect(isVeRubricVariant('Кафель', 'кафе')).toBe(false);
    expect(isVeRubricVariant('Ветлаборатории', 'медицинская лаборатория')).toBe(false);

    const rubrics: Array<[string, number]> = [
      ['медицинская лаборатория', 22], ['Медицинская лаборатория', 61], ['Медлаборатории', 19_019],
      ['Пункт выдачи и приема анализов', 48], ['Ветлаборатории', 2_547], ['Зуботехнические лаборатории', 4_421],
      ['Медицинские центры и клиники', 55_225], ['Медицинские услуги', 66_096],
    ];
    const inRussia = { 'медицинская лаборатория': 40, медлаборатории: 15_318, 'пункт выдачи и приема анализов': 8 };
    const single = catalog(rubrics, inRussia);
    await expect(resolveVeYandexCatalogFilters({ db: single.db,
      query: { queries: ['медицинская лаборатория'], geo: 'Россия' } })).resolves.toEqual({
      categories: ['медицинская лаборатория', 'Медицинская лаборатория', 'Медлаборатории'], countries: ['Россия'] });

    // База 433aa426: модель выбрала только формы в единственном числе и пункт
    // анализов — 48 организаций на всю страну, «исчерпано» на 42 строках.
    const audited = catalog(rubrics, inRussia);
    modelPicks(['медицинская лаборатория', 'Медицинская лаборатория', 'Пункт выдачи и приема анализов']);
    const filters = await resolveVeYandexCatalogFilters({ db: audited.db,
      query: { queries: ['медицинская лаборатория', 'пункт приема анализов', 'анализы'], geo: 'Россия' } });
    expect(shortlist()).toContain('Медлаборатории');
    expect(filters.categories).toEqual(expect.arrayContaining(['Медлаборатории', 'Пункт выдачи и приема анализов']));
  });

  it('сохраняет магазины вместе с мастерскими, не расширяя синоним на поставщиков или географию', async () => {
    for (const query of ['ювелирный магазин', 'ювелирные магазины', 'магазин ювелирных изделий', 'магазины ювелирных изделий'])
      expect(isVeRubricVariant('Ювелирные', query)).toBe(true);
    for (const query of ['ювелирная мастерская', 'ювелирный завод', 'производитель ювелирных изделий',
      'оборудование для ювелирного магазина']) expect(isVeRubricVariant('Ювелирные', query)).toBe(false);
    expect(isVeRubricVariant('Ювелирное оборудование', 'ювелирный магазин')).toBe(false);
    expect(isVeRubricVariant('Строительные', 'строительный магазин')).toBe(false);

    const rubrics: Array<[string, number]> = [
      ['Ювелирные', 1_000], ['Ювелирные мастерские', 100], ['Ювелирное оборудование', 50],
    ];
    const counts = { ювелирные: 900, 'ювелирные мастерские': 80, 'ювелирное оборудование': 40 };
    const query = { queries: ['ювелирный магазин', 'ювелирная мастерская'], geo: 'Россия' };
    const direct = catalog(rubrics, counts);
    await expect(resolveVeYandexCatalogFilters({ db: direct.db, query })).resolves.toEqual({
      categories: ['Ювелирные', 'Ювелирные мастерские'], countries: ['Россия'],
    });
    expect(callLLMWithSchema).not.toHaveBeenCalled();
    expect(direct.counted).toEqual(['Ювелирные', 'Ювелирные мастерские']);

    // Another query needs a model, but its partial answer cannot remove the
    // deterministic shop match or cause another model call to restore it.
    modelPicks(['Ювелирные мастерские']);
    await expect(resolveVeYandexCatalogFilters({ db: direct.db,
      query: { ...query, queries: [...query.queries, 'золотых дел мастер'] },
    })).resolves.toEqual({ categories: ['Ювелирные', 'Ювелирные мастерские'], countries: ['Россия'] });
    expect(callLLMWithSchema).toHaveBeenCalledTimes(1);

    const emptyShops = catalog(rubrics, { 'ювелирные мастерские': 80 });
    modelPicks(['Ювелирные мастерские']);
    await expect(resolveVeYandexCatalogFilters({ db: emptyShops.db, query })).resolves.toEqual({
      categories: ['Ювелирные мастерские'], countries: ['Россия'],
    });
    const workshopsOnly = catalog(rubrics, counts);
    modelPicks(['Ювелирные', 'Ювелирные мастерские']);
    await expect(resolveVeYandexCatalogFilters({ db: workshopsOnly.db, query,
      rubricAllowed: (label) => label === 'Ювелирные мастерские',
    })).resolves.toEqual({ categories: ['Ювелирные мастерские'], countries: ['Россия'] });
    expect(workshopsOnly.counted).toEqual(['Ювелирные мастерские']);
    expect(shortlist()).toEqual(['Ювелирные мастерские']);

    const city = catalog(rubrics, counts, { cities: ['Москва'] });
    await expect(resolveVeYandexCatalogFilters({ db: city.db, query: { ...query, geo: 'Москва' } })).resolves.toEqual({
      categories: ['Ювелирные', 'Ювелирные мастерские'], cities: ['Москва'],
    });
    await expect(resolveVeYandexCatalogFilters({ db: city.db, query: { ...query, geo: 'Казань' } }))
      .rejects.toThrow('география «Казань» не найдена');
    expect(callLLMWithSchema).toHaveBeenCalledTimes(3);
  });

  it('отбрасывает рубрику модели без общих слов с запросами: «Клининг» не детская клиника', async () => {
    // База 0482f88b: модель добавила «Клининг» к клиникам.
    const { db } = catalog([
      ['Психиатрические клиники', 449], ['Детские клиники', 748], ['Клининг', 10_867], ['Медицинские центры и клиники', 55_225],
    ], { 'психиатрические клиники': 400, 'детские клиники': 700, клининг: 9_000, 'медицинские центры и клиники': 50_000 });
    modelPicks(['Психиатрические клиники', 'Детские клиники', 'Клининг', 'Медицинские центры и клиники']);
    const filters = await resolveVeYandexCatalogFilters({ db, query: { geo: 'Россия', queries: ['детская неврологическая клиника',
      'детская психиатрическая клиника', 'генетическая клиника', 'детская телемедицина'] } });
    expect(filters.categories).toEqual(['Психиатрические клиники', 'Детские клиники', 'Медицинские центры и клиники']);

    // An exact query or the model's fallback must not restore a broader
    // business model forbidden by the hypothesis source policy.
    const payments = catalog([
      ['Денежные переводы', 25_000], ['Платёжные системы', 120], ['Банки', 30_000],
    ], { 'денежные переводы': 24_000, 'платёжные системы': 100, банки: 29_000 });
    const rubricAllowed = (label: string) => label === 'Платёжные системы';
    const audience = 'Финтех и платёжное посредничество: провайдеры платёжных систем, не отделения денежных переводов';
    modelPicks(['Денежные переводы', 'Платёжные системы']);
    await expect(resolveVeYandexCatalogFilters({ db: payments.db,
      query: { queries: ['денежные переводы'], geo: 'Россия' }, context: audience, rubricAllowed,
    })).resolves.toEqual({ categories: ['Платёжные системы'], countries: ['Россия'] });
    const mappedInput = JSON.parse(String(jest.mocked(callLLMWithSchema).mock.calls.at(-1)?.[0].at(-1)?.content));
    expect(mappedInput.audience_context).toBe(audience);
    expect(shortlist()).toEqual(['Платёжные системы']);
    expect(payments.counted).toEqual(['Платёжные системы']);

    modelPicks(['Денежные переводы']);
    await expect(resolveVeYandexCatalogFilters({ db: payments.db,
      query: { queries: ['денежные переводы'], geo: 'Россия' }, rubricAllowed,
    })).rejects.toThrow('подходящие рубрики');
    const modelCalls = jest.mocked(callLLMWithSchema).mock.calls.length;
    await expect(resolveVeYandexCatalogFilters({ db: payments.db,
      query: { queries: ['денежные переводы'], geo: 'Россия' }, rubricAllowed: () => false,
    })).rejects.toThrow('подходящие рубрики');
    await expect(resolveVeYandexCatalogFilters({ db: payments.db,
      query: { queries: ['платёжные системы'], geo: 'Россия' }, rubricAllowed,
    })).resolves.toEqual({ categories: ['Платёжные системы'], countries: ['Россия'] });
    expect(callLLMWithSchema).toHaveBeenCalledTimes(modelCalls);


    // Source policy is tied to an explicit audience, not to the client's offer
    // in its description; ordinary hypotheses retain their original sources.
    const profiles = [
      ['Финтех и платежное посредничество', 'payments'],
      ['Платформы эзотерики и астрологических консультаций', 'esoteric_platform'],
      ['Платформы веб-моделей и взрослого контента', 'adult_platform'],
      ['Трансграничная электронная коммерция', 'crossborder_ecommerce'],
      ['Трансграничные сервисы доставки товаров (байеры)', 'crossborder_buyers'],
    ] as const;
    for (const [title, profile] of profiles) {
      expect(detectVeNicheSourceProfile([{ title }])).toBe(profile);
      expect(detectVeNicheSourceProfile([{ title }, { title }])).toBe(profile);
      expect(detectVeNicheSourceProfile([{ title }, { title: 'Энергетические компании' }])).toBeNull();
      const terms = veNicheDirectoryNameTerms(profile);
      expect(terms.length).toBeLessThanOrEqual(12);
      expect(terms.every((term) => term.length >= 3 && !/[%_*(),]/.test(term))).toBe(true);
      terms.length = 0;
      expect(veNicheDirectoryNameTerms(profile).length).toBeGreaterThan(0);
      const tasks: VeCollectTask[] = [
        { source: 'companies_directory', rationale: 'Реестр', directory_filters: {
          okvedCodes: ['47', '47.1', '47.9', '46'], regionCodes: ['77'], employeesFrom: 3, employeesTo: 20,
          revenueFrom: 10, revenueTo: 100, hasEmail: true, includeIp: false, sizeOrUnknown: { employeesFrom: 3 },
        } },
        { source: 'yandex_maps', rationale: 'Каталог', maps_query: { queries: ['банки'], geo: 'Казань' } },
        { source: 'hh_live', rationale: 'Вакансии', hh_query: {
          text: 'менеджер', area: '1', date_from: '2026-01-01', date_to: '2026-10-01',
        } },
      ];
      const original = JSON.stringify(tasks);
      const adjusted = tasks.map((task) => normalizeVeNicheSourceTask(task, profile));
      expect(JSON.stringify(tasks)).toBe(original);
      expect(adjusted).toHaveLength(tasks.length);
      expect(adjusted.map((task) => task.source)).toEqual(tasks.map((task) => task.source));
      expect(adjusted[0].directory_filters).toEqual({ ...tasks[0].directory_filters,
        okvedCodes: profile.startsWith('crossborder_') ? ['47.91', '46'] : ['47', '47.1', '47.9', '46'],
        nameTerms: veNicheDirectoryNameTerms(profile),
        ...(profile === 'payments' ? { identityCatalog: 'payments-2026-10-12' } : {}),
      });
      expect(adjusted[1].maps_query?.geo).toBe('Казань');
      expect(adjusted[1].maps_query?.queries.length).toBeLessThanOrEqual(1);
      expect(adjusted[2].hh_query).toMatchObject({ area: '1', date_from: '2026-01-01', date_to: '2026-10-01' });
      expect(adjusted[2].hh_query?.text.length).toBeLessThanOrEqual(300);
      expect(adjusted.map((task) => normalizeVeNicheSourceTask(task, profile))).toEqual(adjusted);
      if (profile === 'payments') {
        expect(normalizeVeNicheSourceTask(adjusted[0], 'adult_platform').directory_filters?.identityCatalog).toBeUndefined();
      }
    }
    expect(detectVeNicheSourceProfile([])).toBeNull();
    expect(detectVeNicheSourceProfile(profiles.map(([title]) => ({ title })))).toBeNull();
    for (const title of ['Энергетические компании', 'Финтех-компании', 'HR для финтеха', 'Разработчики платежных систем',
      'Вебкам-студии', 'Астрологические консультации', 'Эзотерические центры', 'Интернет-магазины', 'Байерские агентства',
      'Платёжные терминалы', 'Разработчики трансграничных интернет-магазинов', 'Клиенты платежных агрегаторов',
      'CRM для платёжных провайдеров', 'Платформы обучения веб-моделей', 'Школы трансграничной электронной коммерции']) {
      expect(detectVeNicheSourceProfile([{ title,
        description: 'Наш продукт — платформа PSP. Поможем выйти на зарубежные рынки и принимать платежи.',
      }])).toBeNull();
    }
    for (const label of ['Платежные небанковские кредитные организации', 'Банковские платёжные агенты',
      'Платёжные системы', 'Процессинговые компании']) expect(veNicheRubricAllowed('payments', label)).toBe(true);
    for (const label of ['Денежные переводы', 'Банки', 'Платёжные терминалы', 'Разработка платёжных систем'])
      expect(veNicheRubricAllowed('payments', label)).toBe(false);
    expect(veNicheRubricAllowed('adult_platform', 'Вебкам студии')).toBe(false);
    expect(veNicheRubricAllowed('esoteric_platform', 'Эзотерические центры')).toBe(false);
    expect(veNicheRubricAllowed('crossborder_buyers', 'Доставка покупок из-за рубежа')).toBe(true);
    for (const label of ['Выкуп автозапчастей из США', 'Выкуп авто запчастей из Европы',
      'Доставка автозапчастей из Европы', 'Доставка авто запчастей из США'])
      expect(veNicheRubricAllowed('crossborder_buyers', label)).toBe(true);
    for (const label of ['Выкуп автомобилей из Европы', 'Выкуп авто из США',
      'Выкуп автомашин из Китая', 'Выкуп автомобилей и автозапчастей из США',
      'Доставка автомобилей из Европы', 'Доставка оборудования из США', 'Доставка автозапчастей по России'])
      expect(veNicheRubricAllowed('crossborder_buyers', label)).toBe(false);
    expect(veNicheRubricAllowed('crossborder_buyers', 'Международная доставка грузов')).toBe(false);
    expect(veNicheRubricAllowed('crossborder_ecommerce', 'Интернет-магазины')).toBe(true);
    expect(veNicheRubricAllowed('crossborder_ecommerce', 'Разработка интернет-магазинов')).toBe(false);
  });

  it('рынок РФ: Google Maps в плане заменяется готовым каталогом, дубль запроса не множится', () => {
    const maps = { queries: ['агентство недвижимости'], geo: 'Россия' };
    const directory = { source: 'companies_directory' as const, rationale: 'Реестр', directory_filters: { okvedCodes: ['68.3'] } };
    expect(veRuMapsUseCatalog({ tasks: [directory,
      { source: 'google_maps', rationale: 'Карточки агентств', maps_query: maps },
      { source: 'yandex_maps', rationale: 'Каталог агентств', maps_query: { queries: ['риелтор'], geo: 'Казань' } },
    ] })).toEqual({ replaced: 1, plan: { tasks: [directory,
      { source: 'yandex_maps', rationale: 'Карточки агентств', maps_query: maps },
      { source: 'yandex_maps', rationale: 'Каталог агентств', maps_query: { queries: ['риелтор'], geo: 'Казань' } },
    ] } });
    expect(veRuMapsUseCatalog({ tasks: [{ source: 'yandex_maps', rationale: 'Каталог', maps_query: maps },
      { source: 'google_maps', rationale: 'То же вживую', maps_query: maps }] }).plan.tasks)
      .toEqual([{ source: 'yandex_maps', rationale: 'Каталог', maps_query: maps }]);
  });

  it('исправляет только бесплатные источники согласованной retail-аудитории, сохраняя границы и разные ветки', async () => {
    const directory: VeCollectTask = { source: 'companies_directory', rationale: 'Старый реестр', directory_filters: {
      okvedCodes: ['32.13', '47.7', '28.29'], regionCodes: ['77'], includeIp: false, hasEmail: true,
      revenueFrom: 10, revenueTo: 100, employeesFrom: 3, employeesTo: 20, sizeOrUnknown: { employeesFrom: 3 },
      nameTerms: ['старый'], identityCatalog: 'payments-2026-10-12',
    } };
    const maps: VeCollectTask = { source: 'yandex_maps', rationale: 'Старый каталог',
      maps_query: { geo: 'Россия', queries: ['отопительное оборудование', 'ювелирная мастерская'] } };
    const hiring: VeCollectTask = { source: 'hh_live', rationale: 'Историческая задача',
      hh_query: { text: 'ювелир', area: '113', date_from: '2025-02-01', date_to: '2026-02-10' } };
    const original = { tasks: [directory, maps, hiring, { ...directory, widened: 'replan' as const }] };
    const before = JSON.stringify(original);
    for (const profile of ['material_manufacturers', 'jewelry_manufacturers_or_chains'] as const) {
      const adjusted = normalizeVeRetailSourcePlan(original, profile);
      expect(JSON.stringify(original)).toBe(before);
      expect(adjusted.tasks.map((task) => task.source)).toEqual(original.tasks.map((task) => task.source));
      expect(adjusted.tasks[2]).toBe(hiring);
      expect(normalizeVeRetailSourcePlan(adjusted, profile)).toEqual(adjusted);
      const codes = adjusted.tasks.flatMap((task) => task.directory_filters?.okvedCodes ?? []);
      expect(codes.sort()).toEqual(profile === 'material_manufacturers'
        ? ['16.22', '20.30', '23.31', '23.64'] : ['32.12', '47.77']);
      for (const task of adjusted.tasks.filter((task) => task.source === 'companies_directory')) {
        expect(task.directory_filters).toEqual({ ...directory.directory_filters,
          okvedCodes: task.directory_filters!.okvedCodes, nameTerms: undefined, identityCatalog: undefined });
      }
      expect(adjusted.tasks[1].maps_query?.geo).toBe('Россия');
      expect(adjusted.tasks[1].maps_query!.queries.length).toBeLessThanOrEqual(maps.maps_query!.queries.length);
      if (profile === 'material_manufacturers') expect(adjusted.tasks[1]).toEqual({ ...maps,
        maps_query: { ...maps.maps_query, catalog_revision: 2 } }); // Two slots cannot cover four branches.
      else expect(adjusted.tasks[1].maps_query!.queries.every((query) => veRetailRubricAllowed(profile, query))).toBe(true);
    }
    const split = normalizeVeRetailSourcePlan({ tasks: [maps, maps] }, 'material_manufacturers');
    expect(split.tasks.flatMap((task) => task.maps_query!.queries).sort())
      .toEqual(['керамическая плитка', 'лакокрасочные материалы', 'напольные покрытия', 'строительные смеси']);
    expect(normalizeVeRetailSourcePlan(split, 'material_manufacturers')).toEqual(split);
    for (const capacities of [[1], [1, 3], [3, 1], [1, 1, 2], [8, 8]]) {
      const tasks = capacities.map((capacity) => ({ ...maps,
        maps_query: { ...maps.maps_query!, queries: Array.from({ length: capacity }, (_, index) => `исходная рубрика ${index}`) } }));
      const result = normalizeVeRetailSourcePlan({ tasks }, 'material_manufacturers');
      if (capacities.reduce((sum, count) => sum + count, 0) < 4) expect(result.tasks).toEqual(tasks.map((task) => ({ ...task,
        maps_query: { ...task.maps_query, catalog_revision: 2 } })));
      else expect(result.tasks.flatMap((task) => task.maps_query!.queries).sort()).toEqual(
        ['керамическая плитка', 'лакокрасочные материалы', 'напольные покрытия', 'строительные смеси']);
      result.tasks.forEach((task, index) => {
        expect(task.maps_query!.queries.length).toBeGreaterThan(0);
        expect(task.maps_query!.queries.length).toBeLessThanOrEqual(capacities[index]);
      });
      expect(normalizeVeRetailSourcePlan(result, 'material_manufacturers')).toEqual(result);
    }
    const canonical = { ...maps, maps_query: { geo: 'Россия', queries: ['ювелирный магазин'] } };
    const revised = normalizeVeRetailSourcePlan({ tasks: [canonical, hiring] }, 'jewelry_manufacturers_or_chains');
    expect(canonical.maps_query).toEqual({ geo: 'Россия', queries: ['ювелирный магазин'] });
    expect(revised.tasks[0].maps_query).toEqual({ ...canonical.maps_query, catalog_revision: 2 });
    expect(veSourceStrategyKey(revised.tasks[0])).not.toBe(veSourceStrategyKey(canonical));
    expect(veSourceStrategyKey(revised.tasks[1])).toBe(veSourceStrategyKey(hiring));
    expect(normalizeVeRetailSourcePlan(revised, 'jewelry_manufacturers_or_chains')).toEqual(revised);
    const tooManyDirectories = { tasks: ['32.12', '47.77', '32.13'].map((code) => ({ ...directory,
      directory_filters: { ...directory.directory_filters, okvedCodes: [code] } })) };
    const overflow = normalizeVeRetailSourcePlan(tooManyDirectories, 'jewelry_manufacturers_or_chains');
    expect(overflow).toEqual(tooManyDirectories);
    expect(overflow.tasks.map(veSourceStrategyKey)).toEqual(tooManyDirectories.tasks.map(veSourceStrategyKey));
    expect(new Set(overflow.tasks.map(veSourceStrategyKey)).size).toBe(3);
    // Existing niche auto-detection cannot activate a retail rewrite by title.
    for (const title of ['Производители строительно-отделочных материалов', 'Ювелирные заводы и сети украшений'])
      expect(detectVeNicheSourceProfile([{ title }])).toBeNull();
    for (const label of ['Отопительное оборудование', 'Ремонт паркета', 'Оборудование для напольных покрытий',
      'Лаки для ногтей', 'Сухие смеси для детей', 'Ламинаторы'])
      expect(veRetailRubricAllowed('material_manufacturers', label)).toBe(false);
    for (const label of ['Аптеки', 'Одежда', 'Ювелирная мастерская', 'Ювелирное оборудование', 'Ювелирные ломбарды', 'Бижутерия'])
      expect(veRetailRubricAllowed('jewelry_manufacturers_or_chains', label)).toBe(false);
    const jewelry = catalog([['Ювелирные', 100], ['Ювелирная мастерская', 500], ['Аптеки', 10_000]],
      { ювелирные: 100, 'ювелирная мастерская': 500, аптеки: 10_000 });
    await expect(resolveVeYandexCatalogFilters({ db: jewelry.db,
      query: { queries: ['ювелирный магазин'], geo: 'Россия' },
      rubricAllowed: (label) => veRetailRubricAllowed('jewelry_manufacturers_or_chains', label),
    })).resolves.toEqual({ categories: ['Ювелирные'], countries: ['Россия'] });
    expect(callLLMWithSchema).not.toHaveBeenCalled();
  });
});
