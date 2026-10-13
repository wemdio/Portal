/**
 * Автоматическое расширение среза, когда план кончился раньше цели.
 *
 * Аудит 22.09.2026: 33 базы встали, выбрав источники плана до дна, хотя рынок
 * гипотезы шире. Главная причина — пороги выручки и штата, которые придумал
 * планировщик (у 208 из 260 авто-баз 26.08–18.09). Мясопереработка, ОКВЭД 10.1:
 * с порогами 954 компании, без них 3 389; в тексте гипотезы о размере ни слова.
 * Порог к тому же отсекает компании с пустым штатом или выручкой (в 56.1 штат
 * не заполнен у 42 %).
 *
 * Правило. Порог без основания в тексте гипотезы снимается: у нового плана —
 * при сохранении, у старого — при расширении. Обоснованный порог («Крупные
 * производители», «Агентства 3–30 агентов») — первая очередь, а не забор:
 * вторая очередь берёт тот же ОКВЭД и регион с порогом, ослабленным вдвое, и
 * компании без данных о штате и выручке. Мелочь, которая при этом попадёт,
 * отсеет проверка релевантности; убрать порог совсем значило бы платить за
 * чтение сайтов заведомо мелких компаний под «крупную» гипотезу.
 */
import { veSourceStrategyKey, type VeAdaptiveCollection } from './adaptiveCollection';
import type { VeCollectTask, VeSourcePlan } from './prompts/sourcePlan';

/** Не больше двух автоматических расширений на базу: вторая очередь и новый срез. */
export const VE_PLAN_WIDENING_LIMIT = 2;
/** Потолок задач плана при перепланировании (как в подборе альтернативы). */
export const VE_PLAN_MAX_TASKS = 6;
export const VE_SIZE_FILTER_KEYS = ['revenueFrom', 'revenueTo', 'employeesFrom', 'employeesTo'] as const;
export type VeDirectorySizeBounds = Partial<Record<(typeof VE_SIZE_FILTER_KEYS)[number], number>>;

const LETTER = 'а-яёa-z';
const SIZE_BASIS: RegExp[] = [
  /крупн|небольш|микро(бизнес|предприят|компани)|масштабн|холдинг/i,
  new RegExp(`(?<![${LETTER}])мал(ый|ого|ому|ым|ом|ая|ой|ую|ые|ых|ым|ыми)(?![${LETTER}])`, 'i'),
  /средн(ий|его|ие|их|ее|яя|ей)\s+(и\s+)?(бизнес|компани|предприят|производ|сегмент|размер|крупн)/i,
  new RegExp(`(?<![${LETTER}])(мсп|smb|enterprise)(?![${LETTER}])`, 'i'),
  /групп[аыу]\s+компаний/i,
  new RegExp(`(?<![${LETTER}])сет(ь|и|ей|ям|ями|ях)(?![${LETTER}])`, 'i'),
  new RegExp(`численност|(?<![${LETTER}])штат(ом|а|е|ов)?(?![${LETTER}])`, 'i'),
  new RegExp(`выручк|(?<![${LETTER}])оборот(?!н)|млрд|\\d\\s*млн`, 'i'),
  /\d\s*\+/,
  new RegExp(`(?<![${LETTER}])(от|более|свыше|больше|не менее)\\s+\\d`, 'i'),
  /\d[\d\s]*([–—-]\s*\d+\s*)?(сотрудник|работник|человек|агент|врач|кресел|кресла|филиал|точ[еки]|магазин|отделени|автомобил|машин)/i,
  new RegExp(`(?<![${LETTER}])гок(и|ов|ам|а)?(?![${LETTER}])|горно-?обогатит`, 'i'),
];

/** Размер компании назван в тексте гипотезы (заголовок + описание). */
export function veHypothesisSizeBasis(text: string): boolean {
  // «Продвижение в социальных сетях» — не сеть компаний.
  const clean = String(text ?? '').replace(/соц\S*\s+сет\S*|соцсет\S*/gi, ' ');
  return SIZE_BASIS.some((pattern) => pattern.test(clean));
}

function sizeBounds(filters: VeCollectTask['directory_filters']): VeDirectorySizeBounds {
  const bounds: VeDirectorySizeBounds = {};
  for (const key of VE_SIZE_FILTER_KEYS) {
    const value = filters?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) bounds[key] = value;
  }
  return bounds;
}
function withoutSize(filters: NonNullable<VeCollectTask['directory_filters']>): NonNullable<VeCollectTask['directory_filters']> {
  const rest = { ...filters };
  for (const key of VE_SIZE_FILTER_KEYS) delete rest[key];
  delete rest.sizeOrUnknown;
  return rest;
}
/** Без ОКВЭД и региона снятие порога превратило бы срез в весь реестр. */
const scoped = (filters: VeCollectTask['directory_filters']) => Boolean(filters?.okvedCodes?.length || filters?.regionCodes?.length);

/** Пороги размера без основания в гипотезе не сохраняются в плане. */
export function stripUnfoundedSizeFilters(plan: VeSourcePlan, hypothesisText: string): { plan: VeSourcePlan; stripped: number } {
  if (veHypothesisSizeBasis(hypothesisText)) return { plan, stripped: 0 };
  let stripped = 0;
  const tasks = plan.tasks.map((task) => {
    if (task.source !== 'companies_directory' || !task.directory_filters || !scoped(task.directory_filters)
      || !Object.keys(sizeBounds(task.directory_filters)).length) return task;
    stripped += 1;
    return { ...task, directory_filters: withoutSize(task.directory_filters) };
  });
  return { plan: stripped ? { ...plan, tasks } : plan, stripped };
}

/** Прежний план для подсказки планировщику: пороги размера ему не образец. */
export function veTaskWithoutSizeFilters(task: VeCollectTask): VeCollectTask {
  return task.source === 'companies_directory' && task.directory_filters
    ? { ...task, directory_filters: withoutSize(task.directory_filters) } : task;
}

/**
 * Вторая очередь реестровой задачи с порогом размера: тот же ОКВЭД и регион.
 * Без основания в гипотезе порогов нет вовсе; с основанием нижняя граница
 * делится на два (штат до 1 человека — уже не граница), верхняя удваивается,
 * а компании с пустым полем проходят.
 */
export function veSecondQueueTask(task: VeCollectTask, sizeBasis: boolean): VeCollectTask | null {
  const filters = task.directory_filters;
  if (task.source !== 'companies_directory' || !filters || filters.sizeOrUnknown || !scoped(filters)) return null;
  const bounds = sizeBounds(filters);
  if (!Object.keys(bounds).length) return null;
  const rest = withoutSize(filters);
  if (!sizeBasis) return { ...task, widened: 'second_queue', directory_filters: rest,
    rationale: `${task.rationale} Вторая очередь: тот же ОКВЭД и регион без порогов выручки и штата.` };
  const relaxed: VeDirectorySizeBounds = {};
  if (bounds.employeesFrom !== undefined && Math.floor(bounds.employeesFrom / 2) > 1) relaxed.employeesFrom = Math.floor(bounds.employeesFrom / 2);
  if (bounds.revenueFrom !== undefined && Math.floor(bounds.revenueFrom / 2) > 0) relaxed.revenueFrom = Math.floor(bounds.revenueFrom / 2);
  if (bounds.employeesTo !== undefined) relaxed.employeesTo = bounds.employeesTo * 2;
  if (bounds.revenueTo !== undefined) relaxed.revenueTo = bounds.revenueTo * 2;
  return { ...task, widened: 'second_queue',
    directory_filters: { ...rest, ...(Object.keys(relaxed).length ? { sizeOrUnknown: relaxed } : {}) },
    rationale: `${task.rationale} Вторая очередь: пороги размера ослаблены вдвое, компании без данных о штате и выручке тоже берём.` };
}

/** Строка реестра проходит ослабленный порог, если поле пустое или в границах. */
export function veDirectorySizeKeep(bounds: VeDirectorySizeBounds | undefined): ((row: Record<string, unknown>) => boolean) | undefined {
  if (!bounds || !Object.keys(bounds).length) return undefined;
  const within = (value: unknown, from?: number, to?: number) => {
    if (value === null || value === undefined || String(value).trim() === '') return true;
    const number = Number(value);
    if (!Number.isFinite(number)) return true;
    return (from === undefined || number >= from) && (to === undefined || number <= to);
  };
  return (row) => within(row.employees_count, bounds.employeesFrom, bounds.employeesTo)
    && within(row.revenue, bounds.revenueFrom, bounds.revenueTo);
}

/** Новые задачи второй очереди, которых ещё нет в плане. */
export function veSecondQueueTasks(tasks: VeCollectTask[], sizeBasis: boolean): VeCollectTask[] {
  const known = new Set(tasks.map(veSourceStrategyKey));
  const added: VeCollectTask[] = [];
  for (const task of tasks) {
    const next = veSecondQueueTask(task, sizeBasis);
    if (!next || known.has(veSourceStrategyKey(next))) continue;
    known.add(veSourceStrategyKey(next));
    added.push(next);
  }
  return added;
}

/**
 * Может ли база с исчерпанным планом расшириться сама. Основание гипотезы здесь
 * неизвестно, поэтому задача с порогом считается нерасширенной, пока в плане
 * нет ни одного из двух её вариантов второй очереди.
 */
export function veCanWidenPlan(tasks: VeCollectTask[], policy: Pick<VeAdaptiveCollection, 'widenings' | 'replan_attempts'> | undefined): boolean {
  if (!tasks.length || (policy?.widenings ?? 0) >= VE_PLAN_WIDENING_LIMIT) return false;
  const known = new Set(tasks.map(veSourceStrategyKey));
  const secondQueue = tasks.some((task) => {
    const variants = [veSecondQueueTask(task, false), veSecondQueueTask(task, true)]
      .filter((variant): variant is VeCollectTask => variant !== null);
    return variants.length > 0 && variants.every((variant) => !known.has(veSourceStrategyKey(variant)));
  });
  return secondQueue || ((policy?.replan_attempts ?? 0) < 2 && tasks.length < VE_PLAN_MAX_TASKS);
}

/** Класс ОКВЭД из кода группы или подгруппы: «86.23» → «86». Прочее — как есть. */
function veOkvedClass(code: string): string {
  const match = /^\s*(\d{2})(?:\.[\d.]*)?\s*$/.exec(code);
  return match ? match[1] : code;
}

/**
 * План широкой гипотезы — сектор целиком для ежедневного добора: реестр по
 * классам ОКВЭД (две цифры) без порогов выручки и штата, каталог карт по
 * рубрикам сектора. Сигнал найма (hh_live, eng_hiring) такой гипотезе не
 * нужен и сужал бы поток; если кроме него в плане ничего нет, план не
 * обнуляем. Задачи, совпавшие после расширения, остаются в одном экземпляре.
 */
export function veBroadHypothesisPlan(plan: VeSourcePlan): { plan: VeSourcePlan; changed: number } {
  const hiring = (task: VeCollectTask) => task.source === 'hh_live' || task.source === 'eng_hiring';
  const kept = plan.tasks.some((task) => !hiring(task)) ? plan.tasks.filter((task) => !hiring(task)) : plan.tasks;
  let changed = plan.tasks.length - kept.length;
  const known = new Set<string>();
  const tasks: VeCollectTask[] = [];
  for (const task of kept) {
    let next = task;
    const filters = task.directory_filters;
    if (task.source === 'companies_directory' && filters) {
      const okvedCodes = filters.okvedCodes?.length ? [...new Set(filters.okvedCodes.map(veOkvedClass))] : filters.okvedCodes;
      const broadened = { ...(scoped(filters) ? withoutSize(filters) : filters), ...(okvedCodes ? { okvedCodes } : {}) };
      if (JSON.stringify(broadened) !== JSON.stringify(filters)) next = { ...task, directory_filters: broadened };
    } else if (task.source === 'pdl' && task.pdl_filters?.sizes?.length) {
      const rest = { ...task.pdl_filters };
      delete rest.sizes;
      next = { ...task, pdl_filters: rest };
    }
    const key = veSourceStrategyKey(next);
    if (known.has(key)) {
      changed += 1;
      continue;
    }
    known.add(key);
    if (next !== task) changed += 1;
    tasks.push(next);
  }
  return { plan: changed ? { ...plan, tasks } : plan, changed };
}

const generationText = (value: string) => value.toLowerCase().replace(/ё/g, 'е')
  .replace(/[-‐–—]/g, ' ').replace(/\s+/g, ' ').trim();
const generationBuyer = /^(?:тэц|грэс|аэс(?: смежные)?|генерирующие компании|электростанции)$/;
const generationRubric = /^(?:тэц|грэс|аэс|электростанци[яи]|теплоэлектроцентраль)$/;
const waterRubric = /^(?:водоканал[ы]?|очистные сооружения)$/;
const energyCode = (code: string) => /^35\.(?:1|3)(?:\.|$|\d)/.test(code.trim());
const waterCode = (code: string) => /^(?:36|37)(?:\.|$)/.test(code.trim());

/** Deliberately recognizes one unambiguous industrial audience. Unknown or
 * mixed buyers keep their plan; water being tested is not a water utility. */
function isGenerationLaboratoryScope(input: {
  market: string;
  hypotheses: Array<{ title: string; description?: string | null; broad?: boolean | null }>;
}): boolean {
  if (input.market !== 'ru' || input.hypotheses.length !== 1 || input.hypotheses[0].broad !== false) return false;
  const hypothesis = input.hypotheses[0];
  if (!/^(?:энергетические компании|генерирующие компании|электростанции)$/.test(generationText(hypothesis.title))) return false;
  const description = generationText(hypothesis.description ?? '');
  // Only the known audience sentence followed by an optional LIMS offer is
  // understood here. Never discard a second, unfamiliar audience sentence.
  const match = /^(.+?) с химлабораториями (.+?)(?:\.\s*(лимс\s+.*))?\.?$/.exec(description);
  if (!match || /водоканал|водоснабжен|водоотведен|очистные сооружения|(?:^|\s)(?:кроме|без|не|также)(?:\s|$)/.test(description)) return false;
  const buyers = match[1].split(/\s+(?:и|или)\s+|\s*[,;/]\s*/);
  const specimens = match[2].replace(/\.$/, '').split(/\s+и\s+|\s*,\s*/);
  return buyers.length > 0 && buyers.every((buyer) => generationBuyer.test(buyer.trim()))
    && buyers.some((buyer) => buyer !== 'аэс смежные')
    && specimens.length > 0 && specimens.every((item) => /^(?:воды|топлива|масел|выбросов)$/.test(item.trim()));
}

/** A proven old flat OR accidentally selected every chemist in every sector.
 * Free-form constraints, geography and Boolean queries are never rewritten. */
function scopedGenerationHh(text: string): string | null {
  if (!/\sOR\s/.test(text) || /\b(?:AND|NOT)\b|["'()!:*]/i.test(text)) return null;
  const roles = new Set<string>();
  let hasUnscopedRole = false;
  for (const term of text.split(/\s+OR\s+/)) {
    const value = generationText(term);
    if (generationRubric.test(value) || waterRubric.test(value)) continue;
    const role = /^(инженер химик|лаборант химического анализа|химик лаборатории)(?: (?:тэц|грэс|аэс|электростанции))?$/.exec(value);
    if (!role) return null;
    if (value === role[1]) hasUnscopedRole = true;
    roles.add(role[1] === 'инженер химик' ? 'инженер-химик' : role[1]);
  }
  if (!roles.size || !hasUnscopedRole) return null;
  const query = `(${[...roles].join(' OR ')}) AND (ТЭЦ OR ГРЭС OR АЭС OR электростанция)`;
  return query.length <= 300 ? query : null;
}

/** Fresh plans/replans only. No new source, paid action or budget; saved tasks
 * with cursors, harvested companies and children must never pass through here. */
export function normalizeVeGenerationSourcePlan(plan: VeSourcePlan, input: {
  market: string;
  hypotheses: Array<{ title: string; description?: string | null; broad?: boolean | null }>;
  /** Widening only: immutable source definitions already owning saved cursors.
   * They are an anchor/deduplication context, never part of the returned plan. */
  existingTasks?: readonly VeCollectTask[];
}): { plan: VeSourcePlan; changed: boolean } {
  if (!isGenerationLaboratoryScope(input)) return { plan, changed: false };
  let changed = false;
  const generationCatalog = (task: VeCollectTask) => task.source === 'companies_directory'
    ? !!task.directory_filters?.okvedCodes?.length && task.directory_filters.okvedCodes.every(energyCode)
    : task.source === 'yandex_maps' && !!task.maps_query?.queries.length
      && task.maps_query.queries.every((query) => generationRubric.test(generationText(query)));
  const narrowed = plan.tasks.flatMap((task): VeCollectTask[] => {
    if (task.source === 'companies_directory' && task.directory_filters?.okvedCodes?.length) {
      const codes = task.directory_filters.okvedCodes.filter((code) => !waterCode(code));
      if (codes.length === task.directory_filters.okvedCodes.length) return [task];
      changed = true;
      return codes.length ? [{ ...task, directory_filters: { ...task.directory_filters, okvedCodes: codes } }] : [];
    }
    if (task.source === 'yandex_maps' && task.maps_query?.queries.length) {
      const queries = task.maps_query.queries.filter((query) => !waterRubric.test(generationText(query)));
      if (queries.length === task.maps_query.queries.length) return [task];
      changed = true;
      return queries.length ? [{ ...task, maps_query: { ...task.maps_query, queries } }] : [];
    }
    const text = task.source === 'hh_live' && task.hh_query ? scopedGenerationHh(task.hh_query.text) : null;
    if (!text || text === task.hh_query?.text) return [task];
    changed = true;
    return [{ ...task, hh_query: { ...task.hh_query!, text } }];
  });
  // Without a retained catalog for the intended audience, decline the repair
  // rather than erase the whole plan or invent a replacement source.
  if (!narrowed.some(generationCatalog) && !input.existingTasks?.some(generationCatalog)) return { plan, changed: false };
  const ordered = [...narrowed.filter(generationCatalog), ...narrowed.filter((task) => !generationCatalog(task))];
  if (ordered.some((task, index) => task !== narrowed[index])) changed = true;
  if (!changed && !input.existingTasks?.length) return { plan, changed: false };
  const keys = new Set(input.existingTasks?.map(veSourceStrategyKey));
  const tasks = ordered.filter((task) => {
    const key = veSourceStrategyKey(task);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (tasks.length !== ordered.length) changed = true;
  return changed ? { plan: { ...plan, tasks }, changed: true } : { plan, changed: false };
}
