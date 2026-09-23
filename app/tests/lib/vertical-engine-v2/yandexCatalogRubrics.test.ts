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
import { isVeRubricVariant, resolveVeYandexCatalogFilters, veRuMapsUseCatalog } from '@/lib/verticalEngineV2/yandexCatalog';

/** Справочник и счёт «есть ли организации рубрики в стране», как у настоящей
 * функции каталога: рубрики сравниваются без учёта регистра. */
function catalog(rubrics: Array<[string, number]>, inRussia: Record<string, number>) {
  const counted: string[] = [];
  const db = {
    from: (table: string) => {
      const rows = table === 'yandex_maps_catalog_rubrics' ? rubrics.map(([rubric, companies]) => ({ rubric, companies }))
        : [{ country: 'Россия', region: 'Москва и Московская область', city: 'Москва' }];
      let start = 0, end = 999;
      const query = { select: () => query, order: () => query,
        range: (from: number, to: number) => { start = from; end = to; return query; },
        abortSignal: async () => ({ data: rows.slice(start, end + 1), error: null }) };
      return query;
    },
    rpc: (name: string, params: { p_categories: string[]; p_countries: string[] | null; p_cap: number }) => {
      if (name !== 'yandex_maps_catalog_count') throw new Error(`unexpected rpc ${name}`);
      expect(params).toMatchObject({ p_countries: ['Россия'], p_cap: 1 });
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

  it('отбрасывает рубрику модели без общих слов с запросами: «Клининг» не детская клиника', async () => {
    // База 0482f88b: модель добавила «Клининг» к клиникам.
    const { db } = catalog([
      ['Психиатрические клиники', 449], ['Детские клиники', 748], ['Клининг', 10_867], ['Медицинские центры и клиники', 55_225],
    ], { 'психиатрические клиники': 400, 'детские клиники': 700, клининг: 9_000, 'медицинские центры и клиники': 50_000 });
    modelPicks(['Психиатрические клиники', 'Детские клиники', 'Клининг', 'Медицинские центры и клиники']);
    const filters = await resolveVeYandexCatalogFilters({ db, query: { geo: 'Россия', queries: ['детская неврологическая клиника',
      'детская психиатрическая клиника', 'генетическая клиника', 'детская телемедицина'] } });
    expect(filters.categories).toEqual(['Психиатрические клиники', 'Детские клиники', 'Медицинские центры и клиники']);
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
});
