/**
 * Холостой тик стадии base_collect: дешёвый вход и редкое пробуждение.
 *
 * Стадия просыпается по self-requeue и на входе читает строку ve_bases
 * целиком. Резерв релевантности, закладки источников и пакеты препросмотра
 * живут в одной колонке collect_info, поэтому «целиком» — это 16-62 МБ на
 * активную базу (замер 21.09.2026 по восьми собирающимся базам:
 * 2,8 / 5,9 / 16,2 / 17,7 / 19,0 / 24,0 / 26,7 / 62,0 МБ в сжатом виде;
 * коэффициент распаковки 1,87 — столько JSON едет через main-rest).
 *
 * Здесь лежат ТОЛЬКО чистые функции и строка проекции. Ни одного обращения к
 * БД: и проекцию, и паузу надо уметь проверять юнит-тестом без мока Supabase.
 */

import type { VeCollectionTargetProgress } from './collectionTarget';

/**
 * Узкая проекция строки ve_bases для входа стадии.
 *
 * Здесь НЕТ collect_info, data, sample_rows и analysis — именно они и весят
 * десятки мегабайт. `collection_mode` берём отдельным jsonb-путём: PostgREST
 * вычисляет `->>` на стороне Postgres, поэтому наружу едет одна строка, а не
 * весь документ (тот же приём уже работает в baseAudienceSummary.ts и в
 * findOlderCollectingBase ниже по файлу).
 */
export const VE_BASE_COLLECT_PROBE_COLUMNS =
  'id, project_id, vertical_id, hypothesis_id, source, status, '
  + 'collection_mode:collect_info->>collection_mode';

export interface VeBaseCollectProbe {
  id?: unknown;
  source?: unknown;
  status?: unknown;
  /** Проекция jsonb-пути (прод). */
  collection_mode?: unknown;
  /** Полный документ (тесты и любой другой читатель, спросивший '*'). */
  collect_info?: { collection_mode?: unknown } | null;
}

/**
 * Режим сборки из узкого чтения.
 *
 * Мок Supabase в тестах игнорирует проекцию и отдаёт строку целиком, поэтому
 * у прочитанной строки есть collect_info и нет вычисленного псевдонима. Тот же
 * порядок «колонка, иначе документ» уже зашит в БД — ve_base_public_info_cached
 * делает coalesce(public_info, ve_base_public_info(b)).
 */
export function veProbeCollectionMode(row: VeBaseCollectProbe): string | null {
  if (typeof row.collection_mode === 'string' && row.collection_mode.trim()) return row.collection_mode.trim();
  const nested = row.collect_info?.collection_mode;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : null;
}

/** Статусы, при которых сборка уже завершена и новый круг не нужен. */
const TERMINAL_BASE_STATUSES = new Set(['analyzing', 'analyzed', 'failed']);

export function veBaseCollectFinished(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_BASE_STATUSES.has(status);
}

/** Потолок паузы простоя. Выше — ожидание дочерней работы станет заметным. */
export const VE_IDLE_REQUEUE_MAX_MS = 5 * 60_000;

/**
 * Пауза перед следующим пробуждением раунда.
 *
 * Раунд, который сдвинул счётчики, будит себя как раньше (`baseMs`). Раунд,
 * который закончился ровно тем же состоянием, удваивает паузу: 1 с → 2 → 4 →
 * … → потолок. Любое продвижение сбрасывает счётчик в ноль, поэтому пауза
 * растёт только там, где расти нечему.
 *
 * Зачем: 21.09.2026 база 912c19df прошла 18 подряд раундов без единого
 * обращения к провайдеру, просыпаясь через 1 с и тратя по 50-90 с на чтение и
 * перезапись своих 19 МБ; база 299af08f — 9 подряд по 130-185 с на 62 МБ.
 */
export function veIdleRequeueMs(
  baseMs: number,
  idleRounds: number,
  maxMs: number = VE_IDLE_REQUEUE_MAX_MS,
): number {
  const floor = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 1_000;
  const cap = Number.isFinite(maxMs) && maxMs > floor ? maxMs : floor;
  if (!Number.isSafeInteger(idleRounds) || idleRounds <= 0) return floor;
  // 2 ** 30 уже больше любого разумного потолка; ограничение снимает риск
  // Infinity на испорченном счётчике из старого collect_info.
  const grown = floor * 2 ** Math.min(idleRounds, 30);
  return Math.min(cap, Number.isFinite(grown) ? grown : cap);
}

/**
 * Продвинулся ли раунд.
 *
 * Сравниваем ровно те счётчики, которые стадия сама считает продвижением:
 * номер раунда, разобранные кандидаты и готовые контакты. Терминальный статус
 * раунда — тоже продвижение: за ним следующего пробуждения не будет.
 */
export function veRoundAdvanced(
  previous: Pick<VeCollectionTargetProgress, 'round' | 'candidates_processed' | 'ready_rows'> | undefined,
  next: Pick<VeCollectionTargetProgress, 'round' | 'candidates_processed' | 'ready_rows' | 'status'>,
): boolean {
  if (next.status !== 'collecting') return true;
  if (!previous) return true;
  return next.round > previous.round
    || next.candidates_processed > previous.candidates_processed
    || next.ready_rows > previous.ready_rows;
}

/** Счётчик подряд идущих раундов без продвижения для следующей паузы. */
export function veNextIdleRounds(advanced: boolean, previous: unknown): number {
  if (advanced) return 0;
  const current = Number.isSafeInteger(previous) && (previous as number) > 0 ? previous as number : 0;
  return current + 1;
}
