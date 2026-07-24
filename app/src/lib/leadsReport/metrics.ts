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
  created_at: string | null;
  updated_at: string | null;
  raw: unknown;
};

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

    const createdInWindow = isInWindow(lead.created_at, start, end);
    const updatedInWindow = isInWindow(lead.updated_at, start, end);
    const statusId =
      typeof lead.status_id === 'number' ? lead.status_id : Number.NaN;
    const statusSort = thresholds.sortByStatusId.get(statusId);

    if (createdInWindow) bucket.arrived += 1;
    if (!updatedInWindow) continue;

    // По бизнес-правилу лидом считается «Квалифицированный лид» и любой этап ниже,
    // включая успешно и неуспешно закрытые сделки.
    if (statusSort !== undefined && statusSort >= thresholds.qualifiedSort) {
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

  const { data: leadsData, error: leadsError } = await db
    .from('amo_leads')
    .select(
      'pipeline_id, status_id, status_name, created_at, updated_at, raw',
    )
    .eq('pipeline_id', thresholds.pipelineId)
    .or(
      `and(created_at.gte.${startIso},created_at.lt.${endIso}),` +
        `and(updated_at.gte.${startIso},updated_at.lt.${endIso})`,
    );
  if (leadsError) throw leadsError;

  return computeMetricsFromRows(
    channels,
    statuses,
    (leadsData ?? []) as AmoLeadMetricRow[],
    start,
    end,
  );
}
