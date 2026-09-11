import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * История переходов сделки по этапам AMO — «рельсы» в модалке сделки.
 *
 * Путь по воронке в модалке первички показывает только ПЕРВЫЕ даты ключевых
 * этапов, а у продлений его нет вовсе. Ни то, ни другое не отвечает на вопрос,
 * который задают при разборе застрявшей сделки: когда именно она куда зашла и
 * не откатывали ли её назад. Здесь — каждый переход целиком, по порядку.
 *
 * Откат — нормальная часть жизни сделки (счёт отозвали, клиент вернулся к
 * обсуждению), поэтому он не прячется, а помечается: переход в той же воронке
 * на этап с меньшим порядковым номером. Перенос в другую воронку откатом не
 * считается — порядковые номера разных воронок несравнимы.
 *
 * Статусы «Успешно реализовано» (142) и «Закрыто и не реализовано» (143)
 * имеют один и тот же номер во ВСЕХ воронках, поэтому по одному номеру этапа
 * воронку не узнать. Её берём из самого события (`payload.value_after`), где
 * AMO кладёт пару «этап + воронка»; номер без воронки — только запасной путь
 * для событий, у которых такой пары нет.
 */

/** Системные «Успешно реализовано» / «Закрыто и не реализовано». */
const WON_STATUS_ID = 142;
const LOST_STATUS_ID = 143;

export type DealTransitionKind = 'forward' | 'rollback' | 'pipeline' | 'won' | 'lost' | 'reopened';

export interface DealTransition {
  changedAt: string;
  fromStatus: string | null;
  toStatus: string | null;
  /** Название воронки, если переход её сменил, иначе null. */
  toPipeline: string | null;
  kind: DealTransitionKind;
  /** Кто перевёл — имя пользователя AMO, если его удалось узнать. */
  changedBy: string | null;
  /** Сколько дней сделка простояла на этапе, куда зашла этим переходом. У последнего — по сегодня. */
  daysOnStage: number | null;
}

export interface DealRail {
  /** Этап и воронка, в которых сделку завели (до первого перехода). */
  createdAt: string | null;
  createdStatus: string | null;
  createdPipeline: string | null;
  transitions: DealTransition[];
}

type StatusRow = {
  pipeline_id: number;
  status_id: number;
  status_name: string | null;
  pipeline_name: string | null;
  sort: number | null;
};

type EventRow = {
  changed_at: string | null;
  changed_by: string | number | null;
  from_value: string | null;
  to_value: string | null;
  payload: unknown;
};

type LeadRow = {
  created_at: string | null;
  status_id: number | null;
  pipeline_id: number | null;
};

export type StatusRef = { statusId: number; pipelineId: number | null };

/** Пара «этап + воронка» из `payload.value_before` / `value_after` события AMO. */
export function readStatusRef(payload: unknown, side: 'value_before' | 'value_after'): StatusRef | null {
  if (payload === null || typeof payload !== 'object') return null;
  const list = (payload as Record<string, unknown>)[side];
  if (!Array.isArray(list) || list.length === 0) return null;
  const status = (list[0] as { lead_status?: { id?: unknown; pipeline_id?: unknown } } | null)?.lead_status;
  const statusId = Number(status?.id);
  if (!Number.isFinite(statusId)) return null;
  const pipelineId = Number(status?.pipeline_id);
  return { statusId, pipelineId: Number.isFinite(pipelineId) ? pipelineId : null };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Собирает рельсы из сырых строк. Чистая функция — без обращений к базе, чтобы
 * правило отката жило в одном месте и не зависело от способа выборки.
 */
export function buildDealRail(
  lead: LeadRow,
  events: EventRow[],
  statuses: StatusRow[],
  userNames: Map<string, string>,
  now: Date = new Date(),
): DealRail {
  const byPipelineAndStatus = new Map<string, StatusRow>();
  /** Запасной путь: номер этапа → строки справочника (у 142/143 их несколько). */
  const byStatus = new Map<number, StatusRow[]>();
  for (const row of statuses) {
    byPipelineAndStatus.set(`${row.pipeline_id}:${row.status_id}`, row);
    const list = byStatus.get(Number(row.status_id)) ?? [];
    list.push(row);
    byStatus.set(Number(row.status_id), list);
  }
  const pipelineName = (pipelineId: number | null): string | null => {
    if (pipelineId === null) return null;
    return statuses.find((s) => Number(s.pipeline_id) === pipelineId)?.pipeline_name ?? null;
  };

  /**
   * Находит строку справочника для этапа. Если воронка неизвестна, а номер
   * этапа встречается в нескольких воронках (142/143), берём ту, в которой
   * сделка была на предыдущем шаге, — иначе первую попавшуюся.
   */
  const resolve = (ref: StatusRef | null, fallbackPipeline: number | null): StatusRow | null => {
    if (ref === null) return null;
    const pipeline = ref.pipelineId ?? fallbackPipeline;
    if (pipeline !== null) {
      const exact = byPipelineAndStatus.get(`${pipeline}:${ref.statusId}`);
      if (exact) return exact;
    }
    const candidates = byStatus.get(ref.statusId) ?? [];
    return candidates[0] ?? null;
  };

  const sorted = events
    .filter((e) => e.changed_at)
    .sort((a, b) => new Date(a.changed_at as string).getTime() - new Date(b.changed_at as string).getTime());

  // Этап при создании — «откуда» первого перехода. Если сделку не двигали
  // ни разу, она до сих пор стоит там, где её завели.
  let currentPipeline: number | null = null;
  let createdRow: StatusRow | null = null;
  if (sorted.length > 0) {
    const firstFrom =
      readStatusRef(sorted[0]!.payload, 'value_before') ??
      (sorted[0]!.from_value ? { statusId: Number(sorted[0]!.from_value), pipelineId: null } : null);
    createdRow = resolve(firstFrom, lead.pipeline_id);
  } else if (lead.status_id !== null) {
    createdRow = resolve({ statusId: Number(lead.status_id), pipelineId: lead.pipeline_id }, lead.pipeline_id);
  }
  currentPipeline = createdRow ? Number(createdRow.pipeline_id) : lead.pipeline_id;

  const transitions: DealTransition[] = [];
  for (const event of sorted) {
    const fromRef =
      readStatusRef(event.payload, 'value_before') ??
      (event.from_value ? { statusId: Number(event.from_value), pipelineId: null } : null);
    const toRef =
      readStatusRef(event.payload, 'value_after') ??
      (event.to_value ? { statusId: Number(event.to_value), pipelineId: null } : null);

    const fromRow = resolve(fromRef, currentPipeline);
    const toRow = resolve(toRef, fromRow ? Number(fromRow.pipeline_id) : currentPipeline);

    const fromPipeline = fromRow ? Number(fromRow.pipeline_id) : currentPipeline;
    const toPipeline = toRow ? Number(toRow.pipeline_id) : fromPipeline;
    const pipelineChanged = fromPipeline !== null && toPipeline !== null && fromPipeline !== toPipeline;

    const toStatusId = toRef?.statusId ?? null;
    const fromStatusId = fromRef?.statusId ?? null;

    let kind: DealTransitionKind;
    if (pipelineChanged) kind = 'pipeline';
    else if (toStatusId === WON_STATUS_ID) kind = 'won';
    else if (toStatusId === LOST_STATUS_ID) kind = 'lost';
    // Из закрытой (успешно или нет) — обратно в работу: это возврат сделки,
    // а не обычный откат между рабочими этапами.
    else if (fromStatusId === WON_STATUS_ID || fromStatusId === LOST_STATUS_ID) kind = 'reopened';
    else if (fromRow?.sort != null && toRow?.sort != null && Number(toRow.sort) < Number(fromRow.sort)) kind = 'rollback';
    else kind = 'forward';

    const author = event.changed_by === null || event.changed_by === undefined ? null : String(event.changed_by);

    transitions.push({
      changedAt: event.changed_at as string,
      fromStatus: fromRow?.status_name ?? (fromStatusId !== null ? `этап ${fromStatusId}` : null),
      toStatus: toRow?.status_name ?? (toStatusId !== null ? `этап ${toStatusId}` : null),
      toPipeline: pipelineChanged ? (toRow?.pipeline_name ?? pipelineName(toPipeline)) : null,
      kind,
      changedBy: author ? (userNames.get(author) ?? null) : null,
      daysOnStage: null,
    });

    currentPipeline = toPipeline;
  }

  // Сколько сделка простояла на каждом этапе: до следующего перехода, у
  // последнего — по сегодня. Считаем целыми днями вниз: «0 дн.» честнее, чем
  // округлённые вверх сутки за переход, сделанный через пять минут.
  for (let i = 0; i < transitions.length; i++) {
    const start = new Date(transitions[i]!.changedAt).getTime();
    const end = i + 1 < transitions.length ? new Date(transitions[i + 1]!.changedAt).getTime() : now.getTime();
    transitions[i]!.daysOnStage = Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, Math.floor((end - start) / DAY_MS))
      : null;
  }

  return {
    createdAt: lead.created_at,
    createdStatus: createdRow?.status_name ?? null,
    createdPipeline: createdRow?.pipeline_name ?? pipelineName(currentPipeline),
    transitions,
  };
}

/** Тянет всё нужное для рельсов одной сделки. Общая для ручек первички и продлений. */
export async function fetchDealRail(db: SupabaseClient, amoId: number): Promise<DealRail> {
  const [leadRes, eventsRes, statusesRes] = await Promise.all([
    db.from('amo_leads').select('created_at, status_id, pipeline_id').eq('amo_id', amoId).maybeSingle(),
    db
      .from('amo_events')
      .select('changed_at, changed_by, from_value, to_value, payload')
      .eq('amo_deal_id', amoId)
      .eq('event_type', 'lead_status_changed')
      .order('changed_at', { ascending: true }),
    db.from('amo_statuses').select('pipeline_id, status_id, status_name, pipeline_name, sort'),
  ]);
  if (leadRes.error) throw leadRes.error;
  if (eventsRes.error) throw eventsRes.error;
  if (statusesRes.error) throw statusesRes.error;

  const events = (eventsRes.data ?? []) as EventRow[];

  // Имена авторов переходов — отдельным запросом и только по тем, кто
  // встречается в событиях этой сделки.
  const authorIds = [...new Set(events.map((e) => e.changed_by).filter((v) => v !== null && v !== undefined).map(String))];
  const userNames = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: users, error: usersError } = await db.from('amo_users').select('id, name').in('id', authorIds);
    // Имена — украшение: без них рельсы всё равно верны, поэтому ошибка
    // справочника пользователей модалку не роняет.
    if (!usersError) {
      for (const user of (users ?? []) as Array<{ id: string | number; name: string | null }>) {
        if (user.name) userNames.set(String(user.id), user.name);
      }
    }
  }

  const lead = (leadRes.data ?? { created_at: null, status_id: null, pipeline_id: null }) as LeadRow;
  return buildDealRail(lead, events, (statusesRes.data ?? []) as StatusRow[], userNames);
}
