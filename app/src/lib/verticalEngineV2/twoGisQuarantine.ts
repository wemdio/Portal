import type { VeCollectTask } from './prompts/sourcePlan';
// Без циклов: этот модуль может импортировать adaptiveCollection, тот его — никогда.
import { veSourceStrategyKey } from './adaptiveCollection';
import { veCompanyIdentityKey } from './collectionIdentity';

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
export const VE_TWO_GIS_SOURCE_DETAIL = 'справочник организаций';
export const VE_TWO_GIS_ROW_FIELD = '_ve_two_gis';

/** Null-safe: collectionRecovery и sourceAudience читают задачи из jsonb как есть. */
export const isVeTwoGisTask = (task: { source?: unknown } | null | undefined) => task?.source === 'two_gis';

/** Задачи плана без близнецов two_gis: потолок плана и подсказка реплану их не видят. */
export function veCountedPlanTasks<T extends { source?: unknown }>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => !isVeTwoGisTask(task));
}

export function veTwoGisTwinKeys(states: ReadonlyArray<{ task?: VeCollectTask | null } | null> | null | undefined): Set<string> {
  return new Set((states ?? []).flatMap((state) => state?.task && isVeTwoGisTask(state.task) ? [veSourceStrategyKey(state.task)] : []));
}

/** Нормализация дописывает строки («\nСайт в источнике: …»), дедуп склеивает ячейку построчно
 * (mergeVeSourceFactText: «яндекс.карты\nсправочник организаций»): метка — любая строка. */
export const isVeTwoGisSourceDetail = (value: unknown) => typeof value === 'string'
  && value.split('\n').some((line) => line.trim() === VE_TWO_GIS_SOURCE_DETAIL);

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
