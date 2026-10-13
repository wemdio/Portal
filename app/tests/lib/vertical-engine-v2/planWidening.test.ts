/** @jest-environment node */

/**
 * План кончился раньше цели. Аудит 22.09.2026: 33 базы встали на исчерпанном
 * срезе, хотя рынок гипотезы шире, и ни одна не сменила срез сама
 * (replan_attempts=0 у всех). Тексты гипотез и фильтры — с прода.
 */
import { beginAdaptiveBatch, type VeCollectInfo } from '@/lib/verticalEngineV2/stages/baseCollect';
import { finishVeAdaptiveBatch, newVeAdaptiveCollection, veReadyContactKeys, veSourceStrategyKey,
  type VeAdaptiveCollection, type VeBatchSpend } from '@/lib/verticalEngineV2/adaptiveCollection';
import { stripUnfoundedSizeFilters, veCanWidenPlan, veDirectorySizeKeep, veHypothesisSizeBasis, veSecondQueueTask,
  veSecondQueueTasks } from '@/lib/verticalEngineV2/planWidening';
import { canResumePartialPreview, getVeCollectionContinuation } from '@/lib/verticalEngineV2/collectionRecovery';
import { detectVeClinicSourceProfile, isVeClinicCatalogTask, normalizeVeClinicSourcePlan, veClinicRubricAllowed } from '@/lib/verticalEngineV2/clinicSourcePolicy';
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
