/** @jest-environment node */

/**
 * План кончился раньше цели. Аудит 22.09.2026: 33 базы встали на исчерпанном
 * срезе, хотя рынок гипотезы шире, и ни одна не сменила срез сама
 * (replan_attempts=0 у всех). Тексты гипотез и фильтры — с прода.
 */
import { beginAdaptiveBatch, type VeCollectInfo } from '@/lib/verticalEngineV2/stages/baseCollect';
import { finishVeAdaptiveBatch, newVeAdaptiveCollection, veReadyContactKeys, veSourceStrategyKey,
  type VeAdaptiveCollection, type VeBatchSpend } from '@/lib/verticalEngineV2/adaptiveCollection';
import { normalizeVeGenerationSourcePlan, stripUnfoundedSizeFilters, veCanWidenPlan, veDirectorySizeKeep, veHypothesisSizeBasis, veSecondQueueTask,
  veSecondQueueTasks } from '@/lib/verticalEngineV2/planWidening';
import { canResumePartialPreview, getVeCollectionContinuation } from '@/lib/verticalEngineV2/collectionRecovery';
import { createVeCollectionAudienceSnapshot } from '@/lib/verticalEngineV2/sourceAudience';
import { detectVeClinicSourceProfile, isVeClinicCatalogTask, normalizeVeClinicSourcePlan, veClinicRubricAllowed } from '@/lib/verticalEngineV2/clinicSourcePolicy';
import { detectVeMediaSourceProfile, isVeMediaCatalogTask, normalizeVeMediaSourcePlan, veMediaRubricAllowed } from '@/lib/verticalEngineV2/mediaSourcePolicy';
import { VE_RELEVANCE_RULES_VERSION, VE_RELEVANCE_WEBSITE_VERSION } from '@/lib/verticalEngineV2/relevanceDecision';
import { VE_RELEVANCE_TRIAGE_VERSION } from '@/lib/verticalEngineV2/relevanceTriageConfig';
import { VE_STAFFING_CORRECTION_VERSION } from '@/lib/verticalEngineV2/staffingCorrection';
import type { VeCollectTask } from '@/lib/verticalEngineV2/prompts/sourcePlan';

const HYPOTHESES = {
  meat: 'Мясопереработка\nПроизводители колбас, мясных полуфабрикатов, охлажденного мяса и деликатесов с Меркурием и сложной прослеживаемостью партий.',
  energy: 'Энергетические компании\nЭнергосбыт, сервисные и электросетевые компании, которым нужны инженеры РЗА, энергетики, диспетчеры и руководители эксплуатации.',
  horeca: 'Поставщики HoReCa\nДистрибьюторы продуктов, оборудования и расходников для ресторанов/отелей с региональными продажами и сервисом.',
  sweets: 'Кондитерские фабрики\nКрупные производители конфет, шоколада, печенья и снеков с рецептурами, сменами, складами сырья и поставками в федеральные сети.',
  agencies: 'Малые агентства недвижимости\nАгентства 3–30 агентов, продающие вторичку и новостройки в регионах, которым нужен единый источник объектов и комиссий.',
  dentists: 'Стоматологии 3+ кресла\nЧастные стоматологии с лицензией, несколькими врачами и чеком на терапию, ортопедию, имплантацию.',
  transport: 'Транспортные холдинги\nКрупные автотранспортные, ЖД- и мультимодальные группы с филиалами, ремонтом, складами, договорами и учетными системами.',
  refinery: 'Нефтеперерабатывающие заводы\nНПЗ с лабораториями контроля сырья, полуфабрикатов и готовых нефтепродуктов. ЛИМС закрывает путь пробы, протоколы, паспорта качества и интеграции с производственным контуром.',
};
const directory = (filters: NonNullable<VeCollectTask['directory_filters']>): VeCollectTask =>
  ({ source: 'companies_directory', rationale: 'Реестр по ОКВЭД гипотезы.', directory_filters: filters });
// f1bb9ccf «Мясопереработка»: реестр с порогами 954 компании, без них 3 389.
const MEAT_TASK = directory({ includeIp: false, okvedCodes: ['10.1'], revenueFrom: 100_000_000, employeesFrom: 20 });
// 6b475d8c «Кондитерские фабрики», гипотеза «Крупные производители»: размер законен.
const SWEETS_TASK = directory({ includeIp: false, okvedCodes: ['10.7', '10.8'], revenueFrom: 300_000_000, employeesFrom: 50 });
// 3cfcfbbd «Малые агентства недвижимости»: 3–50 сотрудников, выручка до 300 млн.
const AGENCIES_TASK = directory({ okvedCodes: ['68.3'], employeesFrom: 3, employeesTo: 50, revenueTo: 300_000_000 });

describe('основание размера в тексте гипотезы', () => {
  it('отличает размер, названный в гипотезе, от порога, придуманного планировщиком', () => {
    expect(veHypothesisSizeBasis(HYPOTHESES.meat)).toBe(false);
    // «электросетевые» — не сеть компаний.
    expect(veHypothesisSizeBasis(HYPOTHESES.energy)).toBe(false);
    expect(veHypothesisSizeBasis(HYPOTHESES.horeca)).toBe(false);
    expect(veHypothesisSizeBasis('Digital-агентства\nПродвижение клиентов в социальных сетях и документооборот с заказчиками.')).toBe(false);
    expect(veHypothesisSizeBasis(HYPOTHESES.sweets)).toBe(true);
    expect(veHypothesisSizeBasis(HYPOTHESES.agencies)).toBe(true);
    expect(veHypothesisSizeBasis(HYPOTHESES.dentists)).toBe(true);
    expect(veHypothesisSizeBasis(HYPOTHESES.transport)).toBe(true);
    expect(veHypothesisSizeBasis(HYPOTHESES.refinery)).toBe(false);
    expect(veHypothesisSizeBasis('НПЗ')).toBe(false);
    expect(veHypothesisSizeBasis('Крупные нефтеперерабатывающие заводы')).toBe(true);
    expect(veHypothesisSizeBasis('НПЗ от 100 сотрудников')).toBe(true);
    expect(veHypothesisSizeBasis('Горно-обогатительные комбинаты')).toBe(true);
  });

  it('планировщик не сохраняет порог без основания, а обоснованный оставляет', () => {
    const meat = stripUnfoundedSizeFilters({ tasks: [MEAT_TASK] }, HYPOTHESES.meat);
    expect(meat.stripped).toBe(1);
    expect(meat.plan.tasks[0].directory_filters).toEqual({ includeIp: false, okvedCodes: ['10.1'] });
    const sweets = stripUnfoundedSizeFilters({ tasks: [SWEETS_TASK] }, HYPOTHESES.sweets);
    expect(sweets.stripped).toBe(0);
    expect(sweets.plan.tasks[0]).toBe(SWEETS_TASK);
    // Без ОКВЭД и региона снятие порога открыло бы весь реестр: такой срез не трогаем.
    const unscoped = directory({ revenueFrom: 1_000_000_000 });
    expect(stripUnfoundedSizeFilters({ tasks: [unscoped] }, HYPOTHESES.meat).plan.tasks[0]).toBe(unscoped);

    // Аврора / НПЗ: тип деятельности сам по себе не задаёт размер компании.
    // Fresh planning removes the invented size filter; saved tasks retain
    // their identity and only their existing bounded second queue is widened.
    const refinery = directory({ okvedCodes: ['19.2'], employeesFrom: 100, hasEmail: false, includeIp: false });
    const refineryBefore = JSON.stringify(refinery);
    const refineryScope = { okvedCodes: ['19.2'], hasEmail: false, includeIp: false };
    const normalizedRefinery = stripUnfoundedSizeFilters({ tasks: [refinery] }, HYPOTHESES.refinery);
    expect(normalizedRefinery.stripped).toBe(1);
    expect(normalizedRefinery.plan.tasks[0].directory_filters).toEqual(refineryScope);
    expect(stripUnfoundedSizeFilters({ tasks: [refinery] }, 'Крупные НПЗ').plan.tasks[0]).toBe(refinery);
    expect(veSecondQueueTask(refinery, veHypothesisSizeBasis(HYPOTHESES.refinery))?.directory_filters).toEqual(refineryScope);
    expect(JSON.stringify(refinery)).toBe(refineryBefore);

    // A new plan for Aurora's generating companies must not buy an unrelated
    // water-utility slice or treat a generic chemist vacancy as sector proof.
    const powerScope = { market: 'ru', hypotheses: [{ title: 'Энергетические компании', broad: false,
      description: 'ТЭЦ, ГРЭС, АЭС-смежные и генерирующие компании с химлабораториями воды, топлива, масел и выбросов. ЛИМС упорядочивает пробы, графики, приборы и отчётность.' }] };
    const power = directory({ okvedCodes: ['35.1', '35.3'], regionCodes: ['78'], revenueFrom: 500_000_000 });
    const water = directory({ okvedCodes: ['36', '37'], regionCodes: ['78'], revenueFrom: 200_000_000 });
    const chemicalHh: VeCollectTask = { source: 'hh_live', rationale: 'Химлаборатории', hh_query: { area: '2',
      date_from: '2026-08-15', date_to: '2026-09-15',
      text: 'инженер-химик OR лаборант химического анализа OR химик лаборатории ТЭЦ OR ГРЭС OR электростанция OR водоканал' } };
    const mixedPowerMaps: VeCollectTask = { source: 'yandex_maps', rationale: 'Площадки',
      maps_query: { queries: ['ТЭЦ', 'ГРЭС', 'водоканал', 'очистные сооружения'], geo: 'Санкт-Петербург' } };
    const oldPowerPlan = { tasks: [chemicalHh, power, water, mixedPowerMaps] };
    const powerBefore = JSON.stringify(oldPowerPlan);
    const fixedPower = normalizeVeGenerationSourcePlan(oldPowerPlan, powerScope);
    expect(fixedPower.changed).toBe(true);
    expect(fixedPower.plan.tasks).toHaveLength(3);
    expect(fixedPower.plan.tasks[0]).toBe(power);
    expect(fixedPower.plan.tasks[1].maps_query).toEqual({ queries: ['ТЭЦ', 'ГРЭС'], geo: 'Санкт-Петербург' });
    expect(fixedPower.plan.tasks[2].hh_query).toEqual({ ...chemicalHh.hh_query,
      text: '(инженер-химик OR лаборант химического анализа OR химик лаборатории) AND (ТЭЦ OR ГРЭС OR АЭС OR электростанция)' });
    expect(JSON.stringify(oldPowerPlan)).toBe(powerBefore);
    expect(normalizeVeGenerationSourcePlan(fixedPower.plan, powerScope)).toEqual({ plan: fixedPower.plan, changed: false });
    for (const scope of [{ ...powerScope, market: 'us' }, { ...powerScope, hypotheses: [] },
      { ...powerScope, hypotheses: [...powerScope.hypotheses, ...powerScope.hypotheses] },
      ...[true, undefined, null].map((broad) => ({ ...powerScope,
        hypotheses: [{ ...powerScope.hypotheses[0], broad }] })),
      ...['ТЭЦ, ГРЭС и водоканалы с химлабораториями воды и топлива.',
        'ТЭЦ и агрохолдинги с химлабораториями воды и топлива.',
        'ТЭЦ с химлабораториями воды. А также энергетические подрядчики.',
        'АЭС-смежные с химлабораториями воды.'].map((description) => ({ ...powerScope,
        hypotheses: [{ ...powerScope.hypotheses[0], description }] }))]) {
      expect(normalizeVeGenerationSourcePlan(oldPowerPlan, scope)).toEqual({ plan: oldPowerPlan, changed: false });
    }
    for (const text of ['инженер-химик OR лаборант Москва', '"инженер-химик" OR лаборант',
      'инженер-химик AND (ТЭЦ OR АЭС)', 'инженер-химик NOT фармацевтика', 'NAME:химик OR лаборант',
      'инженер-химик ТЭЦ OR лаборант химического анализа ГРЭС']) {
      const unknown = { ...chemicalHh, hh_query: { ...chemicalHh.hh_query!, text } };
      expect(normalizeVeGenerationSourcePlan({ tasks: [power, unknown] }, powerScope).plan.tasks[1]).toBe(unknown);
    }
    const geoQuery = { ...mixedPowerMaps, maps_query: { queries: ['ТЭЦ в Санкт-Петербурге', 'водоканал в Москве'], geo: 'Россия' } };
    expect(normalizeVeGenerationSourcePlan({ tasks: [power, geoQuery] }, powerScope)).toEqual({ plan: { tasks: [power, geoQuery] }, changed: false });
    const onlyWater = { tasks: [water] };
    expect(normalizeVeGenerationSourcePlan(onlyWater, powerScope)).toEqual({ plan: onlyWater, changed: false });
    const mixedCodes = directory({ ...power.directory_filters, okvedCodes: ['35.1', '35.3', '36.00', '37.00'] });
    expect(normalizeVeGenerationSourcePlan({ tasks: [power, mixedCodes] }, powerScope).plan.tasks).toEqual([power]);
    // A saved plan is read-only context when opening its already budgeted
    // second queue: a new water slice must not reopen the wrong audience.
    const wideningScope = { ...powerScope, existingTasks: oldPowerPlan.tasks };
    const newWater = veSecondQueueTask(water, false)!;
    const newPower = veSecondQueueTask(power, false)!;
    expect(normalizeVeGenerationSourcePlan({ tasks: [newWater] }, wideningScope))
      .toEqual({ plan: { tasks: [] }, changed: true });
    expect(normalizeVeGenerationSourcePlan({ tasks: [newWater, newPower] }, wideningScope))
      .toEqual({ plan: { tasks: [newPower] }, changed: true });
    expect(normalizeVeGenerationSourcePlan({ tasks: [power] }, wideningScope))
      .toEqual({ plan: { tasks: [] }, changed: true });
    expect(JSON.stringify(oldPowerPlan)).toBe(powerBefore);
    const newPowerPlan = { tasks: [newPower] };
    expect(normalizeVeGenerationSourcePlan(newPowerPlan, wideningScope)).toEqual({ plan: newPowerPlan, changed: false });
    const unknownHh = { ...chemicalHh, hh_query: { ...chemicalHh.hh_query!, text: 'инженер AND (ТЭЦ OR АЭС)' } };
    const reorderOnly = normalizeVeGenerationSourcePlan({ tasks: [unknownHh, power] }, powerScope);
    expect(reorderOnly).toEqual({ plan: { tasks: [power, unknownHh] }, changed: true });
    expect(normalizeVeGenerationSourcePlan(reorderOnly.plan, powerScope)).toEqual({ plan: reorderOnly.plan, changed: false });

    // TypeType's narrow audiences previously inherited cinema/concert rubrics
    // and all-sector designers from their parent media vertical.
    for (const [title, description, profile, query, wrongQueries] of [
      ['Игры и анимация', 'Игровые издатели, анимационные студии и владельцы IP с титрами, UI, мерчем и промо. Шрифт помогает создать узнаваемый мир и локализовать кириллицу.',
        'games_animation', 'анимация', ['игровая студия', 'анимационная студия', 'кинотеатр', 'медиа-компания']],
      ['Стриминги и ТВ', 'Онлайн-кинотеатры, телеканалы и видеоплатформы с большим объемом промо, титров, постеров и интерфейсов. Нужна узнаваемая экранная типографика.',
        'streaming_tv', 'телекомпания', ['телестудия', 'кинотеатр', 'продюсерский центр', 'концертный зал', 'продакшн-студия']],
    ] as const) {
      const hypothesis = { title, description, broad: false };
      expect(detectVeMediaSourceProfile({ market: 'ru', hypotheses: [hypothesis] })).toBe(profile);
      for (const scope of [{ market: 'us', hypotheses: [hypothesis] }, { market: 'ru', hypotheses: [] },
        { market: 'ru', hypotheses: [hypothesis, hypothesis] },
        ...[true, null, undefined].map((broad) => ({ market: 'ru', hypotheses: [{ ...hypothesis, broad }] })),
        { market: 'ru', hypotheses: [{ ...hypothesis, title: `${title} и музеи` }] },
        { market: 'ru', hypotheses: [{ ...hypothesis, description: 'Телеканалы и офлайн-кинотеатры с собственным брендом.' }] },
        { market: 'ru', hypotheses: [{ ...hypothesis, description: `${description} Также музеи.` }] },
        ...['Онлайн-кинотеатры с собственным контентом и офлайн-кинотеатры.',
          'Игровые издатели с собственными IP и музеи.',
          'Онлайн-кинотеатры с большим объемом промо, титров, постеров и интерфейсов (а также офлайн-кинотеатры).',
          'Игровые издатели с титрами, UI, мерчем и промо; а также музеи.',
          'Телеканалы. Нужна узнаваемая экранная типографика; также офлайн-кинотеатры.',
        ].map((description) => ({ market: 'ru', hypotheses: [{ ...hypothesis, description }] }))]) {
        expect(detectVeMediaSourceProfile(scope)).toBeNull();
      }
      const mediaRegistry = directory({ okvedCodes: ['58', '59', '62', '63'], regionCodes: ['78'], revenueFrom: 25_000_000, employeesTo: 300 });
      const mediaHh: VeCollectTask = { source: 'hh_live', rationale: 'Дизайнеры', hh_query: {
        text: 'дизайнер OR бренд-дизайнер OR креативный директор', area: '2', date_from: '2026-09-01', date_to: '2026-09-30',
      } };
      const mediaMaps: VeCollectTask = { source: 'yandex_maps', rationale: 'Каталог',
        maps_query: { queries: [...wrongQueries], geo: 'Санкт-Петербург' } };
      const mediaPlan = { tasks: [mediaHh, mediaRegistry, mediaMaps, { ...mediaMaps, rationale: 'Повтор того же среза' }] };
      const before = JSON.stringify(mediaPlan);
      const media = normalizeVeMediaSourcePlan(mediaPlan, profile);
      expect(media.changed).toBe(true);
      expect(media.plan.tasks).toHaveLength(3);
      expect(media.plan.tasks[0].maps_query).toEqual({ queries: [profile === 'games_animation' ? 'анимационная студия' : query], geo: 'Санкт-Петербург' });
      expect(isVeMediaCatalogTask(media.plan.tasks[0], profile)).toBe(true);
      expect(media.plan.tasks[1]).toBe(mediaRegistry);
      expect(media.plan.tasks[2].hh_query).toEqual({ ...mediaHh.hh_query,
        text: profile === 'games_animation'
          ? 'геймдев OR "разработка игр" OR "издатель игр" OR "анимационная студия" OR мультипликация'
          : '"онлайн-кинотеатр" OR телеканал OR видеоплатформа OR телевещание' });
      expect(JSON.stringify(mediaPlan)).toBe(before);
      expect(normalizeVeMediaSourcePlan(media.plan, profile)).toEqual({ plan: media.plan, changed: false });
      for (const text of ['дизайнер Москва', 'дизайнер AND телеканал', '"игровая студия" OR анимация', 'дизайнер NOT казино']) {
        const constrained = { ...mediaHh, hh_query: { ...mediaHh.hh_query!, text } };
        expect(normalizeVeMediaSourcePlan({ tasks: [constrained] }, profile)).toEqual({ plan: { tasks: [constrained] }, changed: false });
      }
      const geographic = { ...mediaMaps, maps_query: { queries: [`${query} в Москве`], geo: 'Россия' } };
      expect(normalizeVeMediaSourcePlan({ tasks: [geographic] }, profile)).toEqual({ plan: { tasks: [geographic] }, changed: false });
      const precise = { ...mediaMaps, maps_query: { queries: profile === 'games_animation'
        ? ['студия разработки игр', 'анимация', 'мультипликация'] : ['видеоплатформа', 'онлайн-кинотеатр'], geo: 'Санкт-Петербург' } };
      expect(normalizeVeMediaSourcePlan({ tasks: [precise] }, profile)).toEqual({ plan: { tasks: [precise] }, changed: false });
      const generic = { ...mediaMaps, maps_query: { queries: ['кинотеатр'], geo: 'Санкт-Петербург' } };
      expect(normalizeVeMediaSourcePlan({ tasks: [generic] }, profile).plan.tasks[0].maps_query)
        .toEqual({ queries: [query], geo: 'Санкт-Петербург' });
      for (const label of ['Кинотеатры', 'Концертные залы', 'Студии звукозаписи', 'Казино', 'Компьютерные клубы', 'Аниматоры', 'Рекламные агентства']) {
        expect(veMediaRubricAllowed(profile, label)).toBe(false);
      }
    }
    for (const title of ['Медиа и развлечения', 'Дизайн для телеканалов', 'Маркетинг для игровых студий']) {
      expect(detectVeMediaSourceProfile({ market: 'ru', hypotheses: [{ title, broad: false }] })).toBeNull();
    }
    expect(veMediaRubricAllowed('games_animation', 'Анимация')).toBe(true);
    expect(veMediaRubricAllowed('games_animation', 'Разработка компьютерных игр')).toBe(true);
    expect(veMediaRubricAllowed('streaming_tv', 'Телекомпании')).toBe(true);
    expect(veMediaRubricAllowed('streaming_tv', 'Онлайн-кинотеатры')).toBe(true);

    // Event&Marketing saved plan shapes, replayed as fresh plans: prefer the
    // specialty catalog without touching explicit size, geo or paid HH scope.
    for (const [title, profile] of [['Пластическая хирургия', 'plastic_surgery'],
      ['Остеопатические клиники', 'osteopathy'], ['Стоматологии 3+ кресла', 'dental']] as const) {
      expect(detectVeClinicSourceProfile([{ title }])).toBe(profile);
      expect(detectVeClinicSourceProfile([{ title, broad: true }])).toBeNull();
    }
    for (const title of ['Маркетинг для стоматологий', 'Поставщики стоматологического оборудования',
      'Клиники пластической хирургии и косметологии', 'Остеопатические и стоматологические клиники', 'Стоматологи России',
      'Частные остеопаты', 'Рекламные агентства для стоматологий', 'Сервисы для стоматологий',
      'Стоматологии и медицинские центры', 'Клиники пластической хирургии и кардиологии',
      'Медицинские центры кроме стоматологий', 'Клиники без пластической хирургии']) {
      expect(detectVeClinicSourceProfile([{ title }])).toBeNull();
    }
    expect(detectVeClinicSourceProfile([{ title: 'Медицинские центры', description: 'Помогаем продвигать пластическую хирургию' }])).toBeNull();
    expect(detectVeClinicSourceProfile([{ title: 'Пластическая хирургия' }, { title: 'Остеопатические клиники' }])).toBeNull();
    expect(detectVeClinicSourceProfile([{ title: 'Центры остеопатии и мануальной терапии' }])).toBe('osteopathy');
    expect(detectVeClinicSourceProfile([{ title: 'Стоматологии с несколькими врачами и креслами' }])).toBe('dental');
    const registry = directory({ okvedCodes: ['86'], regionCodes: ['78'], employeesFrom: 5, revenueFrom: 10_000_000 });
    const mixedCatalog: VeCollectTask = { source: 'yandex_maps', rationale: 'Специальности', maps_query: {
      queries: ['пластическая хирургия', 'косметология', 'дерматология', 'трихология'], geo: 'Санкт-Петербург' } };
    const genericCatalog: VeCollectTask = { source: 'yandex_maps', rationale: 'Медцентры',
      maps_query: { queries: ['медицинский центр'], geo: 'Санкт-Петербург' } };
    const hiring: VeCollectTask = { source: 'hh_live', rationale: 'Найм по условию гипотезы',
      hh_query: { text: 'остеопат', area: '2', date_from: '2026-09-01' } };
    const original = { tasks: [registry, mixedCatalog, genericCatalog, hiring] };
    const snapshot = JSON.stringify(original);
    expect(isVeClinicCatalogTask(mixedCatalog, 'plastic_surgery')).toBe(false);
    const clinic = normalizeVeClinicSourcePlan(original, 'plastic_surgery');
    expect(clinic.changed).toBe(true);
    expect(clinic.plan.tasks).toHaveLength(original.tasks.length);
    expect(clinic.plan.tasks[0].maps_query).toEqual({ queries: ['пластическая хирургия'], geo: 'Санкт-Петербург' });
    expect(clinic.plan.tasks.slice(1)).toEqual([registry, genericCatalog, hiring]);
    expect(clinic.plan.tasks[1]).toBe(registry);
    expect(clinic.plan.tasks[3]).toBe(hiring);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(normalizeVeClinicSourcePlan(clinic.plan, 'plastic_surgery')).toEqual({ plan: clinic.plan, changed: false });
    for (const query of ['косметология', 'дерматология', 'медицинский центр', 'пластическая хирургия и косметология',
      'пластическая хирургия и кардиология', 'медицинские центры без пластической хирургии']) {
      expect(veClinicRubricAllowed('plastic_surgery', query)).toBe(false);
    }
    const osteo = normalizeVeClinicSourcePlan({ tasks: [registry, genericCatalog, hiring] }, 'osteopathy');
    expect(osteo.plan.tasks[0].maps_query).toEqual({ queries: ['остеопатия'], geo: 'Санкт-Петербург' });
    expect(osteo.plan.tasks.slice(1)).toEqual([registry, hiring]);
    const dentalCatalog: VeCollectTask = { ...genericCatalog, maps_query: {
      queries: ['стоматология', 'имплантация зубов', 'стоматологическая клиника'], geo: 'Россия' } };
    expect(isVeClinicCatalogTask(dentalCatalog, 'dental')).toBe(true);
    expect(normalizeVeClinicSourcePlan({ tasks: [registry, dentalCatalog] }, 'dental').plan.tasks).toEqual([dentalCatalog, registry]);
    const scoped = { tasks: [{ ...genericCatalog, maps_query: { queries: ['медицинский центр в Москве'] } }] };
    expect(normalizeVeClinicSourcePlan(scoped, 'osteopathy')).toEqual({ plan: scoped, changed: false });
    expect(normalizeVeClinicSourcePlan({ tasks: [registry, hiring] }, 'dental').changed).toBe(false);
    const exactCatalog = { ...mixedCatalog, maps_query: { ...mixedCatalog.maps_query!, queries: ['пластическая хирургия'] } };
    const secondMixed = { ...mixedCatalog, maps_query: { ...mixedCatalog.maps_query!, queries: ['дерматология', 'пластическая хирургия'] } };
    for (const tasks of [[mixedCatalog, exactCatalog], [mixedCatalog, secondMixed]]) {
      const normalized = normalizeVeClinicSourcePlan({ tasks }, 'plastic_surgery').plan;
      expect(new Set(normalized.tasks.map(veSourceStrategyKey)).size).toBe(tasks.length);
      expect(normalized.tasks.filter((task) => isVeClinicCatalogTask(task, 'plastic_surgery'))).toHaveLength(1);
      expect(normalizeVeClinicSourcePlan(normalized, 'plastic_surgery').changed).toBe(false);
    }
    const otherCity = { ...mixedCatalog, maps_query: { ...mixedCatalog.maps_query!, geo: 'Москва' } };
    expect(normalizeVeClinicSourcePlan({ tasks: [exactCatalog, otherCity] }, 'plastic_surgery').plan.tasks
      .filter((task) => isVeClinicCatalogTask(task, 'plastic_surgery'))).toHaveLength(2);
  });
});

describe('вторая очередь исчерпанного реестра', () => {
  it('без основания в гипотезе — тот же ОКВЭД без порогов', () => {
    expect(veSecondQueueTask(MEAT_TASK, false)).toMatchObject({ source: 'companies_directory', widened: 'second_queue',
      directory_filters: { includeIp: false, okvedCodes: ['10.1'] } });
    expect(veSecondQueueTask(MEAT_TASK, false)?.directory_filters).not.toHaveProperty('revenueFrom');
  });

  it('с основанием — порог ослаблен вдвое, пустой штат и выручка проходят', () => {
    expect(veSecondQueueTask(SWEETS_TASK, true)?.directory_filters).toEqual({ includeIp: false, okvedCodes: ['10.7', '10.8'],
      sizeOrUnknown: { revenueFrom: 150_000_000, employeesFrom: 25 } });
    // «3–30 агентов»: нижняя граница в 1 человека уже не граница, верхние — вдвое шире.
    expect(veSecondQueueTask(AGENCIES_TASK, true)?.directory_filters).toEqual({ okvedCodes: ['68.3'],
      sizeOrUnknown: { employeesTo: 100, revenueTo: 600_000_000 } });
    const keep = veDirectorySizeKeep({ revenueFrom: 150_000_000, employeesFrom: 25 })!;
    expect(keep({ employees_count: null, revenue: null })).toBe(true);
    expect(keep({ employees_count: 30, revenue: '200000000' })).toBe(true);
    expect(keep({ employees_count: 10, revenue: 400_000_000 })).toBe(false);
    expect(keep({ employees_count: 100, revenue: 50_000_000 })).toBe(false);
  });

  it('вторая очередь открывается один раз и не порождает третью', () => {
    const second = veSecondQueueTask(SWEETS_TASK, true)!;
    expect(veSecondQueueTask(second, true)).toBeNull();
    expect(veSecondQueueTasks([SWEETS_TASK, second], true)).toEqual([]);
    expect(veSecondQueueTasks([directory({ okvedCodes: ['10.1'] })], false)).toEqual([]);
  });

  it('исчерпанная база с порогом продолжаема через «Продолжить подготовку»', () => {
    // Прод 6b475d8c: analyzed, 52 из 500, реестр с порогами исчерпан, резерва нет.
    const base = { id: '6b475d8c', source: 'auto', status: 'analyzed', hypothesis_id: 'h1', collect_info: {
      collection_mode: 'preview', plan: { tasks: [SWEETS_TASK] },
      tasks: [{ source: 'companies_directory', status: 'done', exhausted: true, note: 'реестр исчерпан', rows: 1125, task: SWEETS_TASK }],
      adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2 },
      target_progress: { mode: 'preview', status: 'limited', ready_rows: 52, ready_target: 500, round: 11, max_rounds: 100,
        max_candidates: 10_000, candidates_processed: 1177, reason: 'Добор сайтов закрыт: последние 120 платных поисков не дали ни одного готового контакта' },
      target_checkpoint: { completed_round: 11 } } };
    expect(canResumePartialPreview(base)).toBe(true);
    // Вторая очередь уже открыта и пройдена, перепланирование израсходовано — нечего продолжать.
    const widened = structuredClone(base);
    widened.collect_info.tasks.push({ source: 'companies_directory', status: 'done', exhausted: true, note: 'реестр исчерпан',
      rows: 10, task: veSecondQueueTask(SWEETS_TASK, true)! });
    expect(canResumePartialPreview(widened)).toBe(false);
    expect(veCanWidenPlan([SWEETS_TASK], { widenings: 2, replan_attempts: 0 })).toBe(false);
    expect(veCanWidenPlan([directory({ okvedCodes: ['10.1'] })], { widenings: 0, replan_attempts: 0 })).toBe(true);
    expect(veCanWidenPlan([directory({ okvedCodes: ['10.1'] })], { widenings: 1, replan_attempts: 2 })).toBe(false);

    const live = { ...base, collect_info: { ...base.collect_info,
      tasks: [{ ...base.collect_info.tasks[0], exhausted: false }],
      adaptive_collection: { ...base.collect_info.adaptive_collection, widenings: 2 } } };
    expect(getVeCollectionContinuation(live)).toMatchObject({ available: true, code: 'sources_available', action: 'resume_collection' });
    const ceiling = { ...live, collect_info: { ...live.collect_info, target_checkpoint: { completed_round: 10_000 },
      target_progress: { ...live.collect_info.target_progress, round: 10_000 } } };
    expect(getVeCollectionContinuation(ceiling)).toMatchObject({ available: false, code: 'round_limit', action: null });
    const capped = { ...live, collect_info: { ...live.collect_info,
      target_progress: { ...live.collect_info.target_progress, candidates_processed: 10_000 } } };
    expect(getVeCollectionContinuation(capped)).toMatchObject({ available: false, code: 'candidate_limit' });
    // Already admitted work is drained even at the acquisition ceiling.
    for (const saved of [{ company_name_recovery: { validation_error: null } },
      { preview_pipeline: { batches: [{ id: 'paid-child' }] } },
      { tasks: [{ ...live.collect_info.tasks[0], status: 'dispatched', child_job_id: 'child' }] }]) {
      expect(getVeCollectionContinuation({ ...ceiling, collect_info: { ...ceiling.collect_info, ...saved } }))
        .toMatchObject({ available: true, code: 'saved_work', action: 'resume_preparation' });
    }
    const key = veSourceStrategyKey(SWEETS_TASK);
    const held = { ...live, collect_info: { ...live.collect_info, adaptive_collection: { ...live.collect_info.adaptive_collection,
      completed: Array.from({ length: 5 }, (_, i) => ({ id: `dry-${i}`, source_key: key, source: 'companies_directory',
        candidates: 100, new_ready: 0, new_target: 0, poor: true, started_at: '', finished_at: '',
        spend: { ai_usd: 0, serper_credits: 0, estimated_total_usd: 0, unknown_attempts: 0, complete: true } })) } } };
    const before = JSON.stringify(held);
    expect(getVeCollectionContinuation(held)).toMatchObject({ available: false, code: 'low_yield' });
    expect(getVeCollectionContinuation(held)).toMatchObject({ available: false, code: 'low_yield' });
    expect(JSON.stringify(held)).toBe(before);
    expect(getVeCollectionContinuation({ ...held, collect_info: { ...held.collect_info,
      adaptive_collection: { replan_attempts: 2, widenings: 2 } } })).toMatchObject({ available: false, code: 'invalid_checkpoint' });
    expect(getVeCollectionContinuation({ ...base, status: 'failed', error: 'Отменено пользователем' }))
      .toMatchObject({ available: true, action: 'resume_preparation' });

    // A deployed correction is new work once, even if the previous scope was exhausted.
    const payments = { ...widened, collect_info: { ...widened.collect_info, niche_source_profile: 'payments',
      source_selection: { version: 1, profile: 'payments' },
      tasks: [{ source: 'companies_directory', status: 'done', exhausted: true,
        task: directory({ okvedCodes: ['62'], nameTerms: ['pay'] }) }],
      adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, widenings: 2 } } };
    expect(getVeCollectionContinuation(payments)).toMatchObject({ available: true, code: 'source_update' });
    payments.collect_info.source_selection.version = 2;
    expect(getVeCollectionContinuation(payments)).toMatchObject({ available: false, code: 'sources_exhausted' });

    // The same frozen audience must decide source correction in preflight and
    // the worker. Legacy titles/profiles cannot advertise an impossible retry.
    for (const audience of [
      { any_of: ['Финтех', 'Платёжные провайдеры'], required: [] },
      { any_of: ['Платёжные провайдеры'], required: ['Выручка до 80 млн рублей'] },
      { any_of: ['Платёжные провайдеры'], required: [] },
    ]) {
      const correctable = audience.any_of.length === 1 && audience.required.length === 0;
      const frozen = { ...payments, collect_info: { ...payments.collect_info,
        source_selection: { version: 1, profile: 'payments' },
        cost_policy: { version: 1, website_discovery: 'existing_only' },
        audience_snapshot: createVeCollectionAudienceSnapshot([{ id: 'h1', status: 'accepted',
          title: 'Финтех и платежное посредничество', origin: 'generated', broad: true,
          audience_scope: { version: 1, kind: 'sector', ...audience, excluded: [] } }], 'new_preview', '2026-10-14T12:00:00Z'),
      } };
      expect(getVeCollectionContinuation(frozen)).toMatchObject(correctable
        ? { available: true, code: 'source_update' } : { available: false, code: 'sources_exhausted' });
      expect(getVeCollectionContinuation({ ...frozen, collect_info: { ...frozen.collect_info,
        company_name_recovery: { validation_error: null } } }))
        .toMatchObject({ available: true, code: 'saved_work', action: 'resume_preparation' });
      expect(getVeCollectionContinuation({ ...frozen, status: 'failed', error: 'Отменено пользователем' }))
        .toMatchObject({ available: true, code: 'recovery_available', action: 'resume_preparation' });
    }

    // A staffing-only saved refusal is useful work even with no remaining
    // source. Current metadata must win over an obsolete generated snapshot.
    const staffingHypothesis = { id: 'h1', title: 'B2B SaaS с remote-командами',
      description: 'SaaS-вендоры из СНГ, Европы, MENA и APAC, нанимающие специалистов в 2+ странах.',
      origin: 'generated', status: 'accepted' };
    const staffingRow = { company: 'Saved SaaS', website: 'https://saas.example', email: 'team@saas.example',
      _email_status: 'ok', _ve_relevance: { version: 2, status: 'needs_review',
        reason: 'Смысловое соответствие не подтверждено: Не подтверждена удалённая команда.',
        context_hash: 'a'.repeat(64), evidence: [{ field: 'description', quote: 'Собственная SaaS-платформа для бизнеса.' }],
        review_attempts: 2, website_review_version: VE_RELEVANCE_WEBSITE_VERSION,
        rules_version: VE_RELEVANCE_RULES_VERSION, triage_version: VE_RELEVANCE_TRIAGE_VERSION } };
    const stoppedSaas = { ...widened, collect_info: { ...widened.collect_info,
      hypotheses: [staffingHypothesis], relevance_reserve: { version: 1, rows: [staffingRow] } } };
    const stoppedBefore = JSON.stringify(stoppedSaas);
    const savedWork = { available: true, code: 'saved_work', action: 'resume_preparation' };
    const noWork = { available: false, code: 'sources_exhausted', action: null };
    expect(getVeCollectionContinuation(stoppedSaas)).toMatchObject(savedWork);
    expect(getVeCollectionContinuation(stoppedSaas, staffingHypothesis)).toMatchObject(savedWork);
    expect(canResumePartialPreview(stoppedSaas, staffingHypothesis)).toBe(true);
    for (const current of [null,
      { ...staffingHypothesis, origin: 'manual' },
      { ...staffingHypothesis, origin: undefined },
      { ...staffingHypothesis, status: 'rejected' },
      { ...staffingHypothesis, id: 'another-hypothesis' },
      { ...staffingHypothesis, title: 'Разработчики заказного ПО' },
      { ...staffingHypothesis, description: staffingHypothesis.description + ' Обязательно наличие удалённой команды.' },
    ]) {
      expect(getVeCollectionContinuation(stoppedSaas, current)).toMatchObject(noWork);
      expect(canResumePartialPreview(stoppedSaas, current)).toBe(false);
    }
    for (const hypotheses of [[], [staffingHypothesis, staffingHypothesis],
      [{ ...staffingHypothesis, id: 'another-hypothesis' }],
      [{ title: staffingHypothesis.title }], [{ ...staffingHypothesis, origin: 'manual' }],
    ]) {
      const legacy = { ...stoppedSaas, collect_info: { ...stoppedSaas.collect_info, hypotheses } };
      expect(getVeCollectionContinuation(legacy)).toMatchObject(noWork);
      expect(getVeCollectionContinuation(legacy, staffingHypothesis)).toMatchObject(savedWork);
    }
    // Only unfinished correction is selectable. Other failed requirements and
    // unusable addresses cannot open a new paid pass through this exception.
    for (const row of [
      { ...staffingRow, _email_status: 'invalid' },
      { ...staffingRow, _ve_relevance: { ...staffingRow._ve_relevance,
        staffing_correction_version: VE_STAFFING_CORRECTION_VERSION } },
      { ...staffingRow, _ve_relevance: { ...staffingRow._ve_relevance,
        reason: 'Не подтверждена удалённая команда. Не подтверждён собственный SaaS-продукт.' } },
    ]) {
      expect(getVeCollectionContinuation({ ...stoppedSaas, collect_info: { ...stoppedSaas.collect_info,
        relevance_reserve: { version: 1, rows: [row] } } })).toMatchObject(noWork);
    }
    const cappedSaas = { ...stoppedSaas, collect_info: { ...stoppedSaas.collect_info,
      target_progress: { ...stoppedSaas.collect_info.target_progress, candidates_processed: 10_000 } } };
    expect(getVeCollectionContinuation(cappedSaas)).toMatchObject(savedWork);
    expect(getVeCollectionContinuation(cappedSaas, null)).toMatchObject({ available: false, code: 'candidate_limit' });
    expect(JSON.stringify(stoppedSaas)).toBe(stoppedBefore);
  });
});

describe('выход партий адаптивного сбора', () => {
  const spend: VeBatchSpend = { ai_usd: 0, serper_credits: 0, estimated_total_usd: 0, unknown_attempts: 0, complete: true };

  it('старые адреса сверх лимита на компанию не считаются новыми контактами партии', () => {
    // f1bb9ccf: «Партия проверена: 5 новых готовых контактов из 1 компаний» — все
    // пять были старыми адресами, отложенными лимитом адресов на компанию.
    const ready = [{ company: 'Мясокомбинат Восток', inn: '7700000001', email: 'director@vostok.test', _email_status: 'ok' }];
    const overCap = ['sales', 'buh', 'hr', 'office', 'zakupki'].map((box) => ({ company: 'Мясокомбинат Восток', inn: '7700000001',
      email: `${box}@vostok.test`, _email_status: 'ok', _ve_company_cap: { limit: 1 } }));
    const info: VeCollectInfo = { adaptive_collection: newVeAdaptiveCollection(),
      relevance_reserve: { version: 1, rows: overCap } };
    const base = { id: 'f1bb9ccf', data: ready, columns: ['company', 'inn', 'email'] } as unknown as Parameters<typeof beginAdaptiveBatch>[0];
    beginAdaptiveBatch(base, info, 'batch-1', [{ company: 'Колбасный цех Север' } as never]);
    const finished = finishVeAdaptiveBatch(info.adaptive_collection!, [...ready, ...overCap], spend);
    expect(finished.completed.at(-1)?.new_ready).toBe(0);
  });

  it('хвост узкого среза мелкими партиями тоже признаётся низким выходом', () => {
    // 9f82e79d: «0 новых готовых контактов из 11 компаний» партия за партией.
    let state: VeAdaptiveCollection = { ...newVeAdaptiveCollection(), active_source: 'tail' };
    const needs: boolean[] = [];
    for (let index = 0; index < 10; index++) {
      state = finishVeAdaptiveBatch({ ...state, pending: { id: `tail-${index}`, source_key: 'tail', source: 'companies_directory',
        candidates: 11, ready_before: veReadyContactKeys([]), started_at: new Date().toISOString() } }, [], spend);
      needs.push(state.replan_needed === true);
    }
    // Первые 55 компаний — одно окно, вторые 55 — второе: сигнал на десятой партии.
    expect(needs).toEqual([false, false, false, false, false, false, false, false, false, true]);
    expect(state.completed.filter((batch) => batch.poor)).toHaveLength(6);

    // Одна продуктивная мелкая партия внутри окна не даёт окну стать плохим.
    let mixed: VeAdaptiveCollection = { ...newVeAdaptiveCollection(), active_source: 'mixed' };
    for (let index = 0; index < 10; index++) {
      const found = index === 7 ? Array.from({ length: 5 }, (_, n) => ({ email: `lead${n}@found.test` })) : [];
      mixed = finishVeAdaptiveBatch({ ...mixed, pending: { id: `mixed-${index}`, source_key: 'mixed', source: 'companies_directory',
        candidates: 11, ready_before: veReadyContactKeys([]), started_at: new Date().toISOString() } }, found, spend);
    }
    expect(mixed.replan_needed).toBe(false);
    expect(veSourceStrategyKey(MEAT_TASK)).not.toBe(veSourceStrategyKey(veSecondQueueTask(MEAT_TASK, false)!));
  });
});
