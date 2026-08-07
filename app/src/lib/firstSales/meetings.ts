/**
 * Встречи дашборда первички — по привязкам записей разговоров
 * (`meeting_deal_links`), а не по этапу AMO «Встреча проведена».
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
  const transcriptIds = [...new Set(links.map((l) => l.transcript_id))];
  const dateByTranscript = new Map<string, string | null>();
  for (const chunk of chunkArray(transcriptIds, IN_CHUNK_SIZE)) {
    const { data: trChunk, error: trError } = await db
      .from('tg_video_transcripts')
      .select('id, tg_message_date')
      .in('id', chunk);
    if (trError) throw trError;
    for (const t of (trChunk ?? []) as Array<{ id: string; tg_message_date: string | null }>) {
      dateByTranscript.set(t.id, t.tg_message_date);
    }
  }

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const inWindow = links.filter((l) => {
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
  const validDealIds = new Set<number>();
  for (const chunk of chunkArray(dealIds, IN_CHUNK_SIZE)) {
    const { data: leadsChunk, error: leadsError } = await db
      .from('amo_lead_stage_dates_v')
      .select('amo_deal_id')
      .eq('pipeline_id', pipelineId)
      .in('amo_deal_id', chunk);
    if (leadsError) throw leadsError;
    for (const l of (leadsChunk ?? []) as Array<{ amo_deal_id: number }>) validDealIds.add(l.amo_deal_id);
  }

  return inWindow
    .filter((l) => validDealIds.has(l.amo_deal_id))
    .map((l) => ({
      amo_deal_id: l.amo_deal_id,
      meeting_at: dateByTranscript.get(l.transcript_id) as string,
    }));
}
