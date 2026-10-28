import { randomUUID } from 'node:crypto';
import type { VeCollectTask, VeSourcePlan } from './prompts/sourcePlan';
// Без циклов: этот модуль может импортировать adaptiveCollection, тот его — никогда.
import { veSourceStrategyKey } from './adaptiveCollection';
import { veCompanyIdentityKey } from './collectionIdentity';
import { veTwoGisQueryScope } from './collectionGeography';
import { isVeTwoGisSourceDetail, VE_TWO_GIS_ROW_FIELD } from './twoGisMarker';

/**
 * Совместимое чтение 2ГИС (план 26.10.2026, шаг R1). Сам источник появится
 * позже; этот код только гарантирует, что любая версия от R1 и выше безопасно
 * открывает базу с задачей `two_gis` или строками из неё — например, после
 * отката. В R1 выдача строк 2ГИС всегда закрыта: такие строки не идут в
 * обработку, разбор резерва, цель, метрики источников и выдачу, но остаются
 * в исключениях других баз проекта, чтобы после открытия не было дублей.
 *
 * Признаки строки 2ГИС — любой из: приватное поле `_ve_two_gis`,
 * `source_detail` «справочник организаций», ключ стратегии задачи `two_gis`.
 *
 * Контракт для R3: КАЖДАЯ строка близнеца несёт строку «справочник организаций» в
 * `source_detail` и, где можно, `_ve_two_gis` — harvest, `relevance_reserve.source_rows`,
 * производные строки (география и т. п.), строки резерва и `data`. Одного `_ve_two_gis`
 * мало: сетка конструктора хранит только колонки базы, а мост признака при импорте
 * (veTwoGisInputMarkers) узнаёт строку лишь по ИНН или сайту — по почте моста нет.
 * Колонка «Источник» сетки сохраняет `source_detail`. Выдача, выгрузки и доставка
 * (launchTemplate, launchRecovery, поставка, превью, экспорт, verifiedContactsExport,
 * guard загрузки) смотрят только на эти два признака. Ключ стратегии близнеца — лишь
 * внутренняя страховка baseCollect (harvest, deferred_rows, source_rows), вне его он не известен.
 * Модуль только серверный: adaptiveCollection тянет node:crypto.
 */
export { isVeTwoGisSourceDetail, VE_TWO_GIS_ROW_FIELD, VE_TWO_GIS_SOURCE_DETAIL } from './twoGisMarker';

/** Null-safe: collectionRecovery и sourceAudience читают задачи из jsonb как есть. */
export const isVeTwoGisTask = (task: { source?: unknown } | null | undefined) => task?.source === 'two_gis';

/** Задачи плана без близнецов two_gis: потолок плана и подсказка реплану их не видят. */
export function veCountedPlanTasks<T extends { source?: unknown }>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => !isVeTwoGisTask(task));
}

type VeTwoGisTaskStatus = 'pending' | 'dispatched' | 'done' | 'failed';
interface VeTwoGisPairState {
  task: VeCollectTask; status: VeTwoGisTaskStatus; child_job_id: string | null; two_gis_pair_id?: string;
  unavailable?: boolean; exhausted?: boolean; note?: string; error?: string;
}

/** Близнец больше не читается (профиль, география, пара потеряна): done + unavailable, не failed.
 * harvest, rows, курсор two_gis и two_gis_pair_id остаются для учёта и аудита; недоступный близнец
 * терминален — veHasSourceCursor его не видит, reopen не поднимает. Повтор — no-op (false). */
export function retireVeTwoGisTwin(state: Omit<VeTwoGisPairState, 'task'>, note: string): boolean {
  if (state.status === 'done' && state.unavailable) return false;
  state.status = 'done';
  state.unavailable = true;
  state.child_job_id = null;
  state.note = note;
  delete state.error;
  return true;
}

export const VE_TWO_GIS_TWIN_RATIONALE = 'Снимок 2ГИС по запросам задачи Яндекс Карт; сайт, почта и соответствие проверяются обычным порядком.';
export const VE_TWO_GIS_PAIR_LOST_NOTE = 'Пара потеряна: задачи Яндекс Карт этого близнеца в плане нет';

/** План R3 «Близнец», только первичный план: по близнецу сразу после каждой yandex_maps, с её
 * запросами и geo (Яндекс-задача по Москве не даёт близнеца на всю Россию). В задаче связи пары нет. */
export function withVeTwoGisTwins(plan: VeSourcePlan): VeSourcePlan {
  if (!plan.tasks.some((task) => task.source === 'yandex_maps' && !!task.maps_query?.queries?.length)) return plan;
  return { ...plan, tasks: plan.tasks.flatMap((task): VeCollectTask[] => task.source !== 'yandex_maps' || !task.maps_query?.queries?.length
    ? [task]
    : [task, { source: 'two_gis', rationale: VE_TWO_GIS_TWIN_RATIONALE,
      two_gis_query: { from_queries: [...task.maps_query.queries], ...(task.maps_query.geo ? { geo: task.maps_query.geo } : {}) } }]) };
}

/** После географии: близнец с географией вне России или нераспознанной не ставится; второй с тем же
 * итоговым ключом удаляется (его Яндекс-задача остаётся без пары) — в плане нет двух задач с одним ключом. */
export function finalizeVeTwoGisTwins(plan: VeSourcePlan): { plan: VeSourcePlan; added: number; dropped: number } {
  const keys = new Set<string>();
  let added = 0;
  const tasks = plan.tasks.filter((task) => {
    if (!isVeTwoGisTask(task)) return true;
    const query = task.two_gis_query;
    const key = veSourceStrategyKey(task);
    if (!query?.from_queries?.length || !veTwoGisQueryScope(query) || keys.has(key)) return false;
    keys.add(key);
    added += 1;
    return true;
  });
  const dropped = plan.tasks.length - tasks.length;
  return { plan: dropped ? { ...plan, tasks } : plan, added, dropped };
}

const sameQueries = (maps: VeCollectTask, twin: VeCollectTask) =>
  JSON.stringify(maps.maps_query?.queries ?? []) === JSON.stringify(twin.two_gis_query?.from_queries ?? []);
const losePair = (state: VeTwoGisPairState) => retireVeTwoGisTwin(state, VE_TWO_GIS_PAIR_LOST_NOTE);

/** Новые состояния: близнец стоит сразу после своей Яндекс-задачи, обе получают один случайный
 * two_gis_pair_id. Близнец без такой соседки — «пара потеряна». Без близнецов — no-op. */
export function pairVeTwoGisStates(states: VeTwoGisPairState[], newId: () => string = randomUUID): void {
  states.forEach((state, index) => {
    if (!isVeTwoGisTask(state.task)) return;
    const maps = states[index - 1];
    if (maps && maps.task.source === 'yandex_maps' && !maps.two_gis_pair_id && sameQueries(maps.task, state.task)) {
      const id = newId();
      maps.two_gis_pair_id = id;
      state.two_gis_pair_id = id;
    } else losePair(state);
  });
}

/** Близнец без не-близнеца с тем же two_gis_pair_id — done+unavailable «пара потеряна»; harvest, rows и
 * курсор остаются. true — что-то закрыто. */
export function retireVeOrphanTwoGisTwins(states: VeTwoGisPairState[] | undefined): boolean {
  if (!states?.some((state) => isVeTwoGisTask(state.task))) return false;
  const pairs = new Set(states.filter((state) => !isVeTwoGisTask(state.task) && state.two_gis_pair_id).map((state) => state.two_gis_pair_id));
  let changed = false;
  for (const state of states) {
    if (!isVeTwoGisTask(state.task) || (state.two_gis_pair_id && pairs.has(state.two_gis_pair_id))) continue;
    if (losePair(state)) changed = true;
  }
  return changed;
}

export function veTwoGisTwinKeys(states: ReadonlyArray<{ task?: VeCollectTask | null } | null> | null | undefined): Set<string> {
  return new Set((states ?? []).flatMap((state) => state?.task && isVeTwoGisTask(state.task) ? [veSourceStrategyKey(state.task)] : []));
}

/** Null-safe, как veProjectExclusionRow: строки аудитории и payload бывают пустыми. */
export function isVeTwoGisRow(row: object | null | undefined, twinKeys?: ReadonlySet<string>): boolean {
  if (!row || typeof row !== 'object') return false;
  const value = row as Record<string, unknown>;
  if (value[VE_TWO_GIS_ROW_FIELD] != null || isVeTwoGisSourceDetail(value.source_detail)) return true;
  return !!twinKeys?.size && typeof value._ve_source_strategy === 'string' && twinKeys.has(value._ve_source_strategy);
}

/** Без помеченных строк возвращает тот же массив: проверки по ссылке и порядок не меняются. */
export function withoutVeTwoGisRows<T extends object>(rows: T[], twinKeys?: ReadonlySet<string>): T[] {
  return rows.some((row) => isVeTwoGisRow(row, twinKeys)) ? rows.filter((row) => !isVeTwoGisRow(row, twinKeys)) : rows;
}

/** lead_payload строки доставки: признак запуска рядом с `_ve_company_identity` или колонка
 * source_detail в переменных (payload поставки сверяется с аудитом и признака не несёт). */
export function isVeTwoGisLead(lead: object | null | undefined): boolean {
  if (!lead || typeof lead !== 'object') return false;
  const vars = (lead as { custom_variables?: unknown }).custom_variables;
  return isVeTwoGisRow(lead) || (!!vars && typeof vars === 'object' && !Array.isArray(vars) && isVeTwoGisRow(vars));
}

/** Только ссылка на карточку: полный адрес не уходит из harvest/source_rows. */
function veTwoGisCardRef(value: unknown): Record<string, unknown> {
  const own = value && typeof value === 'object' ? value as { card_id?: unknown; snapshot_id?: unknown } : {};
  return { ...(own.card_id !== undefined ? { card_id: own.card_id } : {}),
    ...(own.snapshot_id !== undefined ? { snapshot_id: own.snapshot_id } : {}) };
}

/** Сетка конструктора хранит только колонки базы: приватные признаки теряются.
 * Строку импорта узнаём по ключу компании помеченной строки той же пачки. */
export function veTwoGisInputMarkers(inputs: ReadonlyArray<object>, twinKeys?: ReadonlySet<string>): Map<string, Record<string, unknown>> {
  const markers = new Map<string, Record<string, unknown>>();
  for (const input of inputs) {
    if (!isVeTwoGisRow(input, twinKeys)) continue;
    const row = input as Record<string, unknown>;
    const key = veCompanyIdentityKey(row);
    if (key) markers.set(key, veTwoGisCardRef(row[VE_TWO_GIS_ROW_FIELD]));
  }
  return markers;
}

export function veTwoGisImportMarker(row: object, markers: ReadonlyMap<string, Record<string, unknown>>,
  twinKeys?: ReadonlySet<string>): Record<string, unknown> | null {
  const key = markers.size ? veCompanyIdentityKey(row as Record<string, unknown>) : null;
  const bridged = key ? markers.get(key) : undefined;
  if (bridged) return bridged;
  return isVeTwoGisRow(row, twinKeys) ? veTwoGisCardRef((row as Record<string, unknown>)[VE_TWO_GIS_ROW_FIELD]) : null;
}
