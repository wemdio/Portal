/**
 * Повторная квалификация — сделку, уже бывшую квалом, снова перевели в квал.
 *
 * Решение Дмитрия 26.10.2026: «те, что снова квал, — тоже квал». Повод —
 * сверка недели 19–23.10 с фильтром AMO у продаж: 28 сделок переводили в
 * «Лид квалифицирован», а по первой квалификации их выходило 25. Три
 * (Крыгина, @kattyalysenko, @serebrrrrro) были квалом весной–летом, их
 * вернули на «Взят в работу» и квалифицировали заново.
 *
 * Перевод считается квалификацией, если сделка пришла СНИЗУ — с этапа до
 * «Лид квалифицирован» («Неразобранное», «Новый лид», «Взят в работу») — на
 * сам квал или дальше по воронке, кроме «Переноса» (парковка, туда кладут с
 * любого этапа). Из «Закрыто» не считается: так же отбирает фильтр продаж в
 * AMO («значение до» — три этапа до квала), и возврат закрытой сделки — это
 * не квалификация, а отмена закрытия.
 *
 * Считается только «по когорте». Без когорты сделка заведена в периоде, и
 * повторный квал внутри той же недели — это та же самая сделка, она уже
 * посчитана первой квалификацией.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/** «Лид квалифицирован» — опорный этап, по id: название продажи меняют. */
const QUALIFIED_STATUS_ID = 87397290;
/** «Перенос» — парковка, позицией в воронке не считается. */
const PARKING_STATUS_ID = 63387178;
/** sort закрытых этапов («Успешно» 10000, «Закрыто» 11000) — признак закрытия. */
const CLOSED_SORT = 10000;

export type StatusSortRow = { status_id: number; sort: number };
export type StatusEventRow = {
  amo_deal_id: number;
  changed_at: string;
  from_value: string | null;
  to_value: string | null;
};

/**
 * Сделка → самый ранний перевод «снизу» в квал или дальше среди `events`.
 * Чистая часть — окно по времени режет вызывающий код.
 */
export function requalifiedAt(
  statuses: StatusSortRow[],
  events: StatusEventRow[],
): Map<number, string> {
  const sortById = new Map(statuses.map((s) => [Number(s.status_id), Number(s.sort)]));
  const qualifiedSort = sortById.get(QUALIFIED_STATUS_ID);
  const result = new Map<number, string>();
  if (qualifiedSort === undefined) return result;

  for (const event of events) {
    const fromSort = sortById.get(Number(event.from_value));
    const toId = Number(event.to_value);
    const toSort = sortById.get(toId);
    if (fromSort === undefined || toSort === undefined) continue;
    if (fromSort >= qualifiedSort) continue;
    if (toSort < qualifiedSort || toSort >= CLOSED_SORT || toId === PARKING_STATUS_ID) continue;

    const dealId = Number(event.amo_deal_id);
    const prev = result.get(dealId);
    if (prev === undefined || event.changed_at < prev) result.set(dealId, event.changed_at);
  }
  return result;
}

const PAGE_SIZE = 1000;

/**
 * Переводы в квал «снизу» за окно `[from, to]` по воронке `pipelineId`
 * (правая граница включительно — как у остальных окон дашборда).
 * Воронку сделки здесь не проверяем — это делает выборка сделок у
 * вызывающего (`amo_lead_stage_dates_v` с исходной воронкой).
 *
 * Переводы тянутся только на этапы квала и дальше и постранично: за квартал
 * или год их тысячи, а PostgREST отдаёт не больше тысячи строк за раз.
 */
export async function fetchRequalified(
  db: SupabaseClient,
  pipelineId: number,
  from: Date,
  to: Date,
): Promise<Map<number, string>> {
  const statusRes = await db
    .from('amo_statuses')
    .select('status_id, sort')
    .eq('pipeline_id', pipelineId);
  if (statusRes.error) throw statusRes.error;
  const statuses = (statusRes.data ?? []) as StatusSortRow[];
  const qualified = statuses.find((s) => Number(s.status_id) === QUALIFIED_STATUS_ID);
  if (!qualified) return new Map();

  const targetIds = statuses
    .filter((s) => s.sort >= qualified.sort && s.sort < CLOSED_SORT
      && Number(s.status_id) !== PARKING_STATUS_ID)
    .map((s) => String(s.status_id));

  const events: StatusEventRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from('amo_status_events_v')
      .select('id, amo_deal_id, changed_at, from_value, to_value')
      .eq('event_type', 'lead_status_changed')
      .in('to_value', targetIds)
      .gte('changed_at', from.toISOString())
      .lte('changed_at', to.toISOString())
      .order('id')
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as StatusEventRow[];
    events.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return requalifiedAt(statuses, events);
}
