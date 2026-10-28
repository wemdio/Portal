import { FUNNEL_PIPELINE_ID, type StatusChange } from './rules';
import { enforceTransition, type GuardResult } from './guard';

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

type AmoEvent = {
  entity_id?: number;
  entity_type?: string;
  created_at?: number;
  value_before?: Array<{ lead_status?: { id?: number; pipeline_id?: number } }>;
  value_after?: Array<{ lead_status?: { id?: number; pipeline_id?: number } }>;
};

/**
 * Только последний переход каждой сделки, по времени. Более ранние уже перекрыты
 * следующими ходами: запрещённый перенос, который вебхук сразу откатил, иначе
 * перечитывался бы из журнала всё окно (180 минут) и откатывал сделку всякий раз,
 * когда её законно, по этапам, доводили до того же этапа — проверка «сделка уже
 * не там» смотрит только на текущий этап (сделка 35419479, 28.10.2026).
 * Журнал AMO отдаёт события от новых к старым, поэтому при равном времени
 * остаётся первое встреченное — более новое.
 */
export function latestChangePerLead(changes: StatusChange[]): StatusChange[] {
  const latest = new Map<number, StatusChange>();
  for (const change of changes) {
    const prev = latest.get(change.leadId);
    if (!prev || change.occurredAt!.getTime() > prev.occurredAt!.getTime()) latest.set(change.leadId, change);
  }
  return [...latest.values()].sort((a, b) => a.occurredAt!.getTime() - b.occurredAt!.getTime());
}

/**
 * Страховка от потерянных вебхуков: берёт переходы этапов из журнала AMO за
 * последние `sinceMinutes` минут и прогоняет их через ту же проверку, что и
 * вебхук. Повторный прогон безопасен: сделка, уже вернувшаяся или ушедшая
 * дальше, пропускается (`stale`), собственные откаты узнаются по таблице.
 * Если портал лежал дольше окна, дальше окна ничего не подхватится.
 */
export async function reconcileRecentTransitions(
  sinceMinutes: number,
): Promise<Record<GuardResult | 'error', number>> {
  const baseRaw = (process.env.AMO_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const token = (process.env.AMO_ACCESS_TOKEN || process.env.AMOCRM_TOKEN || '').trim();
  const counts = { ok: 0, reverted: 0, stale: 0, 'no-credentials': 0, error: 0 };
  if (!baseRaw || !token) {
    counts['no-credentials'] += 1;
    return counts;
  }
  const base = baseRaw.startsWith('http') ? baseRaw : `https://${baseRaw}`;
  const from = Math.floor(Date.now() / 1000) - sinceMinutes * 60;

  const changes: StatusChange[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `${base}/api/v4/events?limit=${PAGE_LIMIT}&page=${page}`
        + `&filter[type][]=lead_status_changed&filter[created_at][from]=${from}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
    );
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`AMO events → ${res.status}`);
    const events = ((await res.json()) as { _embedded?: { events?: AmoEvent[] } })._embedded?.events ?? [];
    for (const e of events) {
      const before = e.value_before?.[0]?.lead_status;
      const after = e.value_after?.[0]?.lead_status;
      if (e.entity_type !== 'lead' || !e.entity_id || !e.created_at) continue;
      if (before?.id == null || after?.id == null || after.pipeline_id == null) continue;
      if (after.pipeline_id !== FUNNEL_PIPELINE_ID) continue;
      changes.push({
        leadId: e.entity_id,
        pipelineId: after.pipeline_id,
        oldPipelineId: before.pipeline_id ?? null,
        statusId: after.id,
        oldStatusId: before.id,
        occurredAt: new Date(e.created_at * 1000),
      });
    }
    if (events.length < PAGE_LIMIT) break;
  }

  for (const change of latestChangePerLead(changes)) {
    try {
      counts[await enforceTransition(change)] += 1;
    } catch (err) {
      console.error('[amo-funnel-guard] reconcile', change.leadId, err);
      counts.error += 1;
    }
  }
  return counts;
}
