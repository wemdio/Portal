import type { VeCollectTask, VeSourcePlan } from './prompts/sourcePlan';
import { veSourceStrategyKey } from './adaptiveCollection';
import { VE_PLAN_MAX_TASKS } from './planWidening';

/**
 * Клиники по лицензии medical (реестр МСП ФНС). Замер 24.10.2026 по «базе баз»,
 * юрлица:
 *  - ОКВЭД 86 вместе с лицензией — 21,2 тыс. компаний, 23 из 25 в выборке клиники;
 *  - лицензия без ОКВЭД 86 — 6,4 тыс., клиник около пятой части, остальные держат
 *    лицензию для своих нужд: медосмотры водителей у перевозчиков, зуботехника, спа;
 *  - лицензия есть в реестре только у 64% действующих МСП с ОКВЭД 86.
 * Поэтому medical — только вместе с ОКВЭД (класс 86, если модель кода не дала), а
 * рядом — задача по тому же ОКВЭД без лицензии: она добирает клиники, которых нет в
 * реестре лицензий. Компаньон получает только ОКВЭД класса 86: у косметологии
 * (96.02) лицензия и отличает центр от салона, без неё срез — все салоны красоты.
 */
const CLINIC_OKVED = '86';
const isClinicOkved = (code: string) => code === CLINIC_OKVED || code.startsWith(`${CLINIC_OKVED}.`);
const hasMedical = (task: VeCollectTask) => task.source === 'companies_directory'
  && !!task.directory_filters?.licenceGroups?.includes('medical');

/** Только свежий план: сохранённые задачи владеют курсорами и ключами стратегий. */
export function normalizeVeLicenceSourcePlan(plan: VeSourcePlan): { plan: VeSourcePlan; changed: number; skipped: number } {
  if (!plan.tasks.some(hasMedical)) return { plan, changed: 0, skipped: 0 };
  const keys = new Set(plan.tasks.map(veSourceStrategyKey));
  const tasks: VeCollectTask[] = [];
  let changed = 0;
  /** Добор не влез в план: VE_PLAN_MAX_TASKS — об этом пишет лог стадии. */
  let skipped = 0;
  for (const [index, task] of plan.tasks.entries()) {
    if (!hasMedical(task)) {
      tasks.push(task);
      continue;
    }
    let licensed = task;
    if (!task.directory_filters!.okvedCodes?.length) {
      licensed = { ...task, directory_filters: { ...task.directory_filters, okvedCodes: [CLINIC_OKVED] } };
      const key = veSourceStrategyKey(licensed);
      // Такая задача в плане уже есть: вторая с тем же ключом читала бы те же страницы.
      if (keys.has(key)) {
        changed += 1;
        continue;
      }
      keys.add(key);
      changed += 1;
    }
    tasks.push(licensed);
    const filters = licensed.directory_filters!;
    if (!filters.okvedCodes!.every(isClinicOkved)) continue;
    const { licenceGroups: _licence, ...withoutLicence } = filters;
    const companion: VeCollectTask = {
      ...licensed,
      directory_filters: withoutLicence,
      rationale: `${licensed.rationale} Добор: тот же ОКВЭД без лицензии — в реестре лицензий только около двух третей действующих клиник.`,
    };
    const key = veSourceStrategyKey(companion);
    // Задачи модели не вытесняются: компаньон встаёт, только пока план не длиннее предела.
    const remaining = plan.tasks.length - index - 1;
    if (keys.has(key)) continue;
    if (tasks.length + 1 + remaining > VE_PLAN_MAX_TASKS) {
      skipped += 1;
      continue;
    }
    keys.add(key);
    tasks.push(companion);
    changed += 1;
  }
  return changed ? { plan: { ...plan, tasks }, changed, skipped } : { plan, changed, skipped };
}
