import { SUMMARY_CHANNELS } from '@/lib/leadsReport/channels';
import {
  computeMetricsFromRows,
  type AmoLeadMetricRow,
  type AmoStatusMetricRow,
} from '@/lib/leadsReport/metrics';

const statuses: AmoStatusMetricRow[] = [
  { pipeline_id: 1, status_id: 10, status_name: 'Новый лид', sort: 10 },
  {
    pipeline_id: 1,
    status_id: 20,
    status_name: 'Квалифицированный лид',
    sort: 30,
  },
  {
    pipeline_id: 1,
    status_id: 30,
    status_name: 'Назначена встреча',
    sort: 40,
  },
  {
    pipeline_id: 1,
    status_id: 40,
    status_name: 'Встреча проведена + КП отправлено',
    sort: 60,
  },
  { pipeline_id: 1, status_id: 142, status_name: 'Успешно', sort: 10000 },
  { pipeline_id: 1, status_id: 143, status_name: 'Закрыто', sort: 11000 },
];

function lead(
  source: string,
  statusId: number,
  statusName: string,
  extraFields: Record<string, string> = {},
): AmoLeadMetricRow {
  return {
    pipeline_id: 1,
    status_id: statusId,
    status_name: statusName,
    created_at: '2026-07-20T10:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
    raw: {
      custom_fields_values: Object.entries({
        Источник: source,
        ...extraFields,
      }).map(([field_name, value]) => ({
        field_name,
        values: [{ value }],
      })),
    },
  };
}

describe('computeMetricsFromRows', () => {
  it('считает пять каналов и включает закрытые этапы в «Лидов»', () => {
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [
        lead('Сайт', 20, 'Квалифицированный лид'),
        lead('Сайт', 30, 'Назначена встреча', { utm_medium: 'smm' }),
        lead('Аутрич', 40, 'Встреча проведена + КП отправлено'),
        lead('Партнер', 142, 'Успешно'),
        lead('Telegram Outreach', 143, 'Закрыто'),
      ],
      new Date('2026-07-19T21:00:00.000Z'),
      new Date('2026-07-24T15:00:00.000Z'),
    );

    expect(result.map((item) => ({
      channel: item.channel.name,
      arrived: item.arrived,
      leads: item.qualifiedLeads,
      held: item.meetingsHeld,
      scheduled: item.meetingsScheduled,
    }))).toEqual([
      { channel: 'marketing', arrived: 1, leads: 1, held: 0, scheduled: 0 },
      { channel: 'smm', arrived: 1, leads: 1, held: 0, scheduled: 1 },
      { channel: 'outreach', arrived: 1, leads: 1, held: 1, scheduled: 0 },
      { channel: 'partners', arrived: 1, leads: 1, held: 0, scheduled: 0 },
      { channel: 'tg_outreach', arrived: 1, leads: 1, held: 0, scheduled: 0 },
    ]);
  });
});
