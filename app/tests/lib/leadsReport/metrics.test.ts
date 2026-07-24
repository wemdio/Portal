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
  fields: Record<string, string>,
  statusId: number,
  statusName: string,
): AmoLeadMetricRow {
  return {
    pipeline_id: 1,
    status_id: statusId,
    status_name: statusName,
    created_at: '2026-07-20T10:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
    raw: {
      custom_fields_values: Object.entries(fields).map(
        ([field_name, value]) => ({
          field_name,
          values: [{ value }],
        }),
      ),
    },
  };
}

describe('computeMetricsFromRows', () => {
  it('считает пять каналов и включает закрытые этапы в «Лидов»', () => {
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [
        // Маркетинг — только по явному маркеру «Контур»=«Маркетинг».
        lead({ Контур: 'Маркетинг' }, 20, 'Квалифицированный лид'),
        lead({ Источник: 'Сайт', utm_medium: 'smm' }, 30, 'Назначена встреча'),
        lead({ Источник: 'Аутрич' }, 40, 'Встреча проведена + КП отправлено'),
        lead({ Источник: 'Партнер' }, 142, 'Успешно'),
        lead({ Источник: 'Telegram Outreach' }, 143, 'Закрыто'),
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

  it('пропускает сделки без явного канала (нет Контур=Маркетинг и нет известного Источник)', () => {
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [
        // Ни Контур, ни известный источник — раньше падало в «Маркетинг», теперь пропускаем.
        lead({}, 20, 'Квалифицированный лид'),
        lead({ Источник: 'Сайт' }, 20, 'Квалифицированный лид'),
        lead({ Источник: 'Лидскан' }, 20, 'Квалифицированный лид'),
      ],
      new Date('2026-07-19T21:00:00.000Z'),
      new Date('2026-07-24T15:00:00.000Z'),
    );

    expect(
      result.every(
        (item) =>
          item.arrived === 0 &&
          item.qualifiedLeads === 0 &&
          item.meetingsHeld === 0 &&
          item.meetingsScheduled === 0,
      ),
    ).toBe(true);
  });
});
