/**
 * Какие закрытые задачи плана следующий раунд может перечитать без нового плана.
 *
 * Реестр и готовый каталог Яндекс Карт продолжают чтение со своей закладки.
 * Задачи карт, собранные до 16.09.2026 живым парсером (одна ссылка
 * «<запрос> Россия» на запрос), закрыты без закладки каталога: парсер вернул
 * 1–5 компаний на всю страну, и нигде такая задача не считалась продолжаемой —
 * база останавливалась с «Нет подтверждённого продолжения». Такую задачу
 * переоткрывают как чтение каталога по тому же maps_query.
 */

interface VeRenewableTaskState {
  source?: unknown;
  status?: unknown;
  child_job_id?: unknown;
  legacy_child_job_id?: unknown;
  catalog?: unknown;
  directory_cursors?: unknown;
  exhausted?: unknown;
  hit_ceiling?: unknown;
  task?: unknown;
}

/** Старая задача карт: закрыта, каталог по её запросам ещё не читали. */
export function isVeLegacyMapsTask(state: VeRenewableTaskState | null | undefined): boolean {
  if (!state || state.source !== 'yandex_maps' || state.status !== 'done' || state.catalog
    || state.exhausted || state.hit_ceiling) return false;
  const queries = (state.task as { maps_query?: { queries?: unknown } } | undefined)?.maps_query?.queries;
  return Array.isArray(queries) && queries.some((query) => typeof query === 'string' && query.trim().length > 0);
}

/** Закрытая задача, у которой источник ещё не исчерпан. */
export function isVeRenewableSourceTask(state: VeRenewableTaskState | null | undefined): boolean {
  return !!state && state.status === 'done' && !state.exhausted && !state.hit_ceiling
    && (state.source === 'companies_directory' || !!state.catalog || isVeLegacyMapsTask(state));
}

/**
 * Та же задача, снова открытая для чтения. Реестр и каталог несут свою
 * закладку; старая задача карт — только запросы: фильтр каталога подберётся
 * при первом чтении, а id завершённого парсера остаётся для диагностики.
 */
export function reopenVeSourceTask<T extends VeRenewableTaskState>(state: T): T {
  const legacy = typeof state.legacy_child_job_id === 'string' ? state.legacy_child_job_id
    : isVeLegacyMapsTask(state) && typeof state.child_job_id === 'string' ? state.child_job_id : undefined;
  return { source: state.source, task: state.task, status: 'pending', child_job_id: null, rows: 0,
    ...(state.catalog ? { catalog: state.catalog } : {}),
    ...(state.directory_cursors ? { directory_cursors: state.directory_cursors } : {}),
    ...(legacy ? { legacy_child_job_id: legacy } : {}) } as unknown as T;
}
