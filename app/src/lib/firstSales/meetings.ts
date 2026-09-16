/**
 * Встречи дашборда первички — по привязкам записей разговоров
 * (`meeting_deal_links`), а не по этапу AMO «Встреча проведена».
 *
 * Привязка идёт по номеру сделки из подписи, домену и названию компании — в
 * этом порядке (см. `apply_meeting_deal_links`, миграция 20260909_0006).
 * Записи, которые менеджер пометил «в аналитику ОП не считать», сюда не
 * попадают: это встречи по продлениям.
 *
 * Зачем: этап AMO даёт 200+ встреч в месяц против 64 у руководителя продаж —
 * этап засорён (сделку двигают по нему и без реальной встречи). Руководитель
 * считает встречу так: есть запись разговора в телеграм-чате встреч. Таблица
 * `meeting_deal_links` (миграция 20260731_0001) уже привязывает такие записи
 * к сделкам по домену/названию компании; этот модуль читает привязки за окно.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';

export type MeetingLinkRow = {
  amo_deal_id: number;
  /** ISO-момент публикации записи в чате (`tg_video_transcripts.tg_message_date`). */
  meeting_at: string;
};

/**
 * Чат встреч в телеграме — `tg_video_transcripts.tg_chat_id`. Второй чат
 * (`-1002179160904`) — внутренние созвоны команды, в метрику и в очередь
 * ручной разметки не входит.
 *
 * Значение продублировано в `apply_meeting_deal_links()` (миграция
 * 20260731_0001) — SQL не может импортировать эту константу. Если чат
 * встреч когда-нибудь сменится, менять оба места.
 */
export const MEETING_CHAT_ID = -1001852890744;

/**
 * Дата, с которой подписи к записям в чате встреч стали регулярными.
 *
 * До неё запись могли выложить без подписи с названием компании — автоматчер
 * такую запись привязать не может, и она навсегда остаётся неучтённой. За
 * март 2026 автоматом привязалось 18 записей, за апрель — 6, за июнь — 72
 * (сопоставимо с июльскими 72–78). Ноль или единицы встреч за март/апрель —
 * не «встреч не было», а «мы не можем их посчитать». UI обязан показать
 * прочерк, а не поверить нулю — тот же приём, что и для договоров
 * (см. `CONTRACT_RULE_SINCE` в `metrics.ts`).
 */
export const MEETINGS_RELIABLE_SINCE = new Date(
  process.env.FIRST_SALES_MEETINGS_SINCE ?? '2026-05-01T00:00:00.000Z',
);

/**
 * Пометка в подписи, которой менеджер сам исключает встречу из аналитики
 * отдела продаж: «#33181669 | Зиккурат | Продление (В аналитику ОП не
 * считать)».
 *
 * Такие встречи реальные, но это разговоры о продлении действующего клиента —
 * в воронку первички они не идут. За август 2026 их семь. Ловим именно
 * «не считать», а не слово «продление»: обсуждение продления вполне может
 * всплыть на встрече по новой сделке, и выбрасывать её из-за одного слова в
 * комментарии значило бы занижать метрику молча.
 */
export const NOT_FOR_ANALYTICS_RE = /не\s*счита/i;

/** Исключена ли запись из аналитики отдела продаж пометкой в подписи. */
export function excludedFromAnalytics(caption: string | null | undefined): boolean {
  return NOT_FOR_ANALYTICS_RE.test(caption ?? '');
}

/**
 * Тянет пары «сделка + дата записи» за окно `[from, to]`.
 *
 * Джойн ведётся в три шага, каждый — чанками по `IN_CHUNK_SIZE` (тот же
 * приём, что в `fetchFirstSalesLeads`, а не embedded PostgREST-select: в
 * миграции `amo_deal_id` на `meeting_deal_links` — обычный bigint без
 * объявленного FK на `amo_leads`, PostgREST не смог бы построить джойн
 * автоматически):
 *   1. `meeting_deal_links` — все привязки (таблица маленькая, сотни строк
 *      за всю историю, отдельный date-фильтр здесь не нужен);
 *   2. `tg_video_transcripts` — дата записи, `tg_message_date`, по которой и
 *      режется окно;
 *   3. `amo_leads` — сузить до сделок нужной воронки. `meeting_deal_links` не
 *      знает о воронках: запись могла привязаться к сделке из «Работы с
 *      базой», если совпали домен/название. Без этого шага метрика считала
 *      бы встречи чужой воронки.
 *
 * Важно: сделка, у которой есть встреча в окне, может лежать вне окна по
 * `created_at` (пришла раньше) — здесь это не фильтруется. Отбор «эту сделку
 * не потерять» происходит на стороне `fetchFirstSalesLeads` (параметр
 * `extraDealIds`), а не здесь.
 */
export async function fetchMeetingLinks(
  db: SupabaseClient,
  pipelineId: number,
  from: Date,
  to: Date,
): Promise<MeetingLinkRow[]> {
  const { data, error } = await db
    .from('meeting_deal_links')
    .select('transcript_id, amo_deal_id');
  if (error) throw error;

  const links = (data ?? []) as Array<{ transcript_id: string; amo_deal_id: number }>;
  if (links.length === 0) return [];

  // Дата встречи лежит на самой транскрипции, не на привязке.
  //
  // Чанки идут параллельно, а не в цикле с await: они независимы друг от друга,
  // и последовательный цикл превращал разбиение «чтобы не упереться в лимит
  // длины URL» в лишние round-trip'ы на ровном месте (сотни привязок — это
  // три-четыре запроса подряд, и так дважды за запрос сводки: текущее окно и
  // предыдущее).
  const transcriptIds = [...new Set(links.map((l) => l.transcript_id))];
  const transcriptChunks = await Promise.all(
    chunkArray(transcriptIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data: trChunk, error: trError } = await db
        .from('tg_video_transcripts')
        .select('id, tg_message_date, caption')
        .in('id', chunk);
      if (trError) throw trError;
      return (trChunk ?? []) as Array<{
        id: string; tg_message_date: string | null; caption: string | null;
      }>;
    }),
  );
  const dateByTranscript = new Map<string, string | null>();
  /** Записи, которые менеджер сам пометил «в аналитику ОП не считать». */
  const excluded = new Set<string>();
  for (const t of transcriptChunks.flat()) {
    dateByTranscript.set(t.id, t.tg_message_date);
    if (excludedFromAnalytics(t.caption)) excluded.add(t.id);
  }

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const inWindow = links.filter((l) => {
    // Пометка человека сильнее любой автоматики: он провёл эту встречу и сам
    // сказал, что она про продление.
    if (excluded.has(l.transcript_id)) return false;
    const dateStr = dateByTranscript.get(l.transcript_id);
    if (!dateStr) return false;
    const t = new Date(dateStr).getTime();
    return Number.isFinite(t) && t >= fromMs && t <= toMs;
  });
  if (inWindow.length === 0) return [];

  // Сузить до сделок нужной воронки — см. комментарий к функции.
  //
  // Воронка берётся из `amo_lead_stage_dates_v`, а не из `amo_leads`: там
  // `pipeline_id` — воронка, где сделка РОДИЛАСЬ. У `amo_leads` он текущий, и
  // перенесённая сделка не прошла бы этот фильтр — её встреча пропала бы из
  // подсчёта вслед за самой сделкой (см. 20260807_0002).
  const dealIds = [...new Set(inWindow.map((l) => l.amo_deal_id))];
  const dealChunks = await Promise.all(
    chunkArray(dealIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data: leadsChunk, error: leadsError } = await db
        .from('amo_lead_stage_dates_v')
        .select('amo_deal_id')
        .eq('pipeline_id', pipelineId)
        .in('amo_deal_id', chunk);
      if (leadsError) throw leadsError;
      return (leadsChunk ?? []) as Array<{ amo_deal_id: number }>;
    }),
  );
  const validDealIds = new Set<number>(dealChunks.flat().map((l) => l.amo_deal_id));

  return inWindow
    .filter((l) => validDealIds.has(l.amo_deal_id))
    .map((l) => ({
      amo_deal_id: l.amo_deal_id,
      meeting_at: dateByTranscript.get(l.transcript_id) as string,
    }));
}

/** Встроенный тип задачи AMO «Встреча» («Звонок» — 1). */
const MEETING_TASK_TYPE_ID = 2;
/** Этап, на котором карточка «застревает», когда встречу провели, а сделку не передвинули. */
const MEETING_SCHEDULED_STATUS = 'Назначена встреча';

/**
 * Встречи, которые прошли, но этапом не отмечены: сделка → срок задачи.
 *
 * Правило сверено с отчётом продаж 11.09.2026 (август: 77 встреч по этапу,
 * 78 в отчёте; разница — Benkendorf). Встреча засчитывается, если у сделки в
 * периоде есть ЗАКРЫТАЯ задача типа «Встреча» и в конце периода карточка всё
 * ещё стоит на «Назначена встреча»: встречу провели и задачу закрыли, а
 * карточку не передвинули.
 *
 * Условие на этап узкое намеренно. Правило «любая закрытая задача-встреча»
 * добавило бы за август 16 встреч, в том числе у сделок, закрытых в минус или
 * вернувшихся на «Первый контакт», — это не пропущенные встречи, а шум задач.
 *
 * Дата встречи — `complete_till` (срок задачи): менеджер закрывает задачу когда
 * придётся, иногда через неделю, а срок — это когда встреча была назначена.
 *
 * Этап на конец периода: последний переход до его конца; если переходов до
 * конца нет — этап, с которого сделка ушла первым переходом; если переходов нет
 * вовсе — текущий этап. Тот же порядок, что у leadsReport (isLostByEnd).
 */
export async function fetchTaskMeetings(
  db: SupabaseClient,
  pipelineId: number,
  from: Date,
  to: Date,
): Promise<Map<number, string>> {
  const { data: taskData, error: taskError } = await db
    .from('amo_tasks')
    .select('amo_deal_id, complete_till')
    .eq('task_type_id', MEETING_TASK_TYPE_ID)
    .eq('is_completed', true)
    .gte('complete_till', from.toISOString())
    .lte('complete_till', to.toISOString());
  if (taskError) throw taskError;

  // Сделка → самый ранний срок закрытой задачи-встречи в периоде.
  const taskAtByDeal = new Map<number, string>();
  for (const task of (taskData ?? []) as Array<{ amo_deal_id: number | null; complete_till: string | null }>) {
    if (task.amo_deal_id == null || !task.complete_till) continue;
    const dealId = Number(task.amo_deal_id);
    const prev = taskAtByDeal.get(dealId);
    if (prev === undefined || task.complete_till < prev) taskAtByDeal.set(dealId, task.complete_till);
  }
  if (taskAtByDeal.size === 0) return new Map();

  const { data: statusData, error: statusError } = await db
    .from('amo_statuses')
    .select('status_id, status_name')
    .eq('pipeline_id', pipelineId);
  if (statusError) throw statusError;
  const scheduled = ((statusData ?? []) as Array<{ status_id: number; status_name: string | null }>)
    .find((s) => (s.status_name ?? '').trim() === MEETING_SCHEDULED_STATUS);
  // Этап переименовали или удалили — правило молча выключается, а не падает
  // весь дашборд: встречи по этапу при этом считаются как обычно.
  if (!scheduled) return new Map();
  const scheduledId = Number(scheduled.status_id);

  const dealIds = [...taskAtByDeal.keys()];
  const toMs = to.getTime();

  const [pipelineChunks, leadChunks, eventChunks] = await Promise.all([
    // Воронка — исходная, как у остальных метрик первички (amo_lead_stage_dates_v).
    Promise.all(chunkArray(dealIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data, error } = await db
        .from('amo_lead_stage_dates_v')
        .select('amo_deal_id')
        .eq('pipeline_id', pipelineId)
        .in('amo_deal_id', chunk);
      if (error) throw error;
      return (data ?? []) as Array<{ amo_deal_id: number }>;
    })),
    Promise.all(chunkArray(dealIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data, error } = await db
        .from('amo_leads')
        .select('amo_id, status_id')
        .in('amo_id', chunk);
      if (error) throw error;
      return (data ?? []) as Array<{ amo_id: number; status_id: number | null }>;
    })),
    Promise.all(chunkArray(dealIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data, error } = await db
        .from('amo_events')
        .select('amo_deal_id, changed_at, from_value, to_value')
        .eq('event_type', 'lead_status_changed')
        .in('amo_deal_id', chunk);
      if (error) throw error;
      return (data ?? []) as Array<{
        amo_deal_id: number; changed_at: string | null; from_value: string | null; to_value: string | null;
      }>;
    })),
  ]);

  const inPipeline = new Set(pipelineChunks.flat().map((r) => Number(r.amo_deal_id)));
  const currentStatus = new Map(leadChunks.flat().map((r) => [Number(r.amo_id), r.status_id]));
  const eventsByDeal = new Map<number, Array<{ at: number; from: number | null; to: number | null }>>();
  for (const e of eventChunks.flat()) {
    const at = Date.parse(e.changed_at ?? '');
    if (!Number.isFinite(at)) continue;
    const toId = Number(e.to_value);
    const fromId = Number(e.from_value);
    const list = eventsByDeal.get(Number(e.amo_deal_id)) ?? [];
    list.push({
      at,
      from: Number.isInteger(fromId) ? fromId : null,
      to: Number.isInteger(toId) ? toId : null,
    });
    eventsByDeal.set(Number(e.amo_deal_id), list);
  }

  const result = new Map<number, string>();
  for (const [dealId, taskAt] of taskAtByDeal) {
    if (!inPipeline.has(dealId)) continue;
    const events = (eventsByDeal.get(dealId) ?? []).sort((a, b) => a.at - b.at);
    const beforeEnd = events.filter((e) => e.at <= toMs);
    const statusAtEnd = beforeEnd.length > 0
      ? beforeEnd[beforeEnd.length - 1]!.to
      : events.length > 0
        ? events[0]!.from
        : (currentStatus.get(dealId) ?? null);
    if (statusAtEnd === scheduledId) result.set(dealId, taskAt);
  }
  return result;
}
