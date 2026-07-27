/**
 * Метрики для отчёта продаж «Отчетность продаж Polza Agency».
 *
 * Считаем все ФАКТ-цифры одного блока (ИТОГО ПО ОТДЕЛУ или конкретный
 * менеджер) для произвольного временного окна — окно передаётся снаружи
 * (месяц / неделя / кастомное). Это позволяет одним и тем же кодом
 * заполнять и колонку МЕСЯЦ, и колонки I..V недель, и по разным менеджерам.
 *
 * Соответствие метрик и статусов AMO (воронка «Воронка - новые лиды»):
 *
 *   Метрика                    Правило подсчёта
 *   -----------------------   --------------------------------------------
 *   Новых лидов с {канал}     created_at в окне  +  канал = {канал}
 *   Квал {канал}              sort ≥ «Квалифицированный лид» (40)
 *                             + канал = {канал} + updated_at в окне
 *   встреч, шт                sort ≥ «Встреча проведена + КП отправлено» (70)
 *                             + updated_at в окне
 *   договоров, шт             sort ≥ «Согласование договора» (110)
 *                             + updated_at в окне
 *   Счетов отправлено, шт     sort ≥ «Отправлен счет» (100)
 *                             + updated_at в окне
 *   Оплат получено, шт        status_id = 142 (Успешно) + updated_at в окне
 *   Сумма оплат, руб          SUM(amount) для тех же оплат
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  detectSummaryChannel,
  type SummaryChannelName,
} from '@/lib/leadsReport/channels';

const DEFAULT_PIPELINE_NAME = 'Воронка - новые лиды';
const QUALIFIED_STATUS = 'Квалифицированный лид';
const MEETING_HELD_STATUS = 'Встреча проведена + КП отправлено';
const INVOICE_SENT_STATUS = 'Отправлен счет';
const CONTRACT_STATUS = 'Согласование договора';
const WON_STATUS_ID = 142;

const normalize = (value: string | null): string =>
  (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

export type SalesReportBlock = {
  newLeadsMarketing: number;
  qualMarketing: number;
  newLeadsSmm: number;
  qualSmm: number;
  newLeadsOutreach: number;
  qualOutreach: number;
  newLeadsPartners: number;
  qualPartners: number;
  newLeadsTgOutreach: number;
  qualTgOutreach: number;
  meetings: number;
  contracts: number;
  invoicesSent: number;
  paymentsReceived: number;
  revenue: number;
};

type LeadRow = {
  status_id: number | null;
  status_name: string | null;
  amount: number | null;
  created_at: string | null;
  updated_at: string | null;
  raw: unknown;
};

type PipelineThresholds = {
  qualifiedSort: number;
  meetingHeldSort: number;
  invoiceSentSort: number;
  contractSort: number;
  sortByStatusId: Map<number, number>;
};

function buildThresholds(
  statuses: Array<{ status_id: number; status_name: string; sort: number }>,
): PipelineThresholds {
  const findSort = (name: string): number => {
    const found = statuses.find((s) => normalize(s.status_name) === normalize(name));
    if (!found) throw new Error(`AMO status not found: ${name}`);
    return found.sort;
  };
  return {
    qualifiedSort: findSort(QUALIFIED_STATUS),
    meetingHeldSort: findSort(MEETING_HELD_STATUS),
    invoiceSentSort: findSort(INVOICE_SENT_STATUS),
    contractSort: findSort(CONTRACT_STATUS),
    sortByStatusId: new Map(statuses.map((s) => [s.status_id, s.sort])),
  };
}

function isInWindow(value: string | null, start: Date, end: Date): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}

/** Чистая часть — используется тестами и оркестратором. */
export function computeSalesReportBlockFromRows(
  leads: LeadRow[],
  statuses: Array<{ status_id: number; status_name: string; sort: number }>,
  start: Date,
  end: Date,
): SalesReportBlock {
  const thresholds = buildThresholds(statuses);

  const zero: SalesReportBlock = {
    newLeadsMarketing: 0, qualMarketing: 0,
    newLeadsSmm: 0, qualSmm: 0,
    newLeadsOutreach: 0, qualOutreach: 0,
    newLeadsPartners: 0, qualPartners: 0,
    newLeadsTgOutreach: 0, qualTgOutreach: 0,
    meetings: 0, contracts: 0, invoicesSent: 0,
    paymentsReceived: 0, revenue: 0,
  };
  const result = { ...zero };

  const bump = (
    channel: SummaryChannelName | null,
    createdInWindow: boolean,
    qualified: boolean,
    updatedInWindow: boolean,
  ) => {
    if (!channel) return;
    // Новых лидов с {канал}: пришли в окне, независимо от статуса
    if (createdInWindow) {
      if (channel === 'marketing') result.newLeadsMarketing += 1;
      else if (channel === 'smm') result.newLeadsSmm += 1;
      else if (channel === 'outreach') result.newLeadsOutreach += 1;
      else if (channel === 'partners') result.newLeadsPartners += 1;
      else if (channel === 'tg_outreach') result.newLeadsTgOutreach += 1;
    }
    // Квал {канал}: sort ≥ Квалифицированный + активность в окне (updated_at)
    if (qualified && updatedInWindow) {
      if (channel === 'marketing') result.qualMarketing += 1;
      else if (channel === 'smm') result.qualSmm += 1;
      else if (channel === 'outreach') result.qualOutreach += 1;
      else if (channel === 'partners') result.qualPartners += 1;
      else if (channel === 'tg_outreach') result.qualTgOutreach += 1;
    }
  };

  for (const lead of leads) {
    const createdInWindow = isInWindow(lead.created_at, start, end);
    const updatedInWindow = isInWindow(lead.updated_at, start, end);
    if (!createdInWindow && !updatedInWindow) continue;

    const statusId =
      typeof lead.status_id === 'number' ? lead.status_id : Number.NaN;
    const statusSort = thresholds.sortByStatusId.get(statusId);
    const channel = detectSummaryChannel(lead.raw);
    const qualified =
      statusSort !== undefined && statusSort >= thresholds.qualifiedSort;

    bump(channel, createdInWindow, qualified, updatedInWindow);

    if (!updatedInWindow) continue;
    if (statusSort === undefined) continue;

    if (statusSort >= thresholds.meetingHeldSort) result.meetings += 1;
    if (statusSort >= thresholds.invoiceSentSort) result.invoicesSent += 1;
    if (statusSort >= thresholds.contractSort) result.contracts += 1;

    if (statusId === WON_STATUS_ID) {
      result.paymentsReceived += 1;
      result.revenue += Number.isFinite(Number(lead.amount)) ? Number(lead.amount) : 0;
    }
  }

  return result;
}

export async function computeSalesReportBlock(
  db: SupabaseClient,
  start: Date,
  end: Date,
): Promise<SalesReportBlock> {
  const pipelineName = process.env.LEADS_REPORT_PIPELINE_NAME ?? DEFAULT_PIPELINE_NAME;

  const { data: statusesData, error: statusesError } = await db
    .from('amo_statuses')
    .select('pipeline_id, status_id, status_name, sort')
    .eq('pipeline_name', pipelineName);
  if (statusesError) throw statusesError;

  const statuses = (statusesData ?? []) as Array<{
    pipeline_id: number;
    status_id: number;
    status_name: string;
    sort: number;
  }>;
  if (statuses.length === 0) {
    throw new Error(`No statuses for pipeline '${pipelineName}'`);
  }
  const pipelineId = statuses[0].pipeline_id;

  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const { data: leadsData, error: leadsError } = await db
    .from('amo_leads')
    .select('status_id, status_name, amount, created_at, updated_at, raw')
    .eq('pipeline_id', pipelineId)
    .or(
      `and(created_at.gte.${startIso},created_at.lt.${endIso}),` +
        `and(updated_at.gte.${startIso},updated_at.lt.${endIso})`,
    );
  if (leadsError) throw leadsError;

  return computeSalesReportBlockFromRows(
    (leadsData ?? []) as LeadRow[],
    statuses,
    start,
    end,
  );
}
