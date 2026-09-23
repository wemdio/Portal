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
import { canResumePartialPreview } from '@/lib/verticalEngineV2/collectionRecovery';
import type { VeCollectTask } from '@/lib/verticalEngineV2/prompts/sourcePlan';

const HYPOTHESES = {
  meat: 'Мясопереработка\nПроизводители колбас, мясных полуфабрикатов, охлажденного мяса и деликатесов с Меркурием и сложной прослеживаемостью партий.',
  energy: 'Энергетические компании\nЭнергосбыт, сервисные и электросетевые компании, которым нужны инженеры РЗА, энергетики, диспетчеры и руководители эксплуатации.',
  horeca: 'Поставщики HoReCa\nДистрибьюторы продуктов, оборудования и расходников для ресторанов/отелей с региональными продажами и сервисом.',
  sweets: 'Кондитерские фабрики\nКрупные производители конфет, шоколада, печенья и снеков с рецептурами, сменами, складами сырья и поставками в федеральные сети.',
  agencies: 'Малые агентства недвижимости\nАгентства 3–30 агентов, продающие вторичку и новостройки в регионах, которым нужен единый источник объектов и комиссий.',
  dentists: 'Стоматологии 3+ кресла\nЧастные стоматологии с лицензией, несколькими врачами и чеком на терапию, ортопедию, имплантацию.',
  transport: 'Транспортные холдинги\nКрупные автотранспортные, ЖД- и мультимодальные группы с филиалами, ремонтом, складами, договорами и учетными системами.',
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
