import type { SupabaseClient } from '@supabase/supabase-js';

import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';

/**
 * Воронка вторичных продаж — из воронки AMO «Вторичные (и не только) продажи».
 *
 * Считается так же, как воронка первички: не «сколько сделок стоит на этапе
 * сейчас», а «сколько дошло до этапа хотя бы раз». Первое — распределение по
 * взаимоисключающим корзинам, и рисовать его воронкой нельзя: сделка находится
 * ровно на одном этапе, а не на всех предыдущих сразу. Второе — настоящая
 * вложенность, где каждый этап подмножество предыдущего.
 *
 * История берётся из `amo_events` (`lead_status_changed`, `to_value` — номер
 * этапа строкой) вместе с текущим этапом сделки: сделка могла проскочить этап
 * до того, как портал начал писать события, и тогда её спасает только текущее
 * положение.
 */

/** Воронка «Вторичные (и не только) продажи», создана 06.08.2026. */
export const SECONDARY_PIPELINE_ID = Number(process.env.RENEWALS_PIPELINE_ID ?? '11176862');

/**
 * Верхняя граница прямого пути. Этапы выше по `sort` — «Пауза», «Реанимация»,
 * «Отвал / не продлен» — не продолжение пути, а исходы: сделка попадает туда
 * ВМЕСТО продления, а не после него. Считать их ступенями воронки значило бы
 * записать отвалившиеся сделки в продлённые, потому что их `sort` больше.
 */
const PATH_MAX_SORT = 90;

/** Нижняя граница: `sort` 10 — служебное «Неразобранное», входом оно не является. */
const PATH_MIN_SORT = 20;

/** Системные «Успешно реализовано» / «Закрыто и не реализовано». */
const SYSTEM_SORT = 10000;

export interface FunnelStage {
  statusId: number;
  name: string;
  sort: number;
  /** Сколько сделок дошли до этого этапа хотя бы раз. */
  reached: number;
}

export interface FunnelOutcome {
  statusId: number;
  name: string;
  /** Сколько сделок стоят здесь СЕЙЧАС. Исход — состояние, а не пройденный этап. */
  count: number;
}

export interface RenewalsFunnel {
  pipelineId: number;
  /** Всего сделок в воронке — знаменатель для долей. */
  totalDeals: number;
  stages: FunnelStage[];
  outcomes: FunnelOutcome[];
}

interface StatusRow {
  status_id: number;
  status_name: string | null;
  sort: number | null;
}

interface LeadRow {
  amo_id: number;
  status_id: number | null;
}

export async function fetchRenewalsFunnel(db: SupabaseClient): Promise<RenewalsFunnel> {
  const { data: statusData, error: statusError } = await db
    .from('amo_statuses')
    .select('status_id, status_name, sort')
    .eq('pipeline_id', SECONDARY_PIPELINE_ID);
  if (statusError) throw new Error(`amo_statuses: ${statusError.message}`);

  const statuses = (statusData ?? []) as StatusRow[];
  const sortById = new Map<number, number>();
  for (const row of statuses) {
    if (row.sort !== null) sortById.set(Number(row.status_id), Number(row.sort));
  }

  const { data: leadData, error: leadError } = await db
    .from('amo_leads')
    .select('amo_id, status_id')
    .eq('pipeline_id', SECONDARY_PIPELINE_ID);
  if (leadError) throw new Error(`amo_leads: ${leadError.message}`);

  const leads = (leadData ?? []) as LeadRow[];

  // Максимальный `sort` прямого пути, которого сделка достигала. Стартуем с
  // текущего этапа: событий может не быть вовсе (сделка создалась сразу на
  // «Передан в работу» и не двигалась).
  const maxPathSort = new Map<number, number>();
  for (const lead of leads) {
    const sort = lead.status_id === null ? undefined : sortById.get(Number(lead.status_id));
    maxPathSort.set(lead.amo_id, sort !== undefined && sort <= PATH_MAX_SORT ? sort : 0);
  }

  if (leads.length > 0) {
    const ids = leads.map((l) => l.amo_id);
    for (const chunk of chunkArray(ids, IN_CHUNK_SIZE)) {
      const { data: eventData, error: eventError } = await db
        .from('amo_events')
        .select('amo_deal_id, to_value')
        .eq('event_type', 'lead_status_changed')
        .in('amo_deal_id', chunk);
      if (eventError) throw new Error(`amo_events: ${eventError.message}`);

      for (const event of (eventData ?? []) as { amo_deal_id: number; to_value: string | null }[]) {
        if (!event.to_value) continue;
        const sort = sortById.get(Number(event.to_value));
        // Чужие воронки отсеиваются сами: их номеров нет в `sortById`.
        if (sort === undefined || sort > PATH_MAX_SORT) continue;
        const current = maxPathSort.get(event.amo_deal_id) ?? 0;
        if (sort > current) maxPathSort.set(event.amo_deal_id, sort);
      }
    }
  }

  const reachedSorts = [...maxPathSort.values()];

  const stages: FunnelStage[] = statuses
    .filter((row) => row.sort !== null && row.sort >= PATH_MIN_SORT && row.sort <= PATH_MAX_SORT)
    .sort((a, b) => (a.sort as number) - (b.sort as number))
    .map((row) => ({
      statusId: Number(row.status_id),
      name: row.status_name ?? String(row.status_id),
      sort: Number(row.sort),
      reached: reachedSorts.filter((value) => value >= Number(row.sort)).length,
    }));

  // Исходы считаем по ТЕКУЩЕМУ этапу, а не по «побывал»: пауза, из которой
  // проект вернулся в работу, — уже не пауза.
  const currentCounts = new Map<number, number>();
  for (const lead of leads) {
    if (lead.status_id === null) continue;
    const id = Number(lead.status_id);
    currentCounts.set(id, (currentCounts.get(id) ?? 0) + 1);
  }

  const outcomes: FunnelOutcome[] = statuses
    .filter((row) => row.sort !== null && row.sort > PATH_MAX_SORT && row.sort < SYSTEM_SORT)
    .sort((a, b) => (a.sort as number) - (b.sort as number))
    .map((row) => ({
      statusId: Number(row.status_id),
      name: row.status_name ?? String(row.status_id),
      count: currentCounts.get(Number(row.status_id)) ?? 0,
    }));

  return {
    pipelineId: SECONDARY_PIPELINE_ID,
    totalDeals: leads.length,
    stages,
    outcomes,
  };
}
