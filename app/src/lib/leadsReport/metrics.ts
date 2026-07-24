import type { SupabaseClient } from '@supabase/supabase-js';
import {
  detectSummaryChannel,
  type ChannelSummaryConfig,
} from '@/lib/leadsReport/channels';

const DEFAULT_PIPELINE_NAME = 'Воронка - новые лиды';
const QUALIFIED_STATUS = 'Квалифицированный лид';
const MEETING_SCHEDULED_STATUS = 'Назначена встреча';
const MEETING_HELD_STATUS = 'Встреча проведена + КП отправлено';
const WON_LOST = new Set([142, 143]);

const normalize = (value: string | null): string =>
  (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

export type AmoStatusMetricRow = {
  pipeline_id: number;
  status_id: number;
  status_name: string;
  sort: number;
};

export type AmoLeadMetricRow = {
  pipeline_id: number | null;
  status_id: number | null;
  status_name: string | null;
  name: string | null;
  created_at: string | null;
  updated_at: string | null;
  raw: unknown;
};

/**
 * Признак «лид-магнит»: сделка автоматически создана TG-ботом «Polza Site
 * Feedback» — имя всегда с префиксом «Бот:» (см. Telegram-канал заявок).
 * Такие сделки составляют почти весь Маркетинг-канал; для них Егор просит
 * считать «Пришло» только когда лид прошёл квалификацию, а не все подряд
 * (лид-магниты создают много слабых заявок «через магнит» — они всплывают
 * в «Пришло» и раздувают воронку).
 */
const LEAD_MAGNET_NAME_PREFIX = 'Бот:';

function isLeadMagnet(name: string | null): boolean {
  return typeof name === 'string' && name.trimStart().startsWith(LEAD_MAGNET_NAME_PREFIX);
}

export type ChannelMetrics = {
  channel: ChannelSummaryConfig;
  arrived: number;
  qualifiedLeads: number;
  meetingsScheduled: number;
  meetingsHeld: number;
};

type Thresholds = {
  pipelineId: number;
  qualifiedSort: number;
  meetingHeldSort: number;
  sortByStatusId: Map<number, number>;
};

function buildThresholds(statuses: AmoStatusMetricRow[]): Thresholds {
  const qualified = statuses.find(
    (status) => normalize(status.status_name) === normalize(QUALIFIED_STATUS),
  );
  const meetingHeld = statuses.find(
    (status) => normalize(status.status_name) === normalize(MEETING_HELD_STATUS),
  );

  if (!qualified) {
    throw new Error(`AMO status not found: ${QUALIFIED_STATUS}`);
  }
  if (!meetingHeld) {
    throw new Error(`AMO status not found: ${MEETING_HELD_STATUS}`);
  }
  if (qualified.pipeline_id !== meetingHeld.pipeline_id) {
    throw new Error('AMO report statuses belong to different pipelines');
  }

  return {
    pipelineId: qualified.pipeline_id,
    qualifiedSort: qualified.sort,
    meetingHeldSort: meetingHeld.sort,
    sortByStatusId: new Map(
      statuses
        .filter((status) => status.pipeline_id === qualified.pipeline_id)
        .map((status) => [status.status_id, status.sort]),
    ),
  };
}

function isInWindow(value: string | null, start: Date, end: Date): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}

/** Чистая часть расчёта — используется тестами и DB-оркестратором. */
export function computeMetricsFromRows(
  channels: ChannelSummaryConfig[],
  statuses: AmoStatusMetricRow[],
  leads: AmoLeadMetricRow[],
  start: Date,
  end: Date,
): ChannelMetrics[] {
  const thresholds = buildThresholds(statuses);
  const metrics = new Map(
    channels.map((channel) => [
      channel.name,
      {
        channel,
        arrived: 0,
        qualifiedLeads: 0,
        meetingsScheduled: 0,
        meetingsHeld: 0,
      },
    ]),
  );

  for (const lead of leads) {
    if (lead.pipeline_id !== thresholds.pipelineId) continue;
    const channel = detectSummaryChannel(lead.raw);
    if (!channel) continue;
    const bucket = metrics.get(channel);
    if (!bucket) continue;

    // Все метрики считаются ТОЛЬКО по сделкам, ПРИШЕДШИМ на этой неделе
    // (created_at в окне). «Лидов» / «Встречи» — это доля из свежих лидов,
    // что успели пройти квалификацию/встречу к моменту отчёта. Старые
    // backlog-сделки с апдейтом на этой неделе не считаются: иначе массовые
    // обновления полей (например протачивание кастомного поля «Контур»
    // сразу многим сделкам) раздуют цифры и они станут несопоставимы
    // с прошлыми отчётами продаж (Егор, 2026-07-24).
    if (!isInWindow(lead.created_at, start, end)) continue;

    const statusId =
      typeof lead.status_id === 'number' ? lead.status_id : Number.NaN;
    const statusSort = thresholds.sortByStatusId.get(statusId);
    const qualified = statusSort !== undefined && statusSort >= thresholds.qualifiedSort;

    // Лид-магниты («Бот:...») попадают в «Пришло» только когда прошли
    // квалификацию — иначе они раздувают воронку, ведь бот создаёт много
    // слабых заявок «через магнит» (см. Егор, 2026-07-24). Все остальные
    // сделки считаем в «Пришло» безусловно.
    if (!isLeadMagnet(lead.name) || qualified) {
      bucket.arrived += 1;
    }

    // По бизнес-правилу лидом считается «Квалифицированный лид» и любой этап
    // ниже по воронке, включая успешно и неуспешно закрытые сделки.
    if (qualified) {
      bucket.qualifiedLeads += 1;
    }

    if (normalize(lead.status_name) === normalize(MEETING_SCHEDULED_STATUS)) {
      bucket.meetingsScheduled += 1;
    }

    if (
      statusSort !== undefined &&
      statusSort >= thresholds.meetingHeldSort &&
      !WON_LOST.has(statusId)
    ) {
      bucket.meetingsHeld += 1;
    }
  }

  return channels.map((channel) => {
    const value = metrics.get(channel.name);
    if (!value) throw new Error(`Metrics bucket missing: ${channel.name}`);
    return value;
  });
}

export async function computeAllChannelMetrics(
  db: SupabaseClient,
  channels: ChannelSummaryConfig[],
  start: Date,
  end: Date,
): Promise<ChannelMetrics[]> {
  const pipelineName =
    process.env.LEADS_REPORT_PIPELINE_NAME ?? DEFAULT_PIPELINE_NAME;

  const { data: statusesData, error: statusesError } = await db
    .from('amo_statuses')
    .select('pipeline_id, status_id, status_name, sort')
    .eq('pipeline_name', pipelineName);
  if (statusesError) throw statusesError;

  const statuses = (statusesData ?? []) as AmoStatusMetricRow[];
  const thresholds = buildThresholds(statuses);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  // Тянем сделки, созданные в окне отчёта. Текущий status_id/status_name
  // отражает актуальное состояние на момент запроса — этого достаточно,
  // чтобы отфильтровать по «Квалифицированный лид» / «Назначена встреча» /
  // «Встреча проведена + КП отправлено».
  const { data: leadsData, error: leadsError } = await db
    .from('amo_leads')
    .select(
      'pipeline_id, status_id, status_name, name, created_at, updated_at, raw',
    )
    .eq('pipeline_id', thresholds.pipelineId)
    .gte('created_at', startIso)
    .lt('created_at', endIso);
  if (leadsError) throw leadsError;

  return computeMetricsFromRows(
    channels,
    statuses,
    (leadsData ?? []) as AmoLeadMetricRow[],
    start,
    end,
  );
}
